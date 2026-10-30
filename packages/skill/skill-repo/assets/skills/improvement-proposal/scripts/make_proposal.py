#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""提案改善：一份 JSON → 填好的《改善提案报告》Excel（默认只出这一个文件）。

    python make_proposal.py 提案.json --out ./提案改善
    python make_proposal.py --new 我的提案.json      # 生成填报模板
    python make_proposal.py --fields                 # 看字段清单与每格字数上限
    python make_proposal.py --make-blank 新表单.xlsx --out assets   # 表单换版时反推空白模板

Excel 走 ZIP 层手术而不是 openpyxl：表单里"改善前/改善实施"照片是 WPS 的嵌入单元格图片
（DISPIMG + cellimages.xml + richData + metadata），openpyxl 不认识这些部件，另存后照片位会损坏。
所以只替换 sheet1.xml 里目标单元格的内容和 xl/media/ 下的照片字节，其余部件原样复制。

字段 → 单元格（写入位置均为合并区左上角）：
    B4 提案名称  H4 提案编号  B5 提案人  E5 实施人  H5 完成日期  B6 提案类型  B7 业务类型
    F8 存在问题  F9 主要原因  F10 改善对策  F11 控制措施  B12 成果标准化  C13 无形效益
    F14 经济效益(数值,元)  C15 计算方式     B8/B10 = 改善前/改善实施照片位（只换字节）
"""

from __future__ import annotations

__version__ = "0.1.1"

import argparse
import csv
import datetime as _dt
import io
import json
import math
import os
import re
import sys
import zipfile
from xml.sax.saxutils import escape

# --------------------------------------------------------------------------- #
# 常量与模板
# --------------------------------------------------------------------------- #

SHEET = "xl/worksheets/sheet1.xml"
CELLIMAGES = "xl/cellimages.xml"
MEDIA_BEFORE = "xl/media/image2.png"   # B8  改善前照片
MEDIA_AFTER = "xl/media/image3.png"    # B10 改善实施照片

# 照片位：媒体部件 → 承载它的合并区左上角单元格
PHOTO_CELLS = {MEDIA_BEFORE: "B8", MEDIA_AFTER: "B10"}

EMU_PER_PX = 9525          # 1 px = 1/96 英寸 = 9525 EMU
PX_PER_PT = 96.0 / 72.0    # 行高磅 → 像素
PHOTO_UPSCALE = 4          # 照片按单元格尺寸的 4 倍像素生成（约 384 dpi），够印够看

FIELD_MAP = {
    "提案名称": ("B4", "text"), "提案编号": ("H4", "text"), "提案人": ("B5", "text"),
    "实施人": ("E5", "text"), "完成日期": ("H5", "date"), "提案类型": ("B6", "text"),
    "业务类型": ("B7", "text"), "存在问题": ("F8", "text"), "主要原因": ("F9", "text"),
    "改善对策": ("F10", "text"), "控制措施": ("F11", "text"), "成果标准化": ("B12", "text"),
    "无形效益": ("C13", "text"), "经济效益": ("F14", "number"), "计算方式": ("C15", "text"),
}

FORM_FIELDS = list(FIELD_MAP)

# 评审会看、不该留空
SHOULD_FILL = ["提案名称", "提案人", "完成日期", "存在问题", "主要原因", "改善对策", "无形效益"]

# 表单每格建议字数上限（按模板行高列宽算出的一屏可见量，见 SKILL.md）
CAPACITY = {"提案名称": 20, "提案人": 9, "实施人": 9, "存在问题": 67, "主要原因": 83,
            "改善对策": 83, "控制措施": 117, "成果标准化": 100, "无形效益": 88, "计算方式": 88}

CLOUD_DOC = ("https://app.rwork.crc.com.cn/base/bask9wcePBHUds0Vzb3a1L4d9Tb"
             "?table=tblq9Acb2Kn1Gsk6&view=vewwMSjlOu")

LINE_HEIGHT_PT = 15.0   # 11 号字一行约 15 磅
CHAR_MARGIN = 0.92      # 留余量，避免刚好卡满

LEDGER_COLUMNS = ["提案编号", "提案名称", "提案人", "实施人", "部门", "班组", "岗位", "完成日期",
                  "提案类型", "业务类型", "改善类别", "存在问题", "主要原因", "改善对策", "控制措施",
                  "成果标准化", "无形效益", "量化效益", "经济效益元", "计算方式", "提交状态"]

NEW_TEMPLATE = {
    "_说明": "提案改善填报模板。带 ★ 的要填准，其余按实际情况填；填完跑 make_proposal.py 生成材料。",
    "提案名称": "★ 改了什么 + 对象 + 效果，22 字以内。例：称量工具分层定置，找取 40s→5s",
    "提案人": "★ 姓名",
    "实施人": "实际动手做的人，可与提案人相同",
    "完成日期": "★ 2026-09-14（必须 年-月-日）",
    "提案类型": "按云文档表单给出的选项填（本表本身属于改善提案）",
    "业务类型": "例：生产·工艺 / 质量 / 设备 / 安全环保 / 成本·物料 / 效率 / 信息化 / 管理",
    "存在问题": "★ 改善前现状 + 造成什么损失，≤67 字。要有事实和数字，不要写成抱怨",
    "主要原因": "★ 为什么会这样，≤83 字。追到可改的那一层，不要写“员工不认真”",
    "改善对策": "★ 具体做了什么（方案 + 关键动作），≤83 字。不要只写结果，要写怎么做的",
    "控制措施": "选填但建议填，≤117 字。怎么防止反弹：纳入标准/点检/复核，谁多久查一次",
    "成果标准化": "选填但建议填，≤100 字。形成了什么标准/文件/工具，务必给出文件名称与编号",
    "无形效益": "★ ≤88 字。用“从 X 变成 Y”的事实写，例：错拿规格 2 次/月→0 次。不要硬折成金额",
    "经济效益": 0,
    "计算方式": "★ ≤88 字。公式 + 取值 + 年化依据，财务要能照着复核。写不下的演算放附件并注明",
    "照片": {"改善前": "", "改善实施": ""},
    "台账补充": {"部门": "", "班组": "", "岗位": "",
                 "改善类别": "效率·工时 / 质量·防错 / 成本·物料 / 安全·环保 / 设备·工装 / 现场·5S / 管理·流程 / 服务·信息化",
                 "提交状态": "已提交"},
}


def dig(data, path, default=""):
    cur = data
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return default if cur is None else cur


def is_blank(v) -> bool:
    if v is None:
        return True
    if isinstance(v, str):
        return v.strip() == ""
    if isinstance(v, (list, tuple, dict)):
        return len(v) == 0
    return False


def safe_name(name: str) -> str:
    return (re.sub(r'[\\/:*?"<>|\r\n\t]', "-", str(name)).strip() or "未命名提案")[:60]


def default_template():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "assets", "改善提案报告-空白模板.xlsx")


# --------------------------------------------------------------------------- #
# 一、度量：用 openpyxl 只读分析模板版式，算每格字数容量
# --------------------------------------------------------------------------- #

def load_metrics(template_path):
    import openpyxl
    wb = openpyxl.load_workbook(template_path)
    ws = wb.worksheets[0]

    default_w = 9.13
    col_w = {c: (ws.column_dimensions[c].width if c in ws.column_dimensions
                 and ws.column_dimensions[c].width else default_w) for c in "ABCDEFGHI"}
    merge_of = {str(r.coord).split(":")[0].upper(): r for r in ws.merged_cells.ranges}
    row_h = {r: (ws.row_dimensions[r].height if r in ws.row_dimensions
                 and ws.row_dimensions[r].height else 22.5) for r in range(1, ws.max_row + 1)}

    import openpyxl.utils as _u
    capacity, height_of = {}, {}
    for field, (ref, _k) in FIELD_MAP.items():
        rng = merge_of.get(ref)
        if rng:
            c1, c2, r1, r2 = rng.min_col, rng.max_col, rng.min_row, rng.max_row
        else:
            c1 = c2 = _u.column_index_from_string(ref[0])
            r1 = r2 = int(ref[1:])
        total_w = sum(col_w.get(chr(64 + c), default_w) for c in range(c1, c2 + 1))
        per_line = max(4.0, total_w / 2.0)          # 一个中文字 ≈ 2 个列宽单位
        h = sum(row_h.get(r, 22.5) for r in range(r1, r2 + 1))
        lines = max(1, int(h / LINE_HEIGHT_PT))
        capacity[field] = int(per_line * lines * CHAR_MARGIN)
        height_of[field] = (r1, r2, h, per_line)
    return capacity, height_of


# --------------------------------------------------------------------------- #
# 二、照片
# --------------------------------------------------------------------------- #

def _load_font(size):
    from PIL import ImageFont
    for p in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf",
              r"C:\Windows\Fonts\simsun.ttc"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return None


def _png(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def placeholder_image(size, label):
    """占位图：提醒必须换成真实照片，避免把模板自带的示例照片交上去。"""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", size, (242, 242, 242))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, size[0] - 1, size[1] - 1], outline=(190, 190, 190), width=2)
    cx, cy = size[0] // 2, size[1] // 2
    bw, bh = min(120, size[0] // 4), min(80, size[1] // 2)
    d.rectangle([cx - bw, cy - bh, cx + bw, cy + bh], outline=(160, 160, 160), width=3)
    d.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], outline=(160, 160, 160), width=3)
    font = _load_font(max(12, min(28, size[1] // 6)))
    if font is not None:
        try:
            d.text((cx - d.textlength(label, font=font) / 2, cy + bh + 8),
                   label, fill=(150, 150, 150), font=font)
        except Exception:
            pass
    return img


def fit_photo(src_path, target_size, mode="cover"):
    """cover = 等比缩放后居中裁切填满（默认）；contain = 居中留边不裁。"""
    from PIL import Image
    tw, th = target_size
    src = Image.open(src_path)
    if src.mode in ("CMYK", "P"):
        src = src.convert("RGB")
    elif src.mode == "RGBA":
        bg = Image.new("RGB", src.size, (255, 255, 255))
        bg.paste(src, mask=src.split()[-1])
        src = bg
    sw, sh = src.size
    scale = max(tw / sw, th / sh) if mode == "cover" else min(tw / sw, th / sh)
    new = src.resize((max(1, round(sw * scale)), max(1, round(sh * scale))), Image.LANCZOS)
    if mode == "cover":
        left, top = (new.width - tw) // 2, (new.height - th) // 2
        new = new.crop((left, top, left + tw, top + th))
    else:
        canvas = Image.new("RGB", (tw, th), (255, 255, 255))
        canvas.paste(new, ((tw - new.width) // 2, (th - new.height) // 2))
        new = canvas
    return _png(new)


def media_sizes(template_path):
    """模板里两个照片部件的**文件像素**尺寸——原表单这张图往往是扁的，
    按它裁照片会把实拍照片裁掉大半（旧行为，用 --photo-target media 可回退）。"""
    from PIL import Image
    sizes = {}
    with zipfile.ZipFile(template_path) as z:
        for key in (MEDIA_BEFORE, MEDIA_AFTER):
            if key in z.namelist():
                sizes[key] = Image.open(io.BytesIO(z.read(key))).size
    return sizes


def cell_px(ws, c1, c2, r1, r2):
    """合并区在 100% 缩放下的像素尺寸（列宽字符数 → px、行高磅 → px）。"""
    sf = ws.sheet_format
    default_w = sf.defaultColWidth or 8.43
    default_h = sf.defaultRowHeight or 22.5
    total_w = 0
    for c in range(c1, c2 + 1):
        d = ws.column_dimensions.get(chr(64 + c))
        w = d.width if (d is not None and d.width) else default_w
        total_w += round(w * 7) + 5
    total_h = sum((ws.row_dimensions[r].height if r in ws.row_dimensions
                   and ws.row_dimensions[r].height else default_h) for r in range(r1, r2 + 1))
    return total_w, total_h * PX_PER_PT


def photo_boxes(template_path):
    """照片位承载单元格的区域像素尺寸：{媒体部件: (宽px, 高px)}。

    照片应当按**单元格区域**的宽高比来裁，而不是按模板里那张图自己的像素比例——
    后者在生产环境里把 4:3 的实拍照片裁成了 5.64:1 的一条，四角内容全丢。
    """
    import openpyxl
    from openpyxl.utils import column_index_from_string
    wb = openpyxl.load_workbook(template_path)
    ws = wb.worksheets[0]
    merge_of = {str(r).split(":")[0].upper(): r for r in ws.merged_cells.ranges}
    boxes = {}
    for media, anchor in PHOTO_CELLS.items():
        rng = merge_of.get(anchor)
        if rng:
            c1, c2, r1, r2 = rng.min_col, rng.max_col, rng.min_row, rng.max_row
        else:
            c1 = c2 = column_index_from_string(anchor[0])
            r1 = r2 = int(anchor[1:])
        boxes[media] = cell_px(ws, c1, c2, r1, r2)
    return boxes


def photo_targets(template_path, upscale=PHOTO_UPSCALE):
    """照片生成目标尺寸：单元格区域比例 × 放大倍数（默认 4 倍 ≈ 384 dpi）。"""
    return {media: (max(64, round(w * upscale)), max(64, round(h * upscale)))
            for media, (w, h) in photo_boxes(template_path).items()}


def dispimg_ids(sheet_xml: bytes) -> dict:
    """从 sheet1.xml 读出每个照片位里的 DISPIMG 图片 ID：{单元格: ID_xxx}。"""
    out = {}
    for ref in PHOTO_CELLS.values():
        m = re.search(rb'<c r="' + ref.encode() + rb'"[^>]*>(?:(?!</c>).)*?DISPIMG\("(ID_[^"]+)"',
                      sheet_xml, re.S)
        if m:
            out[ref] = m.group(1).decode()
    return out


_CELLIMAGE_RE = re.compile(rb"<etc:cellImage>.*?</etc:cellImage>", re.S)


def patch_cellimages(xml: bytes, sizes) -> bytes:
    """把 cellimages.xml 里各张嵌入单元格图片的显示尺寸改成单元格尺寸。

    WPS 的 DISPIMG 图片在 sheet 坐标系里带一组 off/ext；模板里"改善前"照片的
    ext 是 5695950×1009650 EMU（6.23×1.10 英寸，比例 5.64:1），而它承载的
    B8:D9 只有约 2.16×2.02 英寸——两者对不上。改成单元格尺寸后，照片在格子里
    按比例铺满，不会横向溢出或压扁。sizes: {DISPIMG ID: (cx, cy) EMU}
    """
    def repl(m):
        block = m.group(0).decode()
        mid = re.search(r'<xdr:cNvPr[^>]*name="(ID_[^"]+)"', block)
        if not mid or mid.group(1) not in sizes:
            return m.group(0)
        cx, cy = sizes[mid.group(1)]
        new, n = re.subn(r'<a:ext cx="\d+" cy="\d+"/>',
                         f'<a:ext cx="{int(cx)}" cy="{int(cy)}"/>', block)
        return new.encode() if n else m.group(0)

    return _CELLIMAGE_RE.sub(repl, xml)


# --------------------------------------------------------------------------- #
# 三、ZIP 层手术
# --------------------------------------------------------------------------- #

# 注意行内断言的位置：必须写成 (?:(?!/>)[^>])* 才能匹配自闭合单元格 <c ... />
_CELL_RE = re.compile(rb'<c r="(?P<ref>[A-Z]+\d+)"(?P<attrs>(?:(?!/>)[^>])*)(?:/>|>(?P<body>.*?)</c>)', re.S)


def _attr(attrs: str, name: str):
    m = re.search(rf'(?<![A-Za-z0-9]){re.escape(name)}="([^"]*)"', attrs)
    return m.group(1) if m else None


def build_cell_xml(ref, style, kind, value):
    s = f' s="{style}"' if style else ""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return f'<c r="{ref}"{s}/>'
    if kind in ("number", "date"):
        try:
            num = float(value)
            num = int(num) if num.is_integer() else num
        except (TypeError, ValueError):
            return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>'
        return f'<c r="{ref}"{s}><v>{num}</v></c>'
    return (f'<c r="{ref}"{s} t="inlineStr"><is>'
            f'<t xml:space="preserve">{escape(str(value))}</t></is></c>')


def to_date_serial(value):
    if isinstance(value, (int, float)):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y年%m月%d日"):
        try:
            return (_dt.datetime.strptime(text, fmt).date() - _dt.date(1899, 12, 30)).days
        except ValueError:
            continue
    return None


def patch_sheet(xml: bytes, values, grow_rows) -> bytes:
    def repl(m):
        ref = m.group("ref").decode()
        if ref not in values:
            return m.group(0)
        kind, value = values[ref]
        return build_cell_xml(ref, _attr(m.group("attrs").decode(), "s"), kind, value).encode()

    out = _CELL_RE.sub(repl, xml)

    for row_no, height in grow_rows.items():
        pat = re.compile(rb'<row r="%d"[^>]*>' % row_no)

        def row_repl(m, row_no=row_no, height=height):
            raw = m.group(0).decode()
            self_close = raw.endswith("/>")
            attrs = raw[len(f'<row r="{row_no}"'):(-2 if self_close else -1)]
            # 先剥 customHeight（它以 "ht" 结尾，必须带空格边界），再剥 ht
            attrs = re.sub(r'\s+customHeight="[^"]*"', "", attrs)
            attrs = re.sub(r'\s+ht="[^"]*"', "", attrs)
            return (f'<row r="{row_no}"{attrs} ht="{height:.1f}" customHeight="1"'
                    + ("/>" if self_close else ">")).encode()

        out = pat.sub(row_repl, out, count=1)
    return out


def write_xlsx(template_path, out_path, values, grow_rows, media_bytes, cellimage_sizes=None):
    """cellimage_sizes: {媒体部件: (宽px, 高px)} —— 同步修正 DISPIMG 的显示尺寸；
    模板没有 cellimages.xml（非 WPS 嵌入图模板）时自动跳过。"""
    with zipfile.ZipFile(template_path) as zin, \
            zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zout:
        names = set(zin.namelist())
        sizes_by_id = {}
        if cellimage_sizes and CELLIMAGES in names:
            ids = dispimg_ids(zin.read(SHEET))
            for media, (w, h) in cellimage_sizes.items():
                anchor = PHOTO_CELLS.get(media)
                if anchor and anchor in ids:
                    sizes_by_id[ids[anchor]] = (w * EMU_PER_PX, h * EMU_PER_PX)
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == SHEET:
                data = patch_sheet(data, values, grow_rows)
            elif item.filename == CELLIMAGES and sizes_by_id:
                data = patch_cellimages(data, sizes_by_id)
            elif item.filename in media_bytes:
                data = media_bytes[item.filename]
            zout.writestr(item, data)
        for name, blob in media_bytes.items():
            if name not in names:
                zout.writestr(name, blob)


# --------------------------------------------------------------------------- #
# 四、生成 Excel
# --------------------------------------------------------------------------- #

def build_xlsx(data, template, out_dir, photo_before="", photo_after="",
               photo_fit="cover", auto_height=True, quiet=False,
               photo_target="cell") -> bool:
    if not os.path.exists(template):
        print(f"错误：找不到模板 {template}\n请用 --template 指定公司表单，"
              f"或先跑 --make-blank 生成空白模板。", file=sys.stderr)
        return False, []

    capacity, height_of = load_metrics(template)
    values, warnings, grow_rows = {}, [], {}

    for field, (ref, kind) in FIELD_MAP.items():
        raw = data.get(field, "")
        if kind == "date":
            serial = to_date_serial(raw)
            if serial is None:
                if str(raw or "").strip():
                    warnings.append(f"「{field}」= “{raw}” 不是能识别的日期，已按文本写入"
                                    f"（建议改成 2026-09-14 格式）")
                    values[ref] = ("text", raw)
                else:
                    values[ref] = ("date", "")
            else:
                values[ref] = ("date", serial)
            continue
        if kind == "number":
            try:
                values[ref] = ("number", float(raw) if str(raw).strip() else 0)
            except (TypeError, ValueError):
                warnings.append(f"「{field}」= “{raw}” 不是数字，已按 0 写入")
                values[ref] = ("number", 0)
            continue

        text = "" if raw is None else str(raw).strip()
        values[ref] = ("text", text)
        if text:
            r1, r2, h, per_line = height_of[field]
            lines = max(1, int(h / LINE_HEIGHT_PT))
            need_lines = math.ceil(len(text) / per_line)
            if need_lines > lines:
                extra = max(need_lines, lines + 1) * LINE_HEIGHT_PT + 3 - h
                warnings.append(
                    f"「{field}」{len(text)} 字，超过该格一屏可见量约 {int(per_line * lines)} 字"
                    f"（每行约 {per_line:.0f} 字 × {lines} 行）。内容会完整保存，"
                    + (f"已把第 {r1}-{r2} 行加高 {extra:.0f} 磅以便完整显示" if auto_height
                       else "显示可能不全，可手动加高该行"))
                if auto_height:
                    each = extra / (r2 - r1 + 1)
                    for r in range(r1, r2 + 1):
                        grow_rows[r] = max(grow_rows.get(r, 0), h / (r2 - r1 + 1) + each)

    # 照片：命令行优先，其次 JSON 的 照片.改善前 / 照片.改善实施
    # 裁剪比例取承载单元格的区域（不是模板那张占位图的像素比例），
    # 并把 DISPIMG 的显示尺寸同步改成单元格尺寸，保证格内铺满、不溢出、不压扁。
    boxes = photo_boxes(template)
    targets = photo_targets(template)
    if photo_target == "media":       # 回退：按模板里那张占位图自己的像素比例裁
        targets, boxes = media_sizes(template), {}
    media_bytes = {}
    for key, src, label in ((MEDIA_BEFORE, photo_before or dig(data, "照片.改善前"), "改善前照片"),
                            (MEDIA_AFTER, photo_after or dig(data, "照片.改善实施"), "改善实施照片")):
        size = targets.get(key, (828, 776))
        if src and os.path.exists(src):
            try:
                media_bytes[key] = fit_photo(src, size, photo_fit)
                continue
            except Exception as exc:
                warnings.append(f"{label} 处理失败（{exc}），已用占位图代替")
        elif src:
            warnings.append(f"{label} 路径不存在：{src}（已用占位图代替）")
        else:
            warnings.append(f"未提供{label}——已放占位图，请在 WPS 中双击该格换成真实照片")
        media_bytes[key] = _png(placeholder_image(size, f"请替换为{label}"))

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"改善提案报告-{safe_name(data.get('提案名称', ''))}.xlsx")
    write_xlsx(template, out_path, values, grow_rows, media_bytes, boxes)
    print(f"已生成：{out_path}")
    return True, warnings


# --------------------------------------------------------------------------- #
# 五、填写校验与台账（台账默认不生成，加 --ledger 才写）
# --------------------------------------------------------------------------- #

# 明确表示"这次确实没有量化指标"的写法。写了这些就不必带数字。
NO_MEASURE_WORDS = ("没有量化指标", "没有", "无", "说不上具体数字", "无法量化")


def validate(data) -> list:
    """内容层面的检查（Excel 每格容量另由 build_xlsx 按模板实际尺寸测量）。"""
    w = []
    for f in SHOULD_FILL:
        if is_blank(data.get(f)):
            w.append(f"「{f}」为空——评审会看这一栏，建议补上")

    try:
        money = float(data.get("经济效益", 0) or 0)
    except (TypeError, ValueError):
        money = None
        w.append(f"「经济效益」= “{data.get('经济效益')}” 不是数字——那格是数值型单元格，只能填数字（单位元）")

    quant = str(data.get("量化效益", "") or "").strip()
    if not quant:
        w.append("「量化效益」为空——强问答这一项：算得出就写“节省工时：X 小时/月”，"
                 "算不出就写“没有量化指标”")
    elif not re.search(r"\d", quant) and quant not in NO_MEASURE_WORDS:
        w.append("「量化效益」既没有数字、也没明确写“没有量化指标”——两种写法选一个，别写成散文")

    how = str(data.get("计算方式", "") or "").strip()
    if money:
        if not how:
            w.append("「经济效益」填了金额但「计算方式」为空——制度第十七条要求效益经财务核准，"
                     "没有算式财务会退回")
        elif not re.search(r"\d", how):
            w.append("「计算方式」里没有出现任何数字——财务无法复核，请写成“公式 + 取值 + 年化依据”")
    elif is_blank(data.get("无形效益")):
        w.append("「经济效益」为 0 且「无形效益」也为空——这份提案看上去没有任何效果"
                 "（制度 2024 年修订专门强调了无形效益，没有金额不等于没有价值）")

    if is_blank(data.get("控制措施")) and is_blank(data.get("成果标准化")):
        w.append("「控制措施」和「成果标准化」都没填——评审会认为效果保不住，至少填一个"
                 "（最好是纳入标准的文件名称与编号）")

    if is_blank(data.get("提案类型")) or is_blank(data.get("业务类型")):
        w.append("「提案类型」或「业务类型」为空——照云文档表单给出的选项补上即可"
                 "（业务类型如：生产·工艺 / 质量 / 设备 / 安全环保 / 成本·物料 / 效率 / 信息化 / 管理）")

    name = str(data.get("提案名称", "") or "")
    if re.search(r"课题|攻关|研究", name):
        w.append("「提案名称」里有“课题/攻关/研究”字样——直接写改了什么就好，不要用这类词")
    return w


def _ledger_key(data) -> str:
    num = str(dig(data, "提案编号") or "").strip()
    if num:
        return num
    return "|".join([str(dig(data, "提案人")), str(dig(data, "完成日期")), str(dig(data, "提案名称"))])


def update_ledger(path, data) -> str:
    ledger = data.get("台账补充") or {}
    row = {
        "提案编号": dig(data, "提案编号") or "（待编号）", "提案名称": dig(data, "提案名称"),
        "提案人": dig(data, "提案人"), "实施人": dig(data, "实施人"),
        "部门": ledger.get("部门", ""), "班组": ledger.get("班组", ""), "岗位": ledger.get("岗位", ""),
        "完成日期": dig(data, "完成日期"), "提案类型": dig(data, "提案类型"),
        "业务类型": dig(data, "业务类型"), "改善类别": ledger.get("改善类别", ""),
        "存在问题": dig(data, "存在问题"), "主要原因": dig(data, "主要原因"),
        "改善对策": dig(data, "改善对策"), "控制措施": dig(data, "控制措施"),
        "成果标准化": dig(data, "成果标准化"), "无形效益": dig(data, "无形效益"),
        "经济效益元": dig(data, "经济效益", ""), "计算方式": dig(data, "计算方式"),
        "提交状态": ledger.get("提交状态", "已提交"),
    }
    rows = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8-sig", newline="") as fh:
            rows = list(csv.DictReader(fh))
    key, action = _ledger_key(data), "追加"
    for i, old in enumerate(rows):
        ek = str(old.get("提案编号") or "").strip()
        if not ek or ek == "（待编号）":
            ek = "|".join([str(old.get("提案人", "")), str(old.get("完成日期", "")),
                           str(old.get("提案名称", ""))])
        if ek == key:
            rows[i], action = row, "更新"
            break
    else:
        rows.append(row)
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=LEDGER_COLUMNS, extrasaction="ignore")
        wr.writeheader()
        for r in rows:
            wr.writerow({c: r.get(c, "") for c in LEDGER_COLUMNS})
    return action


# --------------------------------------------------------------------------- #
# 六、空白模板生成
# --------------------------------------------------------------------------- #

def make_blank(src, out_dir) -> int:
    if not os.path.exists(src):
        print(f"错误：找不到源文件 {src}", file=sys.stderr)
        return 2
    os.makedirs(out_dir, exist_ok=True)
    boxes = photo_boxes(src)
    targets = photo_targets(src)
    values = {FIELD_MAP[f][0]: (FIELD_MAP[f][1], "") for f in FIELD_MAP}
    media = {k: _png(placeholder_image(targets.get(k, v), label))
             for k, v, label in ((MEDIA_BEFORE, (828, 776), "改善前照片"),
                                 (MEDIA_AFTER, (3240, 2592), "改善实施照片"))}
    out_path = os.path.join(out_dir, "改善提案报告-空白模板.xlsx")
    write_xlsx(src, out_path, values, {}, media, boxes)
    print(f"已生成空白模板：{out_path}")
    print(f"  已清空 {len(values)} 个填写格；两张照片位换成单元格同比例占位图，"
          f"DISPIMG 显示尺寸同步改为单元格尺寸（版式与公式未改动）")
    return 0


# --------------------------------------------------------------------------- #

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="提案改善：一份 JSON 生成填好的《改善提案报告》Excel")
    p.add_argument("--version", action="version", version=f"make_proposal.py {__version__}")
    p.add_argument("json_file", nargs="?", help="提案 JSON")
    p.add_argument("--out", default=".", help="输出目录")
    p.add_argument("--template", default="", help="公司表单模板（默认用 assets 里的空白模板）")
    p.add_argument("--photo-before", default="", help="改善前照片（留空则取 JSON 的 照片.改善前）")
    p.add_argument("--photo-after", default="", help="改善实施照片（留空则取 JSON 的 照片.改善实施）")
    p.add_argument("--photo-fit", default="cover", choices=["cover", "contain"],
                   help="cover=居中裁切填满（默认）；contain=留边不裁")
    p.add_argument("--photo-target", default="cell", choices=["cell", "media"],
                   help="cell=按照片位单元格的比例裁剪并同步 DISPIMG 尺寸（默认，推荐）；"
                        "media=沿用模板占位图自己的像素比例（旧行为，会裁掉实拍照片大半）")
    p.add_argument("--no-auto-height", dest="auto_height", action="store_false", default=True,
                   help="文本超长时不自动加高行（默认会加高，以免显示不全）")
    p.add_argument("--ledger", action="store_true",
                   help="额外把本次提案追加/更新到 提案台账.csv（默认不生成，只要一个 Excel）")
    p.add_argument("--quiet", action="store_true", help="只报结果，不打印提示")
    p.add_argument("--new", metavar="目标.json", help="生成 JSON 填报模板后退出")
    p.add_argument("--fields", action="store_true", help="打印表单字段清单后退出")
    p.add_argument("--make-blank", metavar="源表单.xlsx", help="从公司表单反推空白模板")
    args = p.parse_args(argv)

    if args.new:
        with open(args.new, "w", encoding="utf-8") as fh:
            json.dump(NEW_TEMPLATE, fh, ensure_ascii=False, indent=2)
        print(f"已生成填报模板：{args.new}")
        return 0

    if args.fields:
        print("《改善提案报告》字段：")
        for i, f in enumerate(FORM_FIELDS, 1):
            cap = CAPACITY.get(f)
            print(f"  {i:2d}. {f}" + (f"（≤{cap} 字）" if cap else ""))
        return 0

    if args.make_blank:
        return make_blank(args.make_blank, args.out)

    if not args.json_file:
        p.error("需要指定提案 JSON（或用 --new 生成模板、--make-blank 生成空白表单）")

    with open(args.json_file, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    if is_blank(data.get("提案名称")):
        print("错误：JSON 里没有「提案名称」，无法生成。", file=sys.stderr)
        return 2

    out_dir = os.path.abspath(args.out)

    ok, excel_warnings = build_xlsx(data, args.template or default_template(), out_dir,
                                    args.photo_before, args.photo_after, args.photo_fit,
                                    args.auto_height, photo_target=args.photo_target)
    if not ok:
        return 2

    if not args.quiet:
        all_warnings = excel_warnings + validate(data)
        if all_warnings:
            print(f"\n填写提示：{len(all_warnings)} 条")
            for w in all_warnings:
                print(f"  ! {w}")
        else:
            print("\n填写提示：无")
        print(f"\n提醒：填好后从云文档提交（上传这个 Excel 作附件）：\n  {CLOUD_DOC}")

    if args.ledger:
        lp = os.path.join(out_dir, "提案台账.csv")
        print(f"台账已{update_ledger(lp, data)}：{lp}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
