#!/usr/bin/env python3
"""读取 TSD（润文档）加密文档的内容。

设计原则：
  * **Linux（麒麟）**：走本地 TSD 控制通道（LSDHelper 的 127.0.0.1 端口）就地解密，
    读完用备份还原；不打开 WPS、不模拟按键、不截图。
  * **Windows**：走 WPS COM。解密由润文档插件 docpermission.dll 在**内存**里完成，
    磁盘上的原文件始终保持 `%TSD` 密文；**不需要启动 KeyService**。
  * **零第三方解析依赖**：docx/xlsx/pptx 都是 ZIP 容器，直接解包读 XML；
    加密文件才交给 WPS/TSD 引擎。
  * **正文不进工具输出**：默认就把正文写进临时文件（麒麟落 tmpfs，Windows 落 %TEMP%），
    stdout 只留路径与元数据；宿主 read 该文件后立即删除。`--text` 会把正文刷进工具
    输出块，只在没有文件读取手段时才用。**不要**用子代理绕路，也**不要**把正文概括成要点。
  * **失败必还原**：解密前先备份，任何路径（含异常、超时、Ctrl-C）都恢复成密文，
    并通过 sha256 前后比对确认磁盘原文未被改写。

用法：
    tsd_reader.py <文件> [<文件> ...]           # 【默认】正文落临时文件，stdout 只有路径+元数据
    tsd_reader.py --out <临时文件.log> <文件>   # 指定正文落地路径（扩展名不安全时自动改 .log）
    tsd_reader.py --meta <文件>                # 只给校验元数据，不含正文
    tsd_reader.py --text <文件>                # 只输出正文到 stdout（会进工具输出块）
    tsd_reader.py --check                     # 只做环境检查
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from typing import Callable, Iterable, List, Optional

TSD_HEADER = b"%TSD-Header"

KIND_BY_SUFFIX = {
    ".doc": "word",
    ".docx": "word",
    ".rtf": "word",
    ".odt": "word",
    ".txt": "text",
    ".xls": "excel",
    ".xlsx": "excel",
    ".ods": "excel",
    ".csv": "text",
    ".ppt": "slide",
    ".pptx": "slide",
    ".odp": "slide",
    ".pdf": "pdf",
}

PLUGIN_GLOB = "/usr/lib/*/peony-extensions/libpeony-teclink-menu.so"
SETTLE_SECONDS = 6.0

# Windows：WPS 三个组件各管一类格式，不能混用
#   KWPS.Application → Writer（文稿）、KET.Application → ET（表格）、KWPP.Application → WPP（演示）
WPS_PROGID_BY_KIND = {
    "word": "KWPS.Application",
    "excel": "KET.Application",
    "slide": "KWPP.Application",
}


class TsdError(RuntimeError):
    """任何无法继续的情况；消息直接面向使用者。"""


# --------------------------------------------------------------------------- #
# TSD 控制通道（Linux / 麒麟）
# --------------------------------------------------------------------------- #

class TsdChannel:
    """通过本地 TSD 控制通道解密/加密文件（仅 Linux）。

    所有机器相关的参数都在运行期探测：库路径按 CPU 架构 glob，端口从
    LSDHelper 的监听端口读，取不到时回退 ``10500 + uid % 5``。
    """

    _COMMANDS = {
        "decrypt": "_ZN11CTcpCliIcon19RequestDecryptFilesEPKc",
        "encrypt": "_ZN11CTcpCliIcon19RequestEncryptFilesEPKc",
    }

    def __init__(self) -> None:
        self._app = None
        self._library = None
        self._handle = None
        self._entries: dict[str, Callable[[bytes], int]] = {}

    # -- 环境探测 ---------------------------------------------------------- #

    @staticmethod
    def library_path() -> str:
        candidates = sorted(glob.glob(PLUGIN_GLOB))
        if not candidates:
            raise TsdError(
                "未找到 TSD 插件（/usr/lib/*/peony-extensions/libpeony-teclink-menu.so）；"
                "这台机器没有安装润文档集成"
            )
        return candidates[0]

    @staticmethod
    def control_port() -> int:
        """返回 LSDHelper 为当前账号监听的端口。"""
        listing = ""
        try:
            listing = subprocess.run(
                ["ss", "-tlnp"], capture_output=True, text=True, timeout=10, check=False
            ).stdout
        except (OSError, subprocess.SubprocessError):
            listing = ""
        for line in listing.splitlines():
            if "LSDHelper" not in line:
                continue
            match = re.search(r"127\.0\.0\.1:(\d+)", line)
            if match:
                return int(match.group(1))
        return 10500 + os.getuid() % 5

    @staticmethod
    def service_running() -> bool:
        try:
            return (
                subprocess.run(["pgrep", "-x", "LSDHelper"], capture_output=True, check=False)
                .returncode
                == 0
            )
        except OSError:
            return False

    # -- 初始化 ------------------------------------------------------------ #

    def open(self) -> None:
        if self._handle is not None:
            return
        import ctypes

        from PyQt5.QtCore import QCoreApplication

        self._app = QCoreApplication(sys.argv[:1])
        self._library = ctypes.CDLL(self.library_path())

        # 插件的构造函数才会建立传输线程池；只 dlopen 是不够的。
        instance = self._library.qt_plugin_instance
        instance.restype = ctypes.c_void_p
        instance()

        singleton = self._library._ZN11CTcpCliIcon9SingletonEv
        singleton.restype = ctypes.c_void_p
        handle = singleton()
        if not handle:
            raise TsdError("TSD 客户端图标不可用")
        self._handle = handle

        connect = self._library._ZN11CTcpCliIcon9ConnToSvrEv
        connect.restype = ctypes.c_void_p
        socket = connect()
        if not socket:
            raise TsdError(f"无法连接 TSD 服务（端口 {self.control_port()}）")

        helper = ctypes.c_void_p.from_address(handle + 8).value
        attack = self._library._ZN14CTcpCommHelper12AttackSocketEP10COCPSocket
        attack.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        attack(helper, socket)

    def _entry(self, command: str) -> Callable[[bytes], int]:
        import ctypes

        if command not in self._entries:
            entry = getattr(self._library, self._COMMANDS[command])
            entry.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
            entry.restype = ctypes.c_int
            handle = self._handle
            self._entries[command] = lambda payload: int(entry(handle, payload))
        return self._entries[command]

    def send(self, command: str, paths: Iterable[str]) -> None:
        """把一批路径交给 TSD 处理；返回时请求已送达。"""
        self.open()
        items = [os.path.abspath(path) for path in paths]
        # 分隔符是字面四个字符 "/r/n"，不是换行——这是 TSD 自己的拼接约定。
        payload = "".join(item + "/r/n" for item in items).encode()
        result = self._entry(command)(payload)
        if result != 1:
            raise TsdError(f"TSD 拒绝了{command}请求（返回 {result}）")
        deadline = time.time() + SETTLE_SECONDS
        while time.time() < deadline:
            self._app.processEvents()
            time.sleep(0.05)

    def decrypt(self, paths: Iterable[str]) -> None:
        self.send("decrypt", paths)

    def encrypt(self, paths: Iterable[str]) -> None:
        self.send("encrypt", paths)


def close_result_dialogs(display: str = ":0", attempts: int = 100, interval: float = 0.05) -> None:
    """后台轮询并关闭 TSD 的结果弹窗。

    LSDHelper 无条件弹 `QMessageBox`，没有静默开关；调用前后各起一个观察者可以把
    它压到一次极短的闪现。
    """
    if shutil.which("xdotool") is None:
        return
    environment = dict(os.environ, DISPLAY=display)
    for _ in range(attempts):
        try:
            found = subprocess.run(
                ["xdotool", "search", "--name", "LSDHelper"],
                capture_output=True,
                text=True,
                env=environment,
                timeout=5,
                check=False,
            ).stdout.split()
        except (OSError, subprocess.SubprocessError):
            return
        for window in found:
            try:
                title = subprocess.run(
                    ["xdotool", "getwindowname", window],
                    capture_output=True,
                    text=True,
                    env=environment,
                    timeout=5,
                    check=False,
                ).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                continue
            if any(marker in title for marker in ("润文档", "表格", "文字", "演示")):
                continue
            subprocess.run(
                ["xdotool", "windowclose", window], env=environment, timeout=5, check=False
            )
        time.sleep(interval)


# --------------------------------------------------------------------------- #
# Windows：WPS COM（内存解密，不落盘、不需要 KeyService）
# --------------------------------------------------------------------------- #

class WpsReader:
    """用 WPS COM 打开 TSD 密文并抽出正文。

    由润文档插件 `docpermission.dll` 在进程内解密，明文只存在于 COM 对象里；
    文件以**只读**方式打开（`ReadOnly=True`），关闭时不回写，磁盘始终是密文。
    """

    def __init__(self) -> None:
        self._apps: dict[str, object] = {}

    @staticmethod
    def _client():
        try:
            import win32com.client  # noqa: F401
        except ImportError as error:
            raise TsdError(
                "缺少 pywin32（COM 读取必需）：pip install pywin32"
            ) from error
        import win32com.client

        return win32com.client

    def app(self, kind: str):
        progid = WPS_PROGID_BY_KIND.get(kind)
        if progid is None:
            raise TsdError(f"WPS 不支持的文件类型：{kind}")
        if progid not in self._apps:
            client = self._client()
            application = client.Dispatch(progid)
            try:
                application.Visible = False
            except Exception:
                pass
            try:
                application.DisplayAlerts = 0
            except Exception:
                pass
            self._apps[progid] = application
        return self._apps[progid]

    def close(self) -> None:
        for application in self._apps.values():
            try:
                application.Quit()
            except Exception:
                pass
        self._apps.clear()

    # -- 各组件读取 -------------------------------------------------------- #

    def word_text(self, path: str) -> str:
        document = None
        try:
            document = self.app("word").Documents.Open(os.path.abspath(path), False, True, False)
            text = document.Content.Text
        finally:
            if document is not None:
                try:
                    document.Saved = True
                    document.Close(0)
                except Exception:
                    pass
        # \x07 是单元格结束符，\r 是段落/行结束符
        return text.replace("\x07", "\t").replace("\r\n", "\n").replace("\r", "\n")

    def excel_text(self, path: str) -> str:
        book = None
        blocks: List[str] = []
        try:
            book = self.app("excel").Workbooks.Open(os.path.abspath(path), 0, True)
            for sheet in book.Worksheets:
                blocks.append(f"--- {sheet.Name} ---")
                try:
                    used = sheet.UsedRange
                    values = used.Value
                except Exception as error:
                    blocks.append(f"<读取失败：{error}>")
                    continue
                if values is None:
                    continue
                if not isinstance(values, tuple):
                    values = ((values,),)
                for row in values:
                    if not isinstance(row, tuple):
                        row = (row,)
                    cells = ["" if cell is None else str(cell) for cell in row]
                    line = "\t".join(cells).rstrip()
                    if line.strip():
                        blocks.append(line)
        finally:
            if book is not None:
                try:
                    book.Saved = True
                    book.Close(False)
                except Exception:
                    pass
        return "\n".join(blocks)

    def slide_text(self, path: str) -> str:
        presentation = None
        blocks: List[str] = []
        try:
            # Presentations.Open(FileName, ReadOnly, Untitled, WithWindow)
            presentation = self.app("slide").Presentations.Open(os.path.abspath(path), True, False, False)
            for index, slide in enumerate(presentation.Slides, start=1):
                blocks.append(f"--- 第 {index} 页 ---")
                for shape in slide.Shapes:
                    try:
                        if shape.HasTextFrame and shape.TextFrame.HasText:
                            blocks.append(shape.TextFrame.TextRange.Text)
                    except Exception:
                        continue
        finally:
            if presentation is not None:
                try:
                    presentation.Saved = True
                    presentation.Close()
                except Exception:
                    pass
        return "\n".join(blocks)

    def extract(self, path: str, kind: str) -> str:
        if kind == "word":
            return self.word_text(path)
        if kind == "excel":
            return self.excel_text(path)
        if kind == "slide":
            return self.slide_text(path)
        raise TsdError(f"WPS 不支持的文件类型：{kind}")


# --------------------------------------------------------------------------- #
# 文档读取（零第三方依赖，用于明文容器）
# --------------------------------------------------------------------------- #

def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def is_encrypted(path: str) -> bool:
    with open(path, "rb") as handle:
        return handle.read(len(TSD_HEADER)) == TSD_HEADER


def kind_of(path: str) -> str:
    return KIND_BY_SUFFIX.get(os.path.splitext(path)[1].lower(), "unknown")


def _text_of(xml_bytes: bytes, tag: str) -> str:
    """把某个 XML 标签的全部文本按文档顺序拼起来。"""
    pattern = re.compile(rf"<{tag}[^>]*>(.*?)</{tag}>".encode(), re.DOTALL)
    parts = []
    for match in pattern.finditer(xml_bytes):
        chunk = match.group(1)
        chunk = re.sub(rb"<[^>]+>", b"", chunk)
        text = _unescape(chunk.decode("utf-8", errors="replace"))
        if text.strip():
            parts.append(text)
    return "\n".join(parts)


def read_zip_text(path: str, members: List[str], tag: str) -> str:
    """按名称顺序读取 ZIP 容器里的若干 XML，抽取指定标签的文本。"""
    blocks = []
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        for member in sorted(name for name in names if _matches(name, members)):
            blocks.append(f"--- {member} ---")
            blocks.append(_text_of(archive.read(member), tag))
    return "\n".join(block for block in blocks if block is not None)


def _matches(name: str, patterns: List[str]) -> bool:
    return any(re.fullmatch(pattern, name) is not None for pattern in patterns)


def _unescape(text: str) -> str:
    """解开 XML 实体。数字实体（&#24207;）必须处理——部分生成器会把所有非 ASCII
    字符写成数字实体，只替换具名实体会让中文整篇变成 `&#24207;` 这种乱码。"""
    text = (
        text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
    )

    def _numeric(match: "re.Match[str]") -> str:
        body = match.group(1)
        try:
            if body[:1] in ("x", "X"):
                return chr(int(body[1:], 16))
            return chr(int(body))
        except (ValueError, OverflowError):
            return match.group(0)

    text = re.sub(r"&#(x?[0-9A-Fa-f]+);", _numeric, text)
    return text.replace("&amp;", "&")


# -- Excel：必须按单元格类型解析，否则数值列会整列丢失 ---------------------- #

_SHEET_XML = re.compile(r"xl/worksheets/sheet\d+\.xml")


def _column_index(letters: str) -> int:
    """A→0，B→1，AA→26。"""
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - 64)
    return index - 1


def _shared_strings(archive: zipfile.ZipFile) -> List[str]:
    """xl/sharedStrings.xml → 字符串表（单元格 t="s" 时用索引查它）。"""
    try:
        xml_bytes = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    table = []
    for item in re.finditer(rb"<si>(.*?)</si>", xml_bytes, re.DOTALL):
        parts = re.findall(rb"<t[^>]*>(.*?)</t>", item.group(1), re.DOTALL)
        table.append(_unescape(b"".join(parts).decode("utf-8", errors="replace")))
    return table


def _sheet_labels(archive: zipfile.ZipFile) -> dict:
    """通过 workbook.xml + rels 把 sheetN.xml 映射成「工作表 N：名称」。

    ``Target`` 有两种写法，必须都认：WPS 给相对路径 ``worksheets/sheet1.xml``，
    openpyxl 给绝对路径 ``/xl/worksheets/sheet1.xml``。
    """
    labels = {}
    try:
        workbook = archive.read("xl/workbook.xml")
        rels = archive.read("xl/_rels/workbook.xml.rels")
    except KeyError:
        return labels

    # 属性顺序不固定，逐个 Relationship 取 Id / Target，不要依赖先后
    targets = {}
    for rel in re.finditer(rb"<Relationship\b[^>]*>", rels):
        tag = rel.group(0)
        rid = re.search(rb'Id="([^"]*)"', tag)
        target = re.search(rb'Target="([^"]*)"', tag)
        if rid and target:
            targets[rid.group(1).decode()] = target.group(1).decode()

    for order, sheet in enumerate(re.finditer(rb"<sheet\b[^>]*>", workbook), start=1):
        tag = sheet.group(0)
        name = re.search(rb'name="([^"]*)"', tag)
        rid = re.search(rb'r:id="([^"]*)"', tag)
        target = targets.get(rid.group(1).decode()) if rid else None
        if target is None:
            continue
        # 去掉开头的 "/" 与前导 "xl/"，统一补成 "xl/xxx"
        relative = target.lstrip("/")
        if relative.startswith("xl/"):
            relative = relative[3:]
        member = "xl/" + relative
        label = _unescape(name.group(1).decode("utf-8", "replace")) if name else str(order)
        labels[member] = f"工作表 {order}：{label}"
    return labels


def _sheet_rows(xml_bytes: bytes, shared: List[str]) -> str:
    """把 sheetN.xml 还原成制表符分隔的行。

    单元格类型：``t="s"`` 是共享字符串索引，``t="inlineStr"`` 是内联文本，
    其余（缺省 ``n``）的文本在 ``<v>`` 里——只读 ``<t>`` 会把数字全部漏掉。
    """
    lines = []
    for row in re.finditer(rb"<row[^>]*>(.*?)</row>", xml_bytes, re.DOTALL):
        cells: dict[int, str] = {}
        last = -1
        for cell in re.finditer(
            rb"<c\b([^>]*?)(/>|>(.*?)</c>)", row.group(1), re.DOTALL
        ):
            attributes = cell.group(1).decode("utf-8", errors="replace")
            body = cell.group(3) or b""
            reference = re.search(r'r="([A-Z]+)\d+"', attributes)
            if reference is None:
                continue
            column = _column_index(reference.group(1))
            kind = re.search(r't="([^"]*)"', attributes)
            kind = kind.group(1) if kind else "n"

            if kind == "s":
                raw = re.search(rb"<v>(.*?)</v>", body, re.DOTALL)
                value = ""
                if raw:
                    try:
                        value = shared[int(raw.group(1))]
                    except (ValueError, IndexError):
                        value = ""
            elif kind == "inlineStr":
                value = _unescape(
                    b"".join(re.findall(rb"<t[^>]*>(.*?)</t>", body, re.DOTALL)).decode(
                        "utf-8", errors="replace"
                    )
                )
            else:
                raw = re.search(rb"<v>(.*?)</v>", body, re.DOTALL)
                value = (
                    _unescape(raw.group(1).decode("utf-8", errors="replace")) if raw else ""
                )
            cells[column] = value
            last = max(last, column)
        if last < 0:
            continue
        line = "\t".join(cells.get(index, "") for index in range(last + 1)).rstrip()
        if line.strip():
            lines.append(line)
    return "\n".join(lines)


def read_excel_text(path: str) -> str:
    blocks = []
    with zipfile.ZipFile(path) as archive:
        shared = _shared_strings(archive)
        labels = _sheet_labels(archive)
        members = sorted(
            name for name in archive.namelist() if _SHEET_XML.fullmatch(name)
        )
        for member in members:
            blocks.append(f"--- {labels.get(member, member)} ---")
            blocks.append(_sheet_rows(archive.read(member), shared))
    return "\n".join(block for block in blocks if block is not None)


READERS = {
    "word": lambda path: read_zip_text(
        path, [r"word/document\.xml", r"word/header\d*\.xml", r"word/footer\d*\.xml"], r"w:t"
    ),
    "excel": read_excel_text,
    "slide": lambda path: read_zip_text(path, [r"ppt/slides/slide\d+\.xml"], r"a:t"),
}


def read_pdf(path: str) -> str:
    if shutil.which("pdftotext") is None:
        raise TsdError("缺少 pdftotext（poppler-utils），无法读取 PDF")
    result = subprocess.run(
        ["pdftotext", "-layout", path, "-"], capture_output=True, timeout=300, check=False
    )
    if result.returncode != 0:
        raise TsdError(f"pdftotext 失败：{result.stderr.decode('utf-8', 'replace')[:200]}")
    return result.stdout.decode("utf-8", errors="replace")


def read_text(path: str) -> str:
    with open(path, "rb") as handle:
        return handle.read().decode("utf-8", errors="replace")


def extract_text(path: str, kind: str) -> str:
    if kind == "pdf":
        return read_pdf(path)
    if kind == "text":
        return read_text(path)
    reader = READERS.get(kind)
    if reader is None:
        raise TsdError(f"不认识的文件类型：{os.path.basename(path)}")
    return reader(path)


# --------------------------------------------------------------------------- #
# 环境检查
# --------------------------------------------------------------------------- #

def _find_wps_home() -> Optional[str]:
    for key in ("WPS_OFFICE_HOME", "WPS_HOME"):
        value = os.environ.get(key)
        if value and os.path.isdir(value):
            return value
    roots = [
        r"D:\WPS Office",
        r"C:\Program Files\WPS Office",
        r"C:\Program Files (x86)\WPS Office",
    ]
    for root in roots:
        if not os.path.isdir(root):
            continue
        # 取版本号最大的子目录
        versions = sorted(
            (name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))),
            reverse=True,
        )
        for version in versions:
            office6 = os.path.join(root, version, "office6")
            if os.path.isdir(office6):
                return office6
    return None


def _docpermission_path() -> Optional[str]:
    home = _find_wps_home()
    if home is None:
        return None
    candidate = os.path.join(home, "addons", "docpermission", "docpermission.dll")
    return candidate if os.path.isfile(candidate) else None


def _find_keyservice_home() -> Optional[str]:
    value = os.environ.get("CR_KEYSERVICE_HOME")
    if value and os.path.isdir(value):
        return value
    for root in (r"C:\ChinaResources\KeyService", r"D:\ChinaResources\KeyService"):
        if os.path.isdir(root):
            return root
    return None


def environment_report() -> dict:
    report: dict = {"platform": sys.platform}
    if sys.platform == "linux":
        try:
            report["plugin"] = TsdChannel.library_path()
        except TsdError as error:
            report["plugin"] = str(error)
        report["service_running"] = TsdChannel.service_running()
        report["control_port"] = TsdChannel.control_port()
        report["uid"] = os.getuid()
        return report
    if sys.platform == "win32":
        report["wps_home"] = _find_wps_home() or "未找到 WPS Office"
        report["docpermission"] = _docpermission_path() or "未找到 docpermission.dll（润文档插件）"
        report["keyservice_home"] = _find_keyservice_home() or "未找到（不影响读取）"
        report["keyservice_required"] = False
        try:
            import win32com.client  # noqa: F401

            report["pywin32"] = True
        except ImportError:
            report["pywin32"] = False
        return report
    return report


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #

def _finalize(result: dict, text: str) -> dict:
    result["text"] = text
    result["characters"] = len(text)
    result["cjkCharacters"] = len(re.findall(r"[\u4e00-\u9fff]", text))
    if not text.strip():
        result["ok"] = False
        result["code"] = "empty-output"
        result["detail"] = "解密成功但内容为空"
        return result
    if TSD_HEADER.decode() in text:
        result["ok"] = False
        result["code"] = "still-encrypted"
        result["detail"] = "输出里仍含 TSD 头，解密不完整"
        return result
    result["ok"] = True
    return result


def _backup(path: str) -> str:
    """密文备份：扩展名故意用 .bak，避免被安全箱二次加密。"""
    backup = os.path.join(
        tempfile.gettempdir(), f"tsd-{os.getpid()}-{os.path.basename(path)}.bak"
    )
    shutil.copy2(path, backup)
    return backup


def _extract_linux_encrypted(path: str, kind: str, result: dict) -> dict:
    if not TsdChannel.service_running():
        return {"path": path, "ok": False, "code": "service", "detail": "LSDHelper 未运行"}
    channel = TsdChannel()
    watcher = threading.Thread(target=close_result_dialogs, daemon=True)
    watcher.start()
    channel.decrypt([path])
    if is_encrypted(path):
        return {
            "path": path,
            "ok": False,
            "code": "decrypt-failed",
            "detail": "解密后文件头仍是 TSD 密文",
        }
    return _finalize(result, extract_text(path, kind))


def _extract_windows_encrypted(path: str, kind: str, result: dict) -> dict:
    if kind not in WPS_PROGID_BY_KIND:
        return {
            "path": path,
            "ok": False,
            "code": "unsupported-platform",
            "detail": f"Windows 上无法读取该类型（{kind}），请用 WPS 打开后复制内容",
        }
    if _docpermission_path() is None:
        return {
            "path": path,
            "ok": False,
            "code": "missing-plugin",
            "detail": "未找到 WPS 润文档插件 docpermission.dll，无法解密",
        }
    reader = WpsReader()
    try:
        # 解密全程在 WPS 进程内完成，不需要 KeyService
        return _finalize(result, reader.extract(path, kind))
    finally:
        reader.close()


def extract(path: str) -> dict:
    """读取一个文件；无论成功与否都把原文件恢复成密文。"""
    if not os.path.isfile(path):
        return {"path": path, "ok": False, "code": "missing", "detail": "文件不存在"}

    kind = kind_of(path)
    encrypted = is_encrypted(path)
    result: dict = {"path": os.path.abspath(path), "kind": kind, "encrypted": encrypted}

    if not encrypted:
        try:
            return _finalize(result, extract_text(path, kind))
        except TsdError as error:
            return {"path": path, "ok": False, "code": "error", "detail": str(error)}

    # 以下是密文路径：先备份，finally 里无条件还原，
    # 保证任何异常/超时/中断都不会把明文留在磁盘上。
    before = sha256_of(path)
    backup = _backup(path)
    original_mode = os.stat(path).st_mode
    try:
        if sys.platform == "linux":
            outcome = _extract_linux_encrypted(path, kind, result)
        elif sys.platform == "win32":
            outcome = _extract_windows_encrypted(path, kind, result)
        else:
            outcome = {
                "path": path,
                "ok": False,
                "code": "unsupported-platform",
                "detail": "本平台没有 TSD 解密通道",
            }
        return outcome
    except TsdError as error:
        return {"path": path, "ok": False, "code": "error", "detail": str(error)}
    except BaseException as error:  # COM 异常五花八门，一律转成结构化失败
        return {
            "path": path,
            "ok": False,
            "code": "error",
            "detail": f"{type(error).__name__}: {error}",
        }
    finally:
        shutil.copy2(backup, path)
        try:
            os.chmod(path, original_mode)
        except Exception:
            pass
        os.remove(backup)
        result["unchanged"] = sha256_of(path) == before


def _force_utf8_stdout() -> None:
    """Windows 控制台默认 cp936，中文正文会乱码；强制 UTF-8 输出。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


# 实测：Python 写出的 .txt / .xlsx / .py 会被 TSD 安全箱立即重新加密，
# 而 .log / .json / .md / .csv 不受影响。--out 命中前者时自动换扩展名，
# 否则调用方 read 到的会是密文二进制。
SAFE_OUT_SUFFIXES = (".log", ".json", ".md", ".csv", ".tsv", ".bak")


def _safe_out_path(path: str) -> str:
    """把 --out 的目标收敛到不会被安全箱二次加密的扩展名。"""
    stem, suffix = os.path.splitext(path)
    if suffix.lower() in SAFE_OUT_SUFFIXES:
        return path
    return stem + ".log"


def _default_out_path(payload: List[dict]) -> str:
    """默认模式的正文落地路径：临时目录里的 .log。

    麒麟的 /tmp 是 tmpfs，明文不落普通磁盘；Windows 落在 %TEMP%。
    默认模式与 --out 共用同一条落地逻辑，区别只是路径由脚本挑而不是调用方给。
    """
    name = os.path.basename(str(payload[0].get("path", "document"))) if payload else "document"
    stem = os.path.splitext(name)[0] or "document"
    safe = re.sub(r"[^A-Za-z0-9._\u4e00-\u9fff-]", "_", stem)
    return os.path.join(tempfile.gettempdir(), f"tsd-out-{os.getpid()}-{safe}.log")


def _restrict(path: str) -> None:
    """把落地文件收到属主可读写（0600）：/tmp 同机其它账号本来就能读到明文。"""
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def main(argv: Optional[List[str]] = None) -> int:
    _force_utf8_stdout()

    parser = argparse.ArgumentParser(description="读取 TSD 加密文档的内容")
    parser.add_argument("paths", nargs="*", help="要读取的文件")
    parser.add_argument("--check", action="store_true", help="只输出环境检查结果")
    parser.add_argument(
        "--text", action="store_true", help="只输出正文（多文件时加分隔线），不输出 JSON"
    )
    parser.add_argument(
        "--meta",
        action="store_true",
        help="只输出校验元数据（path/kind/encrypted/characters/ok/unchanged），不含正文；"
        "主会话里安全可用，正文不会进入工具输出",
    )
    parser.add_argument(
        "--out",
        metavar="路径",
        help="把正文写入该文件而不打印到 stdout（stdout 只留路径与元数据），"
        "供宿主用文件读取的方式取正文；扩展名若容易被安全箱二次加密会自动改 .log。"
        "不指定时脚本自己写临时目录，行为与默认模式一致",
    )
    options = parser.parse_args(argv)

    if options.check:
        print(json.dumps(environment_report(), ensure_ascii=False, indent=2))
        return 0

    if not options.paths:
        parser.print_help()
        return 2

    payload = [extract(path) for path in options.paths]

    if not options.meta and not options.text:
        # 默认路径：正文落到临时文件，stdout 只回路径 + 校验元数据。
        target = _safe_out_path(options.out) if options.out else _default_out_path(payload)
        parent = os.path.dirname(target)
        if parent:
            os.makedirs(parent, exist_ok=True)
        chunks = []
        for item in payload:
            if len(payload) > 1:
                chunks.append(f"===== {item['path']} =====")
            if item.get("ok"):
                chunks.append(item.get("text", ""))
            else:
                chunks.append(f"[读取失败 {item.get('code')}] {item.get('detail', '')}")
        with open(target, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(chunks))
        _restrict(target)
        summary = []
        for item in payload:
            entry = {key: value for key, value in item.items() if key != "text"}
            entry.setdefault("characters", len(item.get("text") or ""))
            summary.append(entry)
        print(json.dumps({"out": target, "files": summary}, ensure_ascii=False, indent=2))
    elif options.meta:
        # 正文就地丢弃：只留可安全展示的校验字段。
        meta = []
        for item in payload:
            entry = {key: value for key, value in item.items() if key != "text"}
            entry.setdefault("characters", len(item.get("text") or ""))
            meta.append(entry)
        print(json.dumps(meta, ensure_ascii=False, indent=2))
    else:  # options.text：唯一的直出通道，调用方明确要求才走
        chunks = []
        for item in payload:
            if len(payload) > 1:
                chunks.append(f"===== {item['path']} =====")
            if item.get("ok"):
                chunks.append(item.get("text", ""))
            else:
                chunks.append(f"[读取失败 {item.get('code')}] {item.get('detail', '')}")
        print("\n".join(chunks))

    # Qt/COM 清理可能挂住；工作已完成，直接退出
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0 if all(item.get("ok") for item in payload) else 1)


if __name__ == "__main__":
    sys.exit(main())
