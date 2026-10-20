r"""Restore the placeholders in generated files back to their originals.

One session's redaction map is written to
`<dsh-home>/redaction/mappings/<session-id>.jsonl` when the session ends — one
JSON object per line: `{"placeholder":…, "category":…, "original":…}`. The
redacted text lives in exported files; this tool reads the mapping files and
swaps every placeholder for the value it stood for. Mapping files are KEPT so
that old sessions stay readable (the client view uses them too); pass
`--consume` to delete each mapping file after a fully successful restore.

Placeholder shapes:
  - numbered:   `[产品-3]`            — matched by shape
  - fixed code: `A`, `ZY`             — stored wrapped in AI word joiners
                (U+2060, invisible):  `<U+2060>A<U+2060>`; the wrapping is
                transport detail, this tool matches the wrapped form so a
                natural letter `A` in the text is never touched
  - alias group: `公司1-2`            — same wrapping as fixed codes

Usage:
    python restore_mappings.py FILE... [--mappings-dir DIR] [--dry-run] [--consume]

Options:
    FILE...              Files whose placeholders should be restored, in place.
    --mappings-dir DIR   Where the session mapping files live.
                         Default: %DSH_HOME%\redaction\mappings (Windows) or
                         ~/.dsh/redaction/mappings; override with $DSH_HOME.
    --dry-run            Report what would change without writing any file.
    --consume            Delete each mapping file after its placeholders were
                         fully restored (old behaviour; default keeps them).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

JOINER = "\u2060"
NUMBERED = re.compile(r"\[[^\]\n]{1,32}-\d{1,6}\]")


def default_mappings_dir() -> Path:
    home = os.environ.get("DSH_HOME")
    base = Path(home) if home else Path.home() / ".dsh"
    return base / "redaction" / "mappings"


def load_mappings(directory: Path) -> dict[str, str]:
    """Read every mapping file. Returns (bare placeholder → original)."""
    table: dict[str, str] = {}
    if not directory.is_dir():
        return table
    for path in sorted(directory.glob("*.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            print(f"warning: cannot read {path}: {error}", file=sys.stderr)
            continue
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
            table.setdefault(placeholder, original)
    return table


def build_patterns(table: dict[str, str]) -> re.Pattern[str]:
    """One alternation over the TEXT forms of every placeholder.

    Bare codes and group placeholders appear in text wrapped in U+2060 on both
    sides; numbered placeholders appear as-is. Longest first so a longer code
    wins over a shorter one inside the same alternation arm ordering.
    """
    forms: list[str] = []
    for placeholder in table:
        if placeholder.startswith("["):
            forms.append(placeholder)
        else:
            forms.append(f"{JOINER}{placeholder}{JOINER}")
    ordered = sorted(set(forms), key=len, reverse=True)
    if not ordered:
        return re.compile(r"(?!x)x")  # matches nothing
    return re.compile("|".join(re.escape(form) for form in ordered))


def restore_file(path: Path, pattern: re.Pattern[str], table: dict[str, str], dry_run: bool) -> int:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        print(f"warning: cannot read {path}: {error}", file=sys.stderr)
        return 0
    replaced = 0

    def swap(match: re.Match[str]) -> str:
        nonlocal replaced
        form = match.group(0)
        bare = form[len(JOINER):len(form) - len(JOINER)] if form.startswith(JOINER) else form
        original = table.get(bare)
        if original is None:
            return form
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
    parser.add_argument("--consume", action="store_true",
                        help="delete mapping files after a fully successful restore (default: keep)")
    args = parser.parse_args()

    table = load_mappings(args.mappings_dir)
    if not table:
        print(f"no mappings found in {args.mappings_dir}; nothing to restore")
        return 1
    pattern = build_patterns(table)

    touched = 0
    for path in args.files:
        if restore_file(path, pattern, table, args.dry_run) > 0:
            touched += 1

    if touched == 0:
        print("no placeholders found in the given files; mapping files kept")
        return 0
    if args.consume and not args.dry_run:
        for path in sorted(args.mappings_dir.glob("*.jsonl")):
            try:
                path.unlink()
                print(f"removed {path}")
            except OSError as error:
                print(f"warning: cannot remove {path}: {error}", file=sys.stderr)
    elif not args.consume:
        print("mapping files kept")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
