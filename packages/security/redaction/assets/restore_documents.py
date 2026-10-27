#!/usr/bin/env python3
"""Put the originals back into the files a tool call wrote.

A model only ever sees placeholders, so a document it produces carries
placeholders too. This script is the only party allowed to touch those files:
the deployment's document encryption whitelists the Python interpreter, so a
read or write from the harness process itself is refused, or would break the
ciphertext. Everything therefore happens here.

It reads one JSON request from stdin::

    {"paths": ["D:/work/report.docx", "notes.md"],
     "entries": [{"placeholder": "[产品-1]", "original": "红霉素肠溶胶囊"}]}

and rewrites every listed file that holds a placeholder. A file with no
placeholder is left untouched, so its modification time does not move. One
JSON object reporting what happened goes to stdout.
"""

import io
import json
import sys
import zipfile
from pathlib import Path

# Container formats: the text lives in the XML members, the rest is binary.
ARCHIVE_EXTENSIONS = {'.docx', '.xlsx', '.pptx'}
# Plain text formats: the whole file is the text.
TEXT_EXTENSIONS = {'.md', '.markdown', '.txt', '.csv', '.tsv'}

MAX_BYTES = 256 * 1024 * 1024


def build_pairs(entries):
    """Longest placeholder first, so `[公司1-1]` is not eaten by a shorter prefix."""
    pairs = []
    for entry in entries or []:
        placeholder = entry.get('placeholder')
        original = entry.get('original')
        if not placeholder or not original or placeholder == original:
            continue
        if not (placeholder.startswith('[') and placeholder.endswith(']')):
            # A bare code would hit ordinary prose, so only a bracketed sighting
            # is replaced — that is the shape the text actually carries.
            placeholder = '[' + placeholder + ']'
        pairs.append((placeholder, original))
    pairs.sort(key=lambda pair: len(pair[0]), reverse=True)
    return pairs


def swap(text, pairs):
    """Replace every placeholder; return the text and how many sightings it held."""
    hits = 0
    for placeholder, original in pairs:
        # Eat a copy-and-paste doubling first: replacing the inner placeholder
        # alone would leave the extra brackets stranded around the original.
        inner = placeholder[1:-1]
        for depth in (3, 2):
            doubled = '[' * depth + inner + ']' * depth
            if doubled in text:
                hits += text.count(doubled)
                text = text.replace(doubled, original)
        if placeholder in text:
            hits += text.count(placeholder)
            text = text.replace(placeholder, original)
    return text, hits


def restore_archive(payload, pairs):
    """Rewrite the XML members of a container; return (bytes, hits) or (None, 0)."""
    try:
        source = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        return None, 0
    total = 0
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename.lower().endswith('.xml'):
                try:
                    text = data.decode('utf-8')
                except UnicodeDecodeError:
                    text = None
                if text is not None:
                    replaced, hits = swap(text, pairs)
                    if hits:
                        data = replaced.encode('utf-8')
                        total += hits
            target.writestr(item, data)
    return (buffer.getvalue(), total) if total else (None, 0)


def restore_text(payload, pairs):
    try:
        text = payload.decode('utf-8')
    except UnicodeDecodeError:
        return None, 0
    replaced, hits = swap(text, pairs)
    return (replaced.encode('utf-8'), hits) if hits else (None, 0)


def restore_file(path, pairs):
    """Return how many placeholders this file held, or 0 when it was left alone."""
    if not path.is_file():
        return 0, 'missing'
    suffix = path.suffix.lower()
    if suffix not in ARCHIVE_EXTENSIONS and suffix not in TEXT_EXTENSIONS:
        return 0, 'unsupported'
    try:
        if path.stat().st_size > MAX_BYTES:
            return 0, 'too large'
        payload = path.read_bytes()
    except OSError:
        return 0, 'unreadable'
    if suffix in ARCHIVE_EXTENSIONS:
        replaced, hits = restore_archive(payload, pairs)
    else:
        replaced, hits = restore_text(payload, pairs)
    if not hits or replaced is None:
        return 0, 'no placeholder'
    try:
        path.write_bytes(replaced)
    except OSError:
        return 0, 'unwritable'
    return hits, 'restored'


def main():
    # The harness writes UTF-8 on the pipe; never let the console code page
    # reinterpret it, or a Chinese placeholder arrives as mojibake and nothing
    # matches.
    try:
        request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
        print(json.dumps({'restored': 0, 'reason': 'unreadable request'}))
        return 0
    pairs = build_pairs(request.get('entries'))
    if not pairs:
        print(json.dumps({'restored': 0, 'reason': 'no mappings'}))
        return 0
    restored = []
    skipped = []
    for raw in request.get('paths') or []:
        if not isinstance(raw, str) or not raw:
            continue
        hits, note = restore_file(Path(raw), pairs)
        if hits:
            restored.append({'path': raw, 'hits': hits})
        elif note != 'missing':
            skipped.append({'path': raw, 'reason': note})
    print(json.dumps(
        {'restored': len(restored), 'files': restored, 'skipped': skipped},
        ensure_ascii=False,
    ))
    return 0


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    sys.exit(main())
