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
   * Entries read back from earlier processes, filed under the session whose
   * mapping file recorded them. Kept apart from {@link #entries} — that one is
   * this process's own work, the count a reader sees — and filed per session,
   * because one task owns one mapping: two sessions may hand `[工艺-1]` to
   * different values, and a single merged table would restore the wrong original.
   */
  readonly #history = new Map<string, RedactionEntry[]>()

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
    // The counter is keyed by the visible label, not the category id: two
    // categories that share one label (`craft` and `craft-metric` both read
    // 「工艺」) would otherwise hand out the same placeholder for different
    // values, and no restore tool could tell them apart.
    const next = (this.#counters.get(label) ?? 0) + 1
    this.#counters.set(label, next)
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
   * File the entries one session's mapping file recorded, so that session's text
   * still restores after a restart.
   *
   * The entries do NOT enter this process's own tables. A session's table is
   * returned by {@link entriesFor} when that session is rendered, and only then:
   * merging every file on the machine into one lookup would let a placeholder
   * from another task resolve to the wrong value. What the files do contribute
   * here is the counter position — {@link #seed} keeps every fresh value from
   * taking a number one of them already used.
   * @param sessionId Session the file belongs to.
   * @param entries Entries the file records, in the order they were written.
   */
  adopt(sessionId: string, entries: readonly RedactionEntry[]): void {
    const filed = this.#history.get(sessionId) ?? []
    for (const entry of entries) {
      this.#seed(entry.category, entry.placeholder)
      if (filed.some(known => known.placeholder === entry.placeholder)) continue
      filed.push({ placeholder: entry.placeholder, category: entry.category, original: entry.original })
    }
    this.#history.set(sessionId, filed)
  }

  /**
   * Raise the counter that covers one placeholder an earlier process issued.
   * Without this a value first seen after a restart takes a number an older file
   * already gave to something else, and one of the two restores wrong.
   * @param category Category the entry was recorded under.
   * @param placeholder Placeholder from a mapping file: numbered or grouped.
   */
  #seed(category: string, placeholder: string): void {
    const numbered = /^\[(?<label>.+)-(?<sequence>\d{1,6})\]$/.exec(placeholder)
    if (numbered?.groups !== undefined) {
      const label = numbered.groups['label'] as string
      const sequence = Number(numbered.groups['sequence'])
      this.#counters.set(label, Math.max(this.#counters.get(label) ?? 0, sequence))
      return
    }
    // A grouped placeholder (`公司<n>-<m>`) records no group key, only the spare
    // number, so a company never met before still takes a free one.
    const grouped = /^公司(?<group>\d+)-(?<spelling>\d+)$/.exec(placeholder)
    if (grouped?.groups === undefined) return
    const allKey = `${category}\u0000all`
    const group = Number(grouped.groups['group'])
    this.#groups.set(allKey, Math.max(this.#groups.get(allKey) ?? 0, group))
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
   * Swap every placeholder back for its original. Used where a human reads the
   * text (rendering a reply); never on the way into a session.
   * @param text Text that may carry placeholders.
   * @param sessionId Session the text belongs to. When given, only its own
   *   mapping file and this process's live work are consulted, so `[工艺-1]` in
   *   one conversation never resolves to another conversation's value. Without
   *   it every table on this machine is consulted, which is what a caller that
   *   holds no session identity can do.
   * @returns The text with the placeholders it carries restored.
   */
  restore(text: string, sessionId?: string): string {
    const table = this.#tableFor(sessionId)
    if (table.size === 0) return text
    // Numbered placeholders match by shape; fixed codes (a bare `A`, `ZY`) do
    // not, so they are spliced back by their wrapped form only — a natural
    // letter in the text never matches.
    let restored = text.replace(/\[[^\]\n]{1,32}-\d{1,6}\]/g, match => table.get(match) ?? match)
    for (const [code, original] of table) {
      if (code.startsWith('[')) continue
      if (!restored.includes(code)) continue
      restored = restored.split(code).join(original)
    }
    return restored
  }

  /**
   * The lookup one restore runs against.
   * @param sessionId Session in view, or undefined for every table on the machine.
   * @returns Placeholder (in the shape it wears in text) to original.
   */
  #tableFor(sessionId: string | undefined): ReadonlyMap<string, string> {
    if (sessionId === undefined) {
      if (this.#history.size === 0) return this.#byPlaceholder
      const merged = new Map(this.#byPlaceholder)
      for (const filed of this.#history.values()) {
        for (const entry of filed) {
          const shaped = codeShape(entry.placeholder)
          // A live entry for the same shape wins: this process issued it and
          // knows what it stands for right now.
          if (!merged.has(shaped)) merged.set(shaped, entry.original)
        }
      }
      return merged
    }
    const table = new Map<string, string>()
    const filed = this.#history.get(sessionId)
    if (filed !== undefined) {
      for (const entry of filed) table.set(codeShape(entry.placeholder), entry.original)
    }
    for (const entry of this.#entries) {
      const shaped = codeShape(entry.placeholder)
      if (!table.has(shaped)) table.set(shaped, entry.original)
    }
    return table
  }

  /**
   * The pairings one session restores with: what its own mapping file recorded,
   * then what this process issued for the conversation still being lived in.
   * @param sessionId Session whose conversation is being rendered.
   * @returns That session's entries; empty when no file and no live work exist.
   */
  entriesFor(sessionId: string): readonly RedactionEntry[] {
    const filed = this.#history.get(sessionId) ?? []
    if (this.#entries.length === 0) return filed
    const seen = new Set(filed.map(entry => entry.placeholder))
    return [...filed, ...this.#entries.filter(entry => !seen.has(entry.placeholder))]
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
    this.#history.clear()
  }
}
