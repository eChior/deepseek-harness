/**
 * Turning a string into the string a session may keep.
 *
 * Two things happen here that a naive `replace()` gets wrong. First, one piece of
 * text routinely matches several rules at once (a national ID contains a run of
 * digits that also looks like a mobile number), so the hits are reduced to a
 * non-overlapping set before anything is written. Second, the same value must
 * always come out as the same placeholder — that identity lives in the map, not in
 * this module.
 */
import type { RedactionMap } from './map.ts'
import type { RedactionRule } from './terms.ts'

/** A single match of one rule against the text. */
export interface RedactionHit {
  readonly start: number
  readonly end: number
  readonly category: string
  readonly label: string
  /** The matched substring. */
  readonly text: string
  /** The term or pattern that matched. */
  readonly source: string
  readonly kind: 'term' | 'pattern'
  /** Fixed code the hit is replaced with; absent = numbered placeholder. */
  readonly code?: string
  /**
   * Alias-group key the hit belongs to; present only when the rule's code is a
   * `group.spelling` pair. All rules sharing the key replace with the same
   * `[公司<n>-<m>]` placeholder.
   */
  readonly group?: string
  /** Family number the term list spells out, e.g. the `13` of `13.1`. */
  readonly groupNumber?: number
  /** Spelling number inside that family, e.g. the `1` of `13.1`. */
  readonly spellingNumber?: number
}

/** The redacted text plus what was replaced. */
export interface RedactionResult {
  readonly text: string
  readonly hits: readonly RedactionHit[]
  readonly placeholders: readonly string[]
}

/**
 * Categories that win when two hits cover the same length. Identifiers are the most
 * specific thing a reader can act on, so they outrank a person's name or a date.
 */
export const DEFAULT_PRIORITY: readonly string[] = ['identifier', 'person']

/**
 * Ranges a rule may never rewrite, because a model has to act on them verbatim.
 *
 * A tool envelope names the file it touched inside `<path>`; rewriting a product
 * name there turns `D:\…\红霉素肠溶胶囊工艺.docx` into `D:\…\A工艺.docx`, and the
 * next tool call fails to find a file that was never renamed. A file is located
 * by this string, so the string has to survive the guard. Exactly the same
 * reasoning covers the attachment handle's saved path.
 */
const PROTECTED_SPANS: readonly RegExp[] = [
  /<path>[^\n]*?<\/path>/gu,
  // The attachment handle names the file twice — a display name and the saved
  // address. Both are how the model refers to the file afterwards, so neither
  // may be rewritten.
  /\[File "[^"\n]*"/gu,
  // A quoted Windows path keeps its spaces. The attachment handle always quotes
  // the saved copy, and `C:\Users\A B\report.docx` is a real address: cutting it
  // at the first space would leave the product name exposed while still
  // producing a path the model cannot open.
  /"[A-Za-z]:\\[^"\n]*"/gu,
  // An unquoted Windows path that ends in a file extension keeps its spaces too,
  // and stops at the extension so the sentence around it is still scanned. An
  // extension is letters only, which is what keeps `3.5mg` from being read as
  // the end of a path.
  /[A-Za-z]:\\(?:[^"'<>\n\\]*\\)*[^"'<>\n\\]*?\.[A-Za-z]{1,8}(?![.\w])/gu,
  /[A-Za-z]:\\[^\s"'<>]*/gu,
  // The same two shapes on a POSIX path, so a folder whose name carries a space
  // (`/srv/华润三九众益 资料/…`) is protected whole rather than up to the space.
  /(?:^|[\s"'(])\/(?:[^"'<>\n\/]*\/)*[^"'<>\n\/]*?\.[A-Za-z]{1,8}(?![.\w])/gu,
  /(?:^|[\s"'(])\/(?:[^\s"'<>)]+\/?)+/gu,
]

/**
 * Spans a rule must leave alone, as half-open `[start, end)` pairs.
 * @param text Text about to be scanned.
 * @returns The protected ranges, in no particular order.
 */
export function protectedSpans(text: string): readonly (readonly [number, number])[] {
  const spans: [number, number][] = []
  for (const pattern of PROTECTED_SPANS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index
      spans.push([start, start + match[0].length])
    }
  }
  return spans
}

/**
 * Every match of every rule, overlaps included.
 * @param text Text to scan.
 * @param rules Compiled rules to run against it.
 * @returns One hit per match, in rule order.
 */
export function findHits(text: string, rules: readonly RedactionRule[]): RedactionHit[] {
  const hits: RedactionHit[] = []
  for (const rule of rules) {
    // A term is a literal, so its membership test is a substring search. Tool
    // results run to hundreds of kilobytes and most rules are terms; skipping
    // the ones that cannot match keeps a large result off the regex engine.
    if (rule.kind === 'term' && !text.includes(rule.source)) continue
    for (const match of text.matchAll(rule.regex)) {
      const matched = match[0]
      if (matched === '') continue
      const start = match.index
      hits.push({
        start,
        end: start + matched.length,
        category: rule.category,
        label: rule.label,
        text: matched,
        source: rule.source,
        kind: rule.kind,
        ...rule.code === undefined ? {} : { code: rule.code },
        ...rule.group === undefined ? {} : { group: rule.group },
        ...rule.groupNumber === undefined ? {} : { groupNumber: rule.groupNumber },
        ...rule.spellingNumber === undefined ? {} : { spellingNumber: rule.spellingNumber },
      })
    }
  }
  return hits
}

/**
 * Reduce hits to a non-overlapping set: longest first, then the priority order, then
 * leftmost. A hit that intersects an accepted one is dropped, so a run of digits
 * inside a longer identifier never produces a second placeholder.
 * @param hits Hits to reduce; the input list is left untouched.
 * @param priority Categories that win when two hits have the same length.
 * @returns A left-to-right, non-overlapping subset of the input.
 */
export function resolveOverlaps(
  hits: readonly RedactionHit[],
  priority: readonly string[] = DEFAULT_PRIORITY,
): RedactionHit[] {
  const rank = (hit: RedactionHit): number => {
    const index = priority.indexOf(hit.category)
    return index === -1 ? priority.length : index
  }
  const ranked = [...hits].sort((a, b) => {
    const byLength = (b.end - b.start) - (a.end - a.start)
    if (byLength !== 0) return byLength
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    return a.start - b.start
  })
  const accepted: RedactionHit[] = []
  for (const hit of ranked) {
    if (accepted.some(other => hit.start < other.end && other.start < hit.end)) continue
    accepted.push(hit)
  }
  return accepted.sort((a, b) => a.start - b.start)
}

/**
 * Replace every sensitive run in `text` with a placeholder. Idempotent per value:
 * calling it twice on the same text yields the same output, and the second call
 * matches nothing because the originals are gone.
 * @param text Text to rewrite.
 * @param rules Compiled rules to run against it.
 * @param map Map that owns placeholder identity.
 * @param priority Categories that win when two hits have the same length.
 * @returns The rewritten text, the accepted hits, and the placeholders it used.
 */
export function redactText(
  text: string,
  rules: readonly RedactionRule[],
  map: RedactionMap,
  priority: readonly string[] = DEFAULT_PRIORITY,
): RedactionResult {
  const spans = protectedSpans(text)
  const accepted = resolveOverlaps(findHits(text, rules), priority)
  // A hit inside a path or a `<path>` envelope is dropped, not clipped: half a
  // file name is neither the original nor a placeholder the reader can restore.
  const hits = spans.length === 0
    ? accepted
    : accepted.filter(hit => !spans.some(([start, end]) => hit.start < end && start < hit.end))
  if (hits.length === 0) return { text, hits: [], placeholders: [] }
  const placeholders: string[] = []
  let output = ''
  let cursor = 0
  for (const hit of hits) {
    // A rule with a fixed code replaces every hit with that code — a product's
    // assigned letter, a holder company's abbreviation — instead of a numbered
    // placeholder; the map still records the pairing so restore can undo it.
    // A group rule (a holder's alias set, a product's spellings) replaces with
    // `[公司<n>-<m>]` instead: one family number per company or product, one
    // spelling number per distinct wording, both taken from the term list.
    const placeholder = hit.group !== undefined
      ? map.group(
        hit.category,
        hit.label,
        hit.group,
        hit.text,
        hit.groupNumber === undefined || hit.spellingNumber === undefined
          ? undefined
          : { group: hit.groupNumber, spelling: hit.spellingNumber },
      )
      : hit.code === undefined
        ? map.placeholder(hit.category, hit.label, hit.text)
        : map.code(hit.category, hit.code, hit.text)
    // A hit that already sits inside brackets is wearing the very shape a
    // placeholder has, so the brackets go with it. Replacing only the value
    // would leave `[` behind on the first pass and nest another pair on the
    // next one.
    let start = hit.start
    let end = hit.end
    while (start > cursor && text[start - 1] === '[' && text[end] === ']') {
      start -= 1
      end += 1
    }
    placeholders.push(placeholder)
    output += text.slice(cursor, start) + placeholder
    cursor = end
  }
  output += text.slice(cursor)
  return { text: output, hits, placeholders }
}
