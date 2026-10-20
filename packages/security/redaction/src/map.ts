/**
 * The in-memory correspondence between text this process redacted and the
 * placeholders it handed out.
 *
 * Deliberately not persisted. A placeholder survives in a session file forever,
 * but the mapping that could turn it back into the original does not survive the
 * process — so nothing on disk can be replayed into the sensitive value, and a
 * model that reads the session sees only placeholders.
 */

/** Placeholder form: `[<label>-<n>]`. */
export interface RedactionEntry {
  readonly placeholder: string
  readonly category: string
  readonly original: string
}

/**
 * Invisible separator (U+2060 word joiner) wrapped around every fixed code that
 * leaves this process. A code like `A` is an ordinary word; in running text the
 * letter occurs naturally, so the bare code could be spliced back over text it
 * never stood for. Wrapped, the code is a unique token nothing else collides
 * with — and restore matches the exact wrapped shape, never the bare code.
 */
export const CODE_JOINER = '\u2060'

/**
 * The form a fixed code takes in redacted text: the code wrapped in invisible
 * separators. Numbered placeholders (`[产品-3]`) are already unique by shape and
 * pass through untouched.
 * @param placeholder A bare fixed code (`A`, `ZY`) from the entry log.
 * @returns The wrapped form to search for in redacted text.
 */
export function codeShape(placeholder: string): string {
  return placeholder.startsWith('[') ? placeholder : `${CODE_JOINER}${placeholder}${CODE_JOINER}`
}

/**
 * The visible form of an alias-group placeholder: `公司1-1` (group 1, spelling 1).
 * The term list spells it `1.1` because `|` separates the code; the dash form is
 * what humans see and what the session keeps.
 * @param group Group number, allocated per category in first-seen order.
 * @param spelling Spelling number inside the group, also first-seen order.
 * @returns The dashed visible form, e.g. `公司1-1`.
 */
export function groupShape(group: number, spelling: number): string {
  return `公司${group}-${spelling}`
}

/** Hand out placeholders, resolve them back, and remember nothing after a restart. */
export class RedactionMap {
  readonly #byOriginal = new Map<string, string>()
  readonly #byPlaceholder = new Map<string, string>()
  readonly #counters = new Map<string, number>()
  readonly #groups = new Map<string, number>()
  readonly #spellings = new Map<string, number>()
  readonly #entries: RedactionEntry[] = []

  /**
   * Placeholder for `original` in `category`, allocating the next sequence number
   * on first sight. The same value always yields the same placeholder, so a model
   * can reason about `[偏差-3]` across turns.
   * @param category Category that owns the sequence number.
   * @param label Display label the placeholder carries.
   * @param original Value the placeholder stands for.
   * @returns The placeholder, reused when this value was seen before.
   */
  placeholder(category: string, label: string, original: string): string {
    const existing = this.#byOriginal.get(original)
    if (existing !== undefined) return existing
    const next = (this.#counters.get(category) ?? 0) + 1
    this.#counters.set(category, next)
    const placeholder = `[${label}-${next}]`
    this.#byOriginal.set(original, placeholder)
    this.#byPlaceholder.set(placeholder, original)
    this.#entries.push({ placeholder, category, original })
    return placeholder
  }

  /**
   * Fixed code for `original`, allocating nothing: the code comes from the term
   * list, so every sighting of the same value yields the same short code (a
   * product's assigned letter, a holder company's abbreviation) rather than a
   * numbered placeholder. Still recorded in the entry log, so the restore tool
   * can put the full name back.
   * @param category Category that owns the code.
   * @param code Fixed code the list declares.
   * @param original Value the code stands for.
   * @returns The code, reused when this value was seen before.
   */
  code(category: string, code: string, original: string): string {
    const existing = this.#byOriginal.get(original)
    if (existing !== undefined) return existing
    const shaped = codeShape(code)
    this.#byOriginal.set(original, shaped)
    this.#byPlaceholder.set(shaped, original)
    // The entry log carries the bare code; the wrapped form is a transport
    // detail of this process, and downstream readers (the mapping file, the
    // client view) re-wrap it with `codeShape` themselves.
    this.#entries.push({ placeholder: code, category, original })
    return shaped
  }

  /**
   * Alias-group placeholder for `original`: every company becomes `公司<n>-<m>`,
   * where `<n>` is one company (all spellings share it) and `<m>` is one
   * spelling. The same spelling always keeps its numbers; a spelling seen for
   * the first time takes the next free pair, in first-seen order, so restore
   * can put every spelling back exactly.
   * @param category Category that owns the group sequences.
   * @param group Group key — one company across all its spellings.
   * @param original The spelling as it appeared in the text.
   * @returns The dashed placeholder, reused when this spelling was seen before.
   */
  group(category: string, group: string, original: string): string {
    const existing = this.#byOriginal.get(original)
    if (existing !== undefined) return existing
    const allKey = `${category}\u0000all`
    const nextGroup = this.#groups.get(group) ?? (this.#groups.get(allKey) ?? 0) + 1
    this.#groups.set(group, nextGroup)
    this.#groups.set(allKey, Math.max(this.#groups.get(allKey) ?? 0, nextGroup))
    const nextSpelling = (this.#spellings.get(group) ?? 0) + 1
    this.#spellings.set(group, nextSpelling)
    const shaped = codeShape(groupShape(nextGroup, nextSpelling))
    this.#byOriginal.set(original, shaped)
    this.#byPlaceholder.set(shaped, original)
    // The entry log carries the bare dashed form; wrapping is transport detail.
    this.#entries.push({ placeholder: groupShape(nextGroup, nextSpelling), category, original })
    return shaped
  }

  /**
   * Original behind a placeholder, or undefined when this process never issued it.
   * @param placeholder Placeholder text to resolve.
   * @returns The value it stands for, or undefined for a placeholder from another process.
   */
  lookup(placeholder: string): string | undefined {
    return this.#byPlaceholder.get(placeholder)
  }

  /**
   * Swap every placeholder this process issued back for its original. Used where a
   * human reads the text (rendering a reply); never on the way into a session.
   * @param text Text that may carry placeholders.
   * @returns The text with every placeholder this process issued restored.
   */
  restore(text: string): string {
    if (this.#byPlaceholder.size === 0) return text
    // Numbered placeholders match by shape; fixed codes (a bare `A`, `ZY`) do
    // not, so they are spliced back by their wrapped form only — a natural
    // letter in the text never matches.
    let restored = text.replace(/\[[^\]\n]{1,32}-\d{1,6}\]/g, match => this.#byPlaceholder.get(match) ?? match)
    for (const [code, original] of this.#byPlaceholder) {
      if (code.startsWith('[')) continue
      if (!restored.includes(code)) continue
      restored = restored.split(code).join(original)
    }
    return restored
  }

  /** Distinct values this process has replaced. */
  get size(): number {
    return this.#byOriginal.size
  }

  /**
   * Everything this process replaced, in the order it was first seen.
   * @returns The recorded entries; empty before the first replacement.
   */
  entries(): readonly RedactionEntry[] {
    return this.#entries
  }

  /**
   * Everything this process replaced, in first-seen order, forgetting it at the
   * same moment — the hand-off form for persisting one session's table.
   * @returns The recorded entries; empty before the first replacement.
   */
  takeEntries(): readonly RedactionEntry[] {
    const taken = [...this.#entries]
    this.clear()
    return taken
  }

  /** Forget every placeholder and value, returning the map to its initial state. */
  clear(): void {
    this.#byOriginal.clear()
    this.#byPlaceholder.clear()
    this.#counters.clear()
    this.#groups.clear()
    this.#spellings.clear()
    this.#entries.length = 0
  }
}
