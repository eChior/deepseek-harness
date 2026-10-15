#!/usr/bin/env python3
"""读取 TSD（润文档）加密文档的内容。

设计原则：
  * **不驱动 GUI**。麒麟上通过本地 TSD 控制通道（LSDHelper 的 127.0.0.1 端口）
    就地解密文件，读完再用同一条通道加密回去；不打开 WPS、不模拟按键、不截图。
  * **零第三方解析依赖**。docx/xlsx/pptx 都是 ZIP 容器，直接解包读 XML；
    PDF 用 poppler 的 pdftotext。
  * **失败必还原**。原文件在解密的瞬间就变成明文，任何路径（含异常、超时、Ctrl-C）
    都必须把文件恢复成密文。恢复用备份还原，不依赖 TSD 能否再加密。

用法：
    tsd_reader.py <文件> [<文件> ...]        # 输出 JSON
    tsd_reader.py --check                   # 只做环境检查
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


class TsdError(RuntimeError):
    """任何无法继续的情况；消息直接面向使用者。"""


# --------------------------------------------------------------------------- #
# TSD 控制通道
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
# 文档读取（零第三方依赖）
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
        text = chunk.decode("utf-8", errors="replace")
        text = (
            text.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", '"')
            .replace("&apos;", "'")
        )
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


READERS = {
    "word": lambda path: read_zip_text(
        path, [r"word/document\.xml", r"word/header\d*\.xml", r"word/footer\d*\.xml"], r"w:t"
    ),
    "excel": lambda path: read_zip_text(
        path, [r"xl/sharedStrings\.xml", r"xl/worksheets/sheet\d+\.xml"], r"t"
    ),
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
# 主流程
# --------------------------------------------------------------------------- #

def environment_report() -> dict:
    report: dict = {"platform": sys.platform}
    if sys.platform != "linux":
        return report
    try:
        report["plugin"] = TsdChannel.library_path()
    except TsdError as error:
        report["plugin"] = str(error)
    report["service_running"] = TsdChannel.service_running()
    report["control_port"] = TsdChannel.control_port()
    report["uid"] = os.getuid()
    return report


def extract(path: str, open_channel: bool = True) -> dict:
    """读取一个文件；无论成功与否都把原文件恢复成密文。"""
    if not os.path.isfile(path):
        return {"path": path, "ok": False, "code": "missing", "detail": "文件不存在"}

    kind = kind_of(path)
    encrypted = is_encrypted(path)
    result: dict = {"path": os.path.abspath(path), "kind": kind, "encrypted": encrypted}

    if not encrypted:
        text = extract_text(path, kind)
        result["text"] = text
        result["characters"] = len(text)
        result["cjkCharacters"] = len(re.findall(r"[\u4e00-\u9fff]", text))
        result["ok"] = True
        return result

    if sys.platform != "linux":
        return {
            "path": path,
            "ok": False,
            "code": "unsupported-platform",
            "detail": "非 Linux 平台请用 WPS 打开文件后复制内容",
        }
    if not TsdChannel.service_running():
        return {"path": path, "ok": False, "code": "service", "detail": "LSDHelper 未运行"}

    # 备份还原比"再加密一次"更可靠：它不依赖 TSD 能否成功回写。
    backup = os.path.join(tempfile.gettempdir(), f"tsd-{os.getpid()}-{os.path.basename(path)}")
    shutil.copy2(path, backup)
    original_mode = os.stat(path).st_mode
    channel = TsdChannel() if open_channel else None
    watcher = threading.Thread(target=close_result_dialogs, daemon=True)
    if channel is not None:
        watcher.start()
    try:
        if channel is not None:
            channel.decrypt([path])
        if is_encrypted(path):
            return {
                "path": path,
                "ok": False,
                "code": "decrypt-failed",
                "detail": "解密后文件头仍是 TSD 密文",
            }
        text = extract_text(path, kind)
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
    except TsdError as error:
        return {"path": path, "ok": False, "code": "error", "detail": str(error)}
    finally:
        shutil.copy2(backup, path)
        os.chmod(path, original_mode)
        os.remove(backup)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="读取 TSD 加密文档的内容")
    parser.add_argument("paths", nargs="*", help="要读取的文件")
    parser.add_argument("--check", action="store_true", help="只输出环境检查结果")
    options = parser.parse_args(argv)

    if options.check:
        print(json.dumps(environment_report(), ensure_ascii=False, indent=2))
        return 0

    if not options.paths:
        parser.print_help()
        return 2

    payload = [extract(path) for path in options.paths]
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    # Qt teardown can hang once the plugin and its transport threads are live, so the
    # work is already done by now and the exit is immediate.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0 if all(item.get("ok") for item in payload) else 1)


if __name__ == "__main__":
    sys.exit(main())
