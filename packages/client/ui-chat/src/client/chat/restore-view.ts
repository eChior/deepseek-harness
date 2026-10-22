/**
 * The reader's own view of redacted text: which placeholder stood for which
 * value, and where a restored value sits. The session log and every outbound
 * request keep the placeholder; this module only builds the display projection
 * shared by the user bubble and the assistant's prose.
 */

/** Numbered placeholders the provider hands out; only these match by shape. */
const NUMBERED_PLACEHOLDER = /\[[^\]\n]{1,32}-\d{1,6}]/g

/** One run of the view text, flagged when it replaces a placeholder. */
interface ViewPiece {
  readonly text: string
  readonly restored: boolean
}

/** The view text plus the spans a reader should be able to tell apart. */
export interface RestoredView {
  readonly text: string
  /** Half-open `[start, end)` offsets into `text` holding restored values. */
  readonly spans: readonly (readonly [number, number])[]
}

/** Swap every unreplaced run of `pieces` on `needle`, flagging the replacements. */
function replaceInPieces(pieces: ViewPiece[], needle: string, replacement: string): boolean {
  let replaced = false
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index]
    if (piece === undefined || piece.restored || !piece.text.includes(needle)) continue
    const parts: ViewPiece[] = []
    let cursor = 0
    let hit = piece.text.indexOf(needle)
    while (hit !== -1) {
      if (hit > cursor) parts.push({ text: piece.text.slice(cursor, hit), restored: false })
      parts.push({ text: replacement, restored: true })
      cursor = hit + needle.length
      hit = piece.text.indexOf(needle, cursor)
    }
    if (cursor < piece.text.length) parts.push({ text: piece.text.slice(cursor), restored: false })
    pieces.splice(index, 1, ...parts)
    replaced = true
  }
  return replaced
}

/** Swap numbered placeholders by shape; unknown ones stay visible as logged. */
function restoreNumbered(pieces: ViewPiece[], placeholders: ReadonlyMap<string, string>): void {
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index]
    if (piece === undefined || piece.restored) continue
    const parts: ViewPiece[] = []
    let cursor = 0
    for (const match of piece.text.matchAll(NUMBERED_PLACEHOLDER)) {
      const original = placeholders.get(match[0])
      if (original === undefined) continue
      const start = match.index
      if (start > cursor) parts.push({ text: piece.text.slice(cursor, start), restored: false })
      parts.push({ text: original, restored: true })
      cursor = start + match[0].length
    }
    if (parts.length === 0) continue
    if (cursor < piece.text.length) parts.push({ text: piece.text.slice(cursor), restored: false })
    pieces.splice(index, 1, ...parts)
  }
}

/**
 * Swap every placeholder this machine issued back for its value, for the view
 * only. Numbered and grouped placeholders match by shape; a fixed code (`[A]`,
 * `[ZY]`) is spliced by its exact bracketed text. Every form is bracketed, so no
 * invisible marker is written around it and none has to be looked for here.
 * @param text Text as the session logged it.
 * @param placeholders Placeholder to original, from the provider's table.
 * @returns The restored text and the spans that hold a restored value.
 */
export function restoreUserView(text: string, placeholders: ReadonlyMap<string, string>): RestoredView {
  const pieces: ViewPiece[] = [{ text, restored: false }]
  // A logged placeholder can wear extra bracket pairs. An older build spliced a
  // bare code out of its brackets and left them behind, and pasting such a line
  // back in made the next pass wrap it again, so the text carries `[H]` or even
  // `[[H]]`. Peel every depth, longest first, and let the shape pass take
  // whatever is left once the table has done its work.
  const ordered = [...placeholders].sort(([left], [right]) => right.length - left.length)
  for (const [key, original] of ordered) {
    if (key === original) continue
    const inner = key.startsWith('[') && key.endsWith(']') ? key.slice(1, -1) : key
    for (let depth = 3; depth >= 1; depth -= 1) {
      replaceInPieces(pieces, `${'['.repeat(depth)}${inner}${']'.repeat(depth)}`, original)
    }
  }
  restoreNumbered(pieces, placeholders)
  let restored = ''
  const spans: (readonly [number, number])[] = []
  for (const piece of pieces) {
    if (piece.restored && piece.text !== '') spans.push([restored.length, restored.length + piece.text.length])
    restored += piece.text
  }
  return { text: restored, spans }
}
