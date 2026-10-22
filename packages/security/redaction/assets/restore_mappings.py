r"""Restore the placeholders in generated files back to their originals.

One session's redaction map is written to
`<dsh-home>/redaction/mappings/<session-id>.jsonl` when the session ends — one
JSON object per line: `{"placeholder":…, "category":…, "original":…}`. The
redacted text lives in exported files; this tool reads the mapping files and
swaps every placeholder for the value it stood for. Mapping files are KEPT so
that old sessions stay readable (the client view uses them too); pass
`--consume` to delete each mapping file after a fully successful restore.

Placeholder shapes — every one is bracketed:
  - numbered:   `[工艺-1]`   — one value, one number
  - fixed code: `[A]`, `[ZY]` — a product letter or a company abbreviation
  - group:      `[公司1-2]`  — family 1 (one company), spelling 2 (one wording);
                `[产品13-1]` and `[产品13-2]` are the same product written two
                ways, so a summary may treat them as one thing
An older build wrapped a bare code in an invisible word joiner (U+2060) and
never bracketed it; a mapping file it wrote may still hold that bare form. Those
old shapes are matched too, so an old mapping still restores what it produced.

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
# An old-build group placeholder, e.g. `公司1-2`, written without brackets.
LEGACY_GROUP = re.compile(r"公司\d+-\d+")
# An old-build numbered or fixed-code placeholder, published without brackets.
LEGACY_BARE = re.compile(r"[^\W\d_]+-\d{1,6}")


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

    A bracketed placeholder appears as-is. A bare code (`A`) or a bare dashed
    group (`公司1-2`) comes from an older mapping file, which published it
    wrapped in U+2060; it is matched in that wrapped form so a natural letter in
    the text is never touched. Longest form first, so `[公司1-10]` wins over
    `[公司1-1]`.
    """
    forms: list[str] = []
    for placeholder in table:
        if placeholder.startswith("["):
            forms.append(placeholder)
        else:
            forms.append(f"{JOINER}{placeholder}{JOINER}")
            # An old build also wrote the bracket-less group form; keep it so an
            # old mapping still restores what that build produced.
            if LEGACY_GROUP.fullmatch(placeholder) or LEGACY_BARE.fullmatch(placeholder):
                forms.append(f"[{placeholder}]")
                # An old build's own text carried the bracket-less form, and a
                # model quoting it back may drop the brackets; both restore.
                forms.append(placeholder)
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
        if form.startswith(JOINER):
            bare = form[len(JOINER):len(form) - len(JOINER)]
        else:
            bare = form
        original = table.get(bare)
        if original is None:
            # The bracketed form of an old bracket-less group entry.
            bare = form[1:-1] if form.startswith("[") and not table.get(form) else bare
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
