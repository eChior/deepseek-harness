#!/usr/bin/env python3
"""Turn the QMS staff export into the encrypted roster the client reads.

The spreadsheet never enters the repository. This script is run once by hand on
a developer machine, reads the export from wherever it happens to live, and
writes only the ciphertext into ``assets/roster.bin``. From then on CI copies a
binary blob: no build step, no log line, and no source file ever holds a name,
an employee number, or a department.

    python scripts/build-roster.py /path/to/全公司名单.xlsx

Layout of the output (little-endian where it matters):

    magic     4 bytes   b"RSTR"
    version   1 byte    1
    iv       12 bytes   AES-GCM nonce
    tag      16 bytes   AES-GCM authentication tag
    payload   n bytes   ciphertext of the UTF-8 JSON below

Plaintext JSON:

    {"revision": "...", "people": [{"name", "department", "employeeId",
     "position", "account", "qmsId", "active"}], "departments": ["..."]}

The key is shared with ``src/roster.ts``. It keeps the roster out of casual
sight in a checkout, the installed bundle, or a build log. It is not a secret
against someone who reads the repository and decides to extract the list.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path

import openpyxl
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"RSTR"
VERSION = 1
KEY_ENVIRONMENT = "DSH_ROSTER_KEY"

COLUMNS = ("序号", "姓名", "工号", "部门", "班组", "岗位", "在职状态", "LDAP账号", "QMS人员ID")


def cell(value: object) -> str:
    return "" if value is None else str(value).strip()


def read_people(sheet) -> list[dict[str, object]]:
    rows = list(sheet.iter_rows(values_only=True))
    if not rows:
        raise SystemExit("the sheet is empty")
    header = [cell(c) for c in rows[0]]
    index = {name: position for position, name in enumerate(header) if name}

    def column(name: str) -> int | None:
        return index.get(name)

    name_at = column("姓名")
    if name_at is None:
        raise SystemExit(f"no 姓名 column; found {header}")

    seen: set[str] = set()
    people: list[dict[str, object]] = []
    for row in rows[1:]:
        name = cell(row[name_at]) if name_at < len(row) else ""
        if name == "" or name in seen:
            continue
        seen.add(name)

        def at(label: str) -> str:
            position = column(label)
            if position is None or position >= len(row):
                return ""
            return cell(row[position])

        status = at("在职状态")
        people.append(
            {
                "name": name,
                "department": at("部门"),
                "employeeId": at("工号"),
                "position": at("岗位"),
                "account": at("LDAP账号"),
                "qmsId": at("QMS人员ID"),
                "active": status in ("", "在职"),
            }
        )
    return people


def read_departments(sheet) -> list[str]:
    departments: list[str] = []
    for row in sheet.iter_rows(values_only=True):
        first = cell(row[0]) if row else ""
        if first in ("", "部门", "合计"):
            continue
        if first not in departments:
            departments.append(first)
    return departments


def main() -> int:
    parser = argparse.ArgumentParser(description="Build assets/roster.bin from the QMS export.")
    parser.add_argument("source", help="path to the .xlsx export")
    parser.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parent.parent / "assets" / "roster.bin"),
        help="where to write the ciphertext (default: assets/roster.bin)",
    )
    parser.add_argument("--revision", default="", help="revision stamp recorded inside")
    options = parser.parse_args()

    workbook = openpyxl.load_workbook(options.source, read_only=True, data_only=True)
    people = read_people(workbook.worksheets[0])
    departments = read_departments(workbook.worksheets[1]) if len(workbook.worksheets) > 1 else []
    for person in people:
        department = str(person["department"])
        if department and department not in departments:
            departments.append(department)

    revision = options.revision or str(os.path.getmtime(options.source))
    plaintext = json.dumps(
        {"revision": revision, "people": people, "departments": departments},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

    key_hex = os.environ.get(KEY_ENVIRONMENT, "").strip()
    if len(key_hex) != 64:
        raise SystemExit(f"set {KEY_ENVIRONMENT} to a 32-byte hex key (64 hex characters)")
    try:
        key = bytes.fromhex(key_hex)
    except ValueError as error:
        raise SystemExit(f"{KEY_ENVIRONMENT} is not hex: {error}") from error

    iv = os.urandom(12)
    sealed = AESGCM(key).encrypt(iv, plaintext, MAGIC + bytes([VERSION]))
    body = sealed[:-16]
    tag = sealed[-16:]
    target = Path(options.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(MAGIC + bytes([VERSION]) + iv + tag + body)
    # The runtime reads the key from here too, so a checkout holding the
    # ciphertext still opens it without anyone exporting a variable.
    target.with_name("roster.key").write_text(key_hex + "\n", encoding="utf-8")

    print(f"{len(people)} people, {len(departments)} departments")
    print(f"{len(plaintext)} bytes of plaintext -> {target.stat().st_size} bytes of ciphertext")
    print(f"wrote {target}, key beside it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
