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
  const hits = resolveOverlaps(findHits(text, rules), priority)
  if (hits.length === 0) return { text, hits: [], placeholders: [] }
  const placeholders: string[] = []
  let output = ''
  let cursor = 0
  for (const hit of hits) {
    // A rule with a fixed code replaces every hit with that code — a product's
    // assigned letter, a holder company's abbreviation — instead of a numbered
    // placeholder; the map still records the pairing so restore can undo it.
    const placeholder = hit.code === undefined
      ? map.placeholder(hit.category, hit.label, hit.text)
      : map.code(hit.category, hit.code, hit.text)
    placeholders.push(placeholder)
    output += text.slice(cursor, hit.start) + placeholder
    cursor = hit.end
  }
  output += text.slice(cursor)
  return { text: output, hits, placeholders }
}
