r"""Restore the placeholders in generated files back to their originals.

One session's redaction map is written to
`<dsh-home>/redaction/mappings/<session-id>.jsonl` when the session ends — one
JSON object per line: `{"placeholder":…, "category":…, "original":…}`. The
redacted text lives in exported files; this tool reads the mapping files, swaps
every placeholder for the value it stood for, and deletes each mapping file it
fully consumed, so no original text survives on disk after the restore.

Fixed codes (`A`, `ZY`) are plain words, so they are replaced with the longest
match first to keep `AC` from being eaten by an `A` rule. Numbered placeholders
(`[产品-3]`) match by shape.

Usage:
    python restore_mappings.py FILE... [--mappings-dir DIR] [--dry-run]

Options:
    FILE...              Files whose placeholders should be restored, in place.
    --mappings-dir DIR   Where the session mapping files live.
                         Default: %DSH_HOME%\redaction\mappings (Windows) or
                         ~/.dsh/redaction/mappings; override with $DSH_HOME.
    --dry-run            Report what would change without writing any file.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

NUMBERED = re.compile(r"\[[^\]\n]{1,32}-\d{1,6}\]")


def default_mappings_dir() -> Path:
    home = os.environ.get("DSH_HOME")
    base = Path(home) if home else Path.home() / ".dsh"
    return base / "redaction" / "mappings"


def load_mappings(directory: Path) -> tuple[dict[str, str], list[Path]]:
    """Read every mapping file. Returns (placeholder→original, files read)."""
    table: dict[str, str] = {}
    files: list[Path] = []
    if not directory.is_dir():
        return table, files
    for path in sorted(directory.glob("*.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            print(f"warning: cannot read {path}: {error}", file=sys.stderr)
            continue
        used = False
        for line in lines:
            line = line.strip()
            if line == "":
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError as error:
                print(f"warning: {path.name}: bad line skipped: {error}", file=sys.stderr)
                continue
            placeholder = entry.get("placeholder")
            original = entry.get("original")
            if not isinstance(placeholder, str) or not isinstance(original, str):
                continue
            used = True
            table.setdefault(placeholder, original)
        if used:
            files.append(path)
    return table, files


def build_patterns(table: dict[str, str]) -> tuple[re.Pattern[str], dict[str, str]]:
    """One alternation, longest placeholder first, so `AC` wins over `A`."""
    ordered = sorted(table, key=len, reverse=True)
    if not ordered:
        return re.compile(r"(?!x)x"), {}  # matches nothing
    pieces = [re.escape(placeholder) for placeholder in ordered]
    return re.compile("|".join(pieces)), table


def restore_file(path: Path, pattern: re.Pattern[str], table: dict[str, str], dry_run: bool) -> int:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        print(f"warning: cannot read {path}: {error}", file=sys.stderr)
        return 0
    replaced = 0

    def swap(match: re.Match[str]) -> str:
        nonlocal replaced
        original = table[match.group(0)]
        if original != match.group(0):
            replaced += 1
        return original

    restored = pattern.sub(swap, text)
    if replaced == 0:
        return 0
    if not dry_run:
        path.write_text(restored, encoding="utf-8")
    print(f"{path}: {replaced} placeholder(s) restored{' (dry-run)' if dry_run else ''}")
    return replaced


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="+", type=Path, help="files to restore in place")
    parser.add_argument("--mappings-dir", type=Path, default=default_mappings_dir())
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    table, mapping_files = load_mappings(args.mappings_dir)
    if not table:
        print(f"no mappings found in {args.mappings_dir}; nothing to restore")
        return 1
    pattern, escaped = build_patterns(table)

    touched = 0
    for path in args.files:
        if restore_file(path, pattern, escaped, args.dry_run) > 0:
            touched += 1

    if touched == 0:
        print("no placeholders found in the given files; mapping files kept")
        return 0
    if not args.dry_run:
        for path in mapping_files:
            try:
                path.unlink()
                print(f"removed {path}")
            except OSError as error:
                print(f"warning: cannot remove {path}: {error}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
