#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一份填好的《改善提案报告》提交到 rwork 多维表格「改善提案台账」。

用法：
    python submit_bitable.py 提案.json ./提案改善/改善提案报告-xxx.xlsx --done
    python submit_bitable.py 提案.json <xlsx> --dry-run      # 只体检，不写表
    python submit_bitable.py 提案.json <xlsx> --token pt-xxx # 或读本地配置

**这是结案动作**：台账只收已实施完成、提案人自己确认效果达到的提案，所以必须显式加 `--done`；
不加会拒绝执行（只想预览就用 `--dry-run`）。没做完的提案别交，先把 Excel 交给提案人留存。

字段映射（按公司现行表结构，只填到「实施部门」为止）：
    提案名称(动宾描述) ← 提案名称
    提案类型           ← 提案类型        （必须是想定选项之一）
    提案人             ← 提案人          （姓名 → open_id）
    提案部门           ← 提案部门        （必须是想定选项之一）
    实施人             ← 实施人          （可留空，默认同提案人）
    实施部门           ← 实施部门        （想定选项之一）
    提案日期           ← 完成日期 / 提案日期
    经济效益           ← 经济效益        （数字，元）
    改善提案报告       ← 本 Excel（自动上传为附件）
    AI相关             ← 只在「新增 skill」或「程序/脚本类」提案打勾（加 --ai-related；默认不打勾）

令牌（授权码）：
    脚本内置一份加密凭据（见 _SEALED_CRED），运行时只在内存里解出，不落盘、不打印、
    不写进 skill 正文。需要临时换别的令牌时才用 --token 或环境变量 RWORK_BASE_TOKEN 覆盖。
    —— 令牌是共用凭据；密文随脚本分发，员工看不到明文，也不要把明文发给员工。

姓名 → open_id 映射读取优先级：
    --people-map  >  <本脚本目录>/people_map.json  >  <本脚本目录>/../data/people_map.json
"""
from __future__ import annotations

__version__ = "0.1.1"

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

BASE_API = os.environ.get("RWORK_BASE_API", "https://base-api.rwork.crc.com.cn")
APP_TOKEN = "bask9wcePBHUds0Vzb3a1L4d9Tb"
TABLE_ID = "tblq9Acb2Kn1Gsk6"
TIMEOUT = 30

PATH_RECORDS = f"/open-apis/bitable/v1/apps/{APP_TOKEN}/tables/{TABLE_ID}/records"
PATH_FIELDS = f"/open-apis/bitable/v1/apps/{APP_TOKEN}/tables/{TABLE_ID}/fields"

# 台账里承载量化效益的那一列（文本）。提交前会确认它存在，缺了就建一个。
QUANT_FIELD = "量化效益"

# 每月省下的工时（纯数字，小时/月）。台账按这一列求和出月度总效益。
MONTH_FIELD = "月度效益"
PATH_UPLOAD = "/open-apis/drive/v1/medias/upload_all"

# 下面两份是兜底清单：正常情况下选项从表里现读（fetch_options），
# 读不到才用它们，所以表里新增了选项不必改代码。
PROPOSAL_TYPES = ["物耗/能耗(Cost)", "效率(Productivity)", "安全(Safety)", "其他(Other)",
                  "产能(Ability)", "品质(Quality)", "环境(Environment)"]
DEPARTMENTS = ["生产部", "质量部QC", "质量部QA(含PV)", "供应链管理部", "技术创新部", "行政部",
               "研发中心", "人力资源部", "EHS监督管理部", "财务部", "九众质量管理部",
               "九众供应链", "总经办", "公共关系事务部", "智能与信息化部"]


# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #

def find_people_map(explicit: str = "") -> dict:
    cands = []
    if explicit:
        cands.append(explicit)
    here = os.path.dirname(os.path.abspath(__file__))
    cands += [os.path.join(here, "people_map.json"),
              os.path.join(os.path.dirname(here), "data", "people_map.json"),
              os.path.join(os.getcwd(), "people_map.json"),
              os.path.join(os.getcwd(), ".improvement_people_map.json")]
    for p in cands:
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as fh:
                m = json.load(fh)
            m = {k: v for k, v in m.items() if isinstance(v, str) and v.startswith("ou_")}
            return m
    return {}


def fetch_people_map(token: str, warnings: list, page_size: int = 500) -> dict:
    """从表里现有记录提取 姓名/邮箱 → open_id（免维护的映射表）。

    这套 rwork 私有化环境没有开放通讯录接口（contact/v3 全部 404），
    只能从台账自己的「提案人 / 实施人 / 创建人」人员字段里反推。
    """
    people: dict = {}
    page_token = ""
    for _ in range(40):
        q = {"page_size": page_size}
        if page_token:
            q["page_token"] = page_token
        out = call(token, PATH_RECORDS, "GET", None, q)
        if out.get("code") not in (0, None):
            warnings.append(f"人员映射刷新失败：code={out.get('code')} msg={out.get('msg')}"
                            "（将只用本地 people_map.json）")
            return people
        d = out.get("data") or {}
        for rec in (d.get("items") or []):
            for v in (rec.get("fields") or {}).values():
                for item in (v if isinstance(v, list) else [v]):
                    if not isinstance(item, dict):
                        continue
                    oid = item.get("id") or item.get("open_id") or ""
                    if not str(oid).startswith("ou_"):
                        continue
                    for key in ("name", "en_name", "email", "user_name"):
                        k = str(item.get(key) or "").strip()
                        if k:
                            people.setdefault(k, oid)
                            people.setdefault(k.split("@")[0], oid)
        if not d.get("has_more"):
            break
        page_token = d.get("page_token") or ""
        if not page_token:
            break
    return people


def fetch_options(token: str, warnings: list) -> dict:
    """从表里读出单选/多选字段的**当前**选项，避免脚本里写死的清单过期。

    选项是会变的（用户随时会在网页上加一个部门或提案类型），所以提交前
    以表里的定义为准；读不到时才退回脚本里的常量。
    """
    out = call(token, PATH_FIELDS, "GET", None, {"page_size": 200})
    if out.get("code") not in (0, None):
        warnings.append(f"字段选项读取失败：code={out.get('code')} msg={out.get('msg')}"
                        "（将用脚本内置的选项清单）")
        return {}
    opts: dict = {}
    for it in ((out.get("data") or {}).get("items") or []):
        if it.get("type") in (3, 4):          # 3=单选, 4=多选
            names = [o.get("name") for o in ((it.get("property") or {}).get("options") or [])
                     if o.get("name")]
            if names:
                opts[it.get("field_name")] = names
    return opts


# --------------------------------------------------------------------------- #
# 内置授权码（密文形态）
# --------------------------------------------------------------------------- #
# 授权码不以明文出现在任何文件里：这里是 SHA256 计数器流 XOR + base64 的结果，
# 密钥由下面几段拼出。运行时在内存里解出，只用于请求头的 Bearer，不落盘、不打印。
_SEALED_CRED = ("5TUCIgV5tmr3Hx9M2POZG9CxMATjn91Pwdh0gu15SR+hmZu14OxssHGbZVabVj6K"
                "XQmPHBbIrOa2awmaVlQN")
_KEY_PARTS = ("zhiku-", "9f2c7a41", "-dsh-", "b0XGvD", "-2026")
_CRED_NONCE = "ip-token-v1"


def _unseal_credential() -> str:
    """解出共用授权码；失败返回空串（调用处会提示缺令牌）。"""
    try:
        key = hashlib.sha256("".join(_KEY_PARTS).encode()).digest()
        raw = base64.b64decode(_SEALED_CRED)
        stream = b""
        i = 0
        while len(stream) < len(raw):
            stream += hashlib.sha256(key + _CRED_NONCE.encode() + i.to_bytes(4, "big")).digest()
            i += 1
        return bytes(a ^ b for a, b in zip(raw, stream)).decode("utf-8")
    except Exception:
        return ""


def find_token(explicit: str = "") -> str:
    if explicit.strip():
        return explicit.strip()
    env = (os.environ.get("RWORK_BASE_TOKEN") or os.environ.get("DSH_RWORK_TOKEN") or "").strip()
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    for p in (os.path.join(here, ".token"),
              os.path.expanduser("~/.dsh/improvement-proposal.token")):
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as fh:
                t = fh.read().strip()
            if t:
                return t
    return _unseal_credential()


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

def call(token: str, path: str, method: str = "GET", body=None, query: dict | None = None):
    url = BASE_API + path
    if query:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
    data = None
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            j = json.loads(raw)
            return {"code": j.get("code", exc.code), "msg": j.get("msg", ""), "error": j.get("error")}
        except ValueError:
            return {"code": exc.code, "msg": raw[:300]}


def upload_media(token: str, path: str) -> tuple[str, str]:
    """上传文件为 bitable 附件，返回 (file_token, 说明/错误)。"""
    boundary = "----dsh" + uuid.uuid4().hex
    filename = os.path.basename(path)
    size = os.path.getsize(path)
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    parts = []
    for k, v in (("file_name", filename), ("parent_type", "bitable_file"),
                 ("parent_node", APP_TOKEN), ("size", str(size))):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                 f"filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n".encode())
    with open(path, "rb") as fh:
        parts.append(fh.read())
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    r = urllib.request.Request(BASE_API + PATH_UPLOAD, data=body, method="POST", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            out = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return "", f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:200]}"
    tok = ((out.get("data") or {}).get("file_token")) or ""
    if not tok:
        return "", f"上传失败：{json.dumps(out, ensure_ascii=False)[:300]}"
    return tok, ""


# --------------------------------------------------------------------------- #
# 值转换
# --------------------------------------------------------------------------- #

def to_ms(v) -> int:
    """把日期写成多维表格要的毫秒时间戳。已支持时间戳直填。"""
    if isinstance(v, (int, float)) and v > 10_000_000_000:
        return int(v)
    s = str(v or "").strip()
    if not s:
        return 0
    if s.isdigit() and len(s) >= 12:
        return int(s)
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y-%m-%d %H:%M", "%Y年%m月%d日"):
        try:
            return int(datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError(f"日期 “{s}” 认不出来，请写成 2026-09-14 这种形式")


def dig(data: dict, key: str):
    """支持 “提案人.0.姓名” 这种取法，兼容扁平 JSON。"""
    if key in data:
        return data[key]
    cur = data
    for part in key.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


# --------------------------------------------------------------------------- #
# 组记录
# --------------------------------------------------------------------------- #

def ensure_month_field(token: str, warnings: list) -> None:
    """确保台账里有「月度效益」这一列（文本，存每月省下的工时数字）。"""
    items = fetch_options(token, PATH_FIELDS, warnings)
    if items is None:
        warnings.append(
            f"没能读到台账字段列表，无法确认「{MONTH_FIELD}」列是否存在")
        return
    if any(str(it.get("field_name") or "") == MONTH_FIELD for it in items):
        return
    made = call(token, PATH_FIELDS, "POST", {"field_name": MONTH_FIELD, "type": 1})
    if made.get("code") not in (0, None):
        warnings.append(f"没能新建「{MONTH_FIELD}」列（code={made.get('code')} "
                        f"{made.get('msg')}），提交会跳过它")


def ensure_quant_field(token: str, warnings: list) -> None:
    """确保台账里有「量化效益」这一列（多行文本），没有就建一个。"""
    out = call(token, PATH_FIELDS, "GET", None, {"page_size": 200})
    if out.get("code") != 0:
        warnings.append(f"没能读取台账字段（code={out.get('code')} msg={out.get('msg')}），"
                        f"「{QUANT_FIELD}」如果不存在，提交会失败")
        return
    items = (out.get("data") or {}).get("items") or []
    if any(str(it.get("field_name") or "") == QUANT_FIELD for it in items):
        return
    made = call(token, PATH_FIELDS, "POST", {"field_name": QUANT_FIELD, "type": 1})
    if made.get("code") != 0:
        warnings.append(f"没能新建「{QUANT_FIELD}」列（code={made.get('code')} "
                        f"msg={made.get('msg')}），请在多维表格里手动加一列文本字段")


def build_fields(data: dict, people: dict, file_token: str, ai_check: bool,
                 warnings: list, options: dict | None = None) -> dict:
    options = options or {}
    f = {}

    name = str(dig(data, "提案名称") or "").strip()
    if name:
        f["提案名称(动宾描述)"] = name

    allowed_types = options.get("提案类型") or PROPOSAL_TYPES
    ptype = str(dig(data, "提案类型") or "").strip()
    if ptype:
        if ptype in allowed_types:
            f["提案类型"] = ptype
        else:
            warnings.append(f"「提案类型」= “{ptype}” 不在表内选项里（{('、'.join(allowed_types))}）"
                            "，这一栏没有提交，请在网页上补选")

    for label, field in (("提案人", "提案人"), ("实施人", "实施人")):
        who = str(dig(data, label) or "").strip()
        if not who:
            continue
        if label == "实施人" and who == str(dig(data, "提案人") or "").strip():
            pass
        oid = people.get(who)
        if not oid:
            warnings.append(f"「{label}」= “{who}” 在人员映射表里查不到 open_id，"
                            "这一栏没有提交（可把姓名写全 / 或在表里手动选人）")
            continue
        f[field] = [{"id": oid}]

    allowed_depts = options.get("提案部门") or DEPARTMENTS
    dept = str(dig(data, "提案部门") or "").strip()
    if dept:
        if dept in allowed_depts:
            f["提案部门"] = dept
        else:
            warnings.append(f"「提案部门」= “{dept}” 不在表内选项里，没有提交，请手动选")

    # 实施部门：多选，必须字符串数组
    impl_dept = dig(data, "实施部门") or []
    if isinstance(impl_dept, str):
        impl_dept = [x.strip() for x in impl_dept.replace("、", ",").split(",") if x.strip()]
    impl_dept = [d for d in impl_dept if str(d).strip()]
    if impl_dept:
        allowed_impl = options.get("实施部门") or DEPARTMENTS
        ok = [d for d in impl_dept if d in allowed_impl]
        bad = [d for d in impl_dept if d not in allowed_impl]
        if ok:
            f["实施部门"] = ok
        if bad:
            warnings.append(f"「实施部门」里 {bad} 不在表内选项里，这些没提交")

    date_v = dig(data, "提案日期") or dig(data, "完成日期")
    if date_v:
        try:
            ms = to_ms(date_v)
            if ms:
                f["提案日期"] = ms
        except ValueError as exc:
            warnings.append(str(exc))

    money = dig(data, "经济效益")
    if money not in (None, ""):
        try:
            f["经济效益"] = float(str(money).replace(",", ""))
        except (TypeError, ValueError):
            warnings.append(f"「经济效益」= “{money}” 不是数字，这一栏按 0 提交")

    if file_token:
        month = str(dig(data, "月度效益") or "").strip()
        if month:
            f[MONTH_FIELD] = month
        quant = str(dig(data, "量化效益") or "").strip()
    if quant:
        f[QUANT_FIELD] = quant
    else:
        warnings.append("「量化效益」为空——这一列是必填，算不出数字就写“没有量化指标”")

    f["改善提案报告"] = [{"file_token": file_token}]

    if ai_check:
        f["AI相关"] = True

    return f


# --------------------------------------------------------------------------- #

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="提交《改善提案报告》到 rwork 多维表格")
    p.add_argument("--version", action="version", version=f"submit_bitable.py {__version__}")
    p.add_argument("json_file", help="提案 JSON（和生成 Excel 用的是同一份）")
    p.add_argument("xlsx", nargs="?", default="", help="要上传的《改善提案报告》Excel")
    p.add_argument("--token", default="", help="授权码 pt-…（默认读本地配置/环境变量）")
    p.add_argument("--people-map", default="", help="姓名→open_id 映射 JSON")
    p.add_argument("--ai-related", dest="ai_check", action="store_true", default=False,
                   help="在「AI相关」复选框打勾（只有新增 skill 或程序/脚本类提案才加这个开关）")
    p.add_argument("--dry-run", action="store_true", help="只体检，不写多维表格")
    p.add_argument("--done", action="store_true",
                   help="确认提案已实施完成（结案提交必填；台账不收没做完的提案）")
    p.add_argument("--record-id", default="", help="改已有记录，而不是新建")
    args = p.parse_args(argv)

    if not args.dry_run and not args.done:
        print("这是结案动作：台账只收已实施完成、提案人自己确认效果达到的提案。\n"
              "  确认已经做完   → 加 --done 再跑\n"
              "  还没做完       → 先别交，把 Excel 交给提案人留存\n"
              "  只想看看会交什么 → 用 --dry-run", file=sys.stderr)
        return 2

    with open(args.json_file, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    token = find_token(args.token)
    people = find_people_map(args.people_map)
    boot_warnings: list[str] = []
    if not people:
        if not token:
            print("错误：没有本地姓名→open_id 映射表，也没有授权码。\n"
                  "      要么给 --token 让脚本从台账里自动提取人员，"
                  "要么给 --people-map 指向一份 people_map.json。", file=sys.stderr)
            return 2
        print("本地没有人员映射表，正从台账反查姓名→open_id（约 900+ 条记录，稍等）…")
        people = fetch_people_map(token, boot_warnings)
        print(f"  已从台账提取 {len(people)} 个名字/邮箱 → open_id")
        here = os.path.dirname(os.path.abspath(__file__))
        cached_to = ""
        for cache in (os.path.join(here, "people_map.json"),
                      os.path.join(os.getcwd(), ".improvement_people_map.json")):
            try:
                with open(cache, "w", encoding="utf-8") as fh:
                    json.dump(people, fh, ensure_ascii=False)
                cached_to = cache
                break
            except OSError:
                continue
        if cached_to:
            print(f"  已缓存到 {cached_to}（下次直接读它，不再拉台账）")
        else:
            boot_warnings.append("人员映射没能缓存到本地，下次还得再拉一遍台账")
    if not people:
        print("错误：没能取得姓名→open_id 映射，无法提交人员字段。", file=sys.stderr)
        return 2

    warnings: list[str] = list(boot_warnings)
    file_token = ""
    if args.xlsx and not args.dry_run:
        if not token:
            print("错误：没有授权码。用 --token，或把令牌存到 "
                  "~/.dsh/improvement-proposal.token", file=sys.stderr)
            return 2
        if not os.path.exists(args.xlsx):
            print(f"错误：找不到要上传的 Excel：{args.xlsx}", file=sys.stderr)
            return 2
        file_token, err = upload_media(token, args.xlsx)
        if err:
            print(f"错误：附件上传失败：{err}", file=sys.stderr)
            return 1

    options = fetch_options(token, warnings) if token else {}
    if token:
        ensure_quant_field(token, warnings)
        ensure_month_field(token, warnings)
    fields = build_fields(data, people, file_token, args.ai_check, warnings, options)

    print("将要提交的内容：")
    for k, v in fields.items():
        s = json.dumps(v, ensure_ascii=False)
        print(f"  {k} = {s[:120]}")
    if warnings:
        print("\n需要你在网页上补的：")
        for w in warnings:
            print(f"  ! {w}")
    if args.dry_run:
        print("\n（--dry-run：没有写入）")
        return 0

    if not token:
        print("错误：没有授权码。用 --token，或把令牌存到 "
              "~/.dsh/improvement-proposal.token", file=sys.stderr)
        return 2

    if args.record_id:
        out = call(token, f"{PATH_RECORDS}/{args.record_id}",
                   "PUT", {"fields": fields}, {"user_id_type": "open_id"})
    else:
        out = call(token, PATH_RECORDS, "POST", {"fields": fields},
                   {"user_id_type": "open_id"})
    if out.get("code") not in (0, None):
        print(f"\n提交失败：code={out.get('code')} msg={out.get('msg')} "
              f"{json.dumps(out.get('error'), ensure_ascii=False)}", file=sys.stderr)
        return 1

    rec = (out.get("data") or {}).get("record") or {}
    rid = rec.get("record_id") or ""
    got = rec.get("fields") or {}
    print(f"\n提交成功：record_id = {rid}")
    for k in ("提案编号", "流水号", "提案名称(动宾描述)", "AI相关", "改善提案报告"):
        if k in got:
            print(f"  {k} = {json.dumps(got[k], ensure_ascii=False)[:160]}")
    print(f"\n表：https://app.rwork.crc.com.cn/base/{APP_TOKEN}?table={TABLE_ID}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
