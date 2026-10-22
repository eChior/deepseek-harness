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
 * Every placeholder wears one shape: square brackets around a label.
 *
 * A single value reads `[工艺-1]`; a value that belongs to a family of
 * synonymous spellings reads `[公司1-1]`, `[公司1-2]` — the same label with the
 * family number glued on, then a spelling number. One shape means the model can
 * be told a single rule (`[XX-…]` and `[XX1-…]` are placeholders, copy them
 * verbatim) instead of a rule per category, and restore matches by the brackets
 * rather than by a per-category pattern.
 */

/**
 * The form any placeholder takes in redacted text.
 *
 * An invisible separator (U+2060 word joiner) used to wrap a bare code so that a
 * letter like `A` could not be spliced back over ordinary text. The brackets do
 * that job now, so nothing invisible is written and the code travels as `[A]`.
 * @param placeholder A placeholder or bare code from the entry log.
 * @returns The bracketed form to search for in redacted text.
 */
export function codeShape(placeholder: string): string {
  return placeholder.startsWith('[') ? placeholder : `[${placeholder}]`
}

/**
 * The visible form of a group placeholder: `[公司1-1]` (family 1, spelling 1).
 * The term list spells the code `1.1` because `|` separates it from the term;
 * the bracketed dashed form is what the model and the session see.
 * @param label Display label of the category, e.g. `公司` or `产品`.
 * @param group Family number, allocated per category in first-seen order.
 * @param spelling Spelling number inside the family, also first-seen order.
 * @returns The bracketed form, e.g. `[公司1-1]`.
 */
export function groupShape(label: string, group: number, spelling: number): string {
  return `[${label}${group}-${spelling}]`
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
   * Entries read back from the mapping file this machine kept. The table is
   * machine-wide on purpose: a placeholder means the same value in every
   * conversation, so `[产品-3]` written yesterday still restores today and in a
   * session that has not touched it. Kept apart from {@link #entries} — that one
   * is this process's own work, the count a reader sees and the part still to be
   * written — so a reload never files the same pairing twice.
   */
  readonly #filed: RedactionEntry[] = []
  /**
   * Original to the placeholder the machine's file already gave it. Kept beside
   * {@link #byOriginal} rather than in it so {@link size} keeps counting only what
   * this process replaced, while a value seen again still takes the number the
   * file pinned it to — a placeholder that changed on every restart would make
   * yesterday's sessions unreadable.
   */
  readonly #filedOriginal = new Map<string, string>()

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
    const existing = this.#byOriginal.get(original) ?? this.#filedOriginal.get(original)
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
    const existing = this.#byOriginal.get(original) ?? this.#filedOriginal.get(original)
    if (existing !== undefined) return existing
    const shaped = codeShape(code)
    this.#byOriginal.set(original, shaped)
    this.#byPlaceholder.set(shaped, original)
    // The entry log carries the wrapped form — the text the session actually
    // wrote — so a reader that splices by exact text takes the brackets with it.
    // A mapping file an older build wrote still holds the bare code, and
    // `codeShape` on read is what keeps those restorable.
    this.#entries.push({ placeholder: shaped, category, original })
    return shaped
  }

  /**
   * Alias-group placeholder for `original`: every company becomes `公司<n>-<m>`,
   * where `<n>` is one company (all spellings share it) and `<m>` is one
   * spelling. The same spelling always keeps its numbers; a spelling seen for
   * the first time takes the next free pair, in first-seen order, so restore
   * can put every spelling back exactly.
   * @param category Category that owns the group sequences.
   * @param label Display label the placeholder carries, e.g. `公司`.
   * @param group Group key — one family across all its spellings.
   * @param original The spelling as it appeared in the text.
   * @param fixed Numbers the term list spells out (`13.1` → family 13, spelling
   *   1). When given they are used verbatim, so the list — not first-seen order —
   *   decides the numbering and `[产品13-1]` means the same product everywhere.
   *   Absent for a category whose list names no number, where the map allocates.
   * @returns The bracketed placeholder, reused when this spelling was seen before.
   */
  group(
    category: string,
    label: string,
    group: string,
    original: string,
    fixed?: { readonly group: number; readonly spelling: number },
  ): string {
    const existing = this.#byOriginal.get(original)
    if (existing !== undefined) return existing
    const allKey = `${category}\u0000all`
    const nextGroup = fixed?.group ?? this.#groups.get(group) ?? (this.#groups.get(allKey) ?? 0) + 1
    this.#groups.set(group, nextGroup)
    this.#groups.set(allKey, Math.max(this.#groups.get(allKey) ?? 0, nextGroup))
    const nextSpelling = fixed?.spelling ?? (this.#spellings.get(group) ?? 0) + 1
    const shaped = groupShape(label, nextGroup, nextSpelling)
    this.#spellings.set(group, Math.max(this.#spellings.get(group) ?? 0, nextSpelling))
    this.#byOriginal.set(original, shaped)
    this.#byPlaceholder.set(shaped, original)
    this.#entries.push({ placeholder: shaped, category, original })
    return shaped
  }

  /**
   * File the entries the machine's mapping file recorded, so text written before
   * a restart still restores.
   *
   * The entries do NOT enter this process's own tables: {@link #entries} stays
   * what this process issued, which is what {@link liveEntries} hands to the
   * writer. What they do contribute here is the counter position — {@link #seed}
   * keeps every fresh value from taking a number one of them already used.
   * @param entries Entries read from disk, in the order they were written.
   */
  adopt(entries: readonly RedactionEntry[]): void {
    for (const entry of entries) {
      this.#seed(entry.category, entry.placeholder)
      if (this.#filed.some(known => known.placeholder === entry.placeholder)) continue
      this.#filed.push({ placeholder: entry.placeholder, category: entry.category, original: entry.original })
      const shaped = codeShape(entry.placeholder)
      if (!this.#filedOriginal.has(entry.original)) this.#filedOriginal.set(entry.original, shaped)
    }
  }

  /**
   * Raise the counter that covers one placeholder an earlier process issued.
   * Without this a value first seen after a restart takes a number an older file
   * already gave to something else, and one of the two restores wrong.
   * @param category Category the entry was recorded under.
   * @param placeholder Placeholder from a mapping file: numbered or grouped.
   */
  #seed(category: string, placeholder: string): void {
    // The group form is tried first: `[公司1-1]` also fits the numbered pattern,
    // read as label `公司1` with sequence `1`, and would raise the wrong counter.
    const groupedFirst = /^\[[^\[\]\d]+\d+-\d+\]$/.test(placeholder)
    const numbered = groupedFirst ? null : /^\[(?<label>.+)-(?<sequence>\d{1,6})\]$/.exec(placeholder)
    if (numbered?.groups !== undefined) {
      const label = numbered.groups['label'] as string
      const sequence = Number(numbered.groups['sequence'])
      this.#counters.set(label, Math.max(this.#counters.get(label) ?? 0, sequence))
      return
    }
    // A grouped placeholder (`[公司<n>-<m>]`) records no group key, only the
    // spare number, so a company never met before still takes a free one.
    const grouped = /^\[[^\[\]\d]+(?<group>\d+)-(?<spelling>\d+)\]$/.exec(placeholder)
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
   * @returns The text with the placeholders it carries restored.
   */
  restore(text: string): string {
    const table = this.#tableFor()
    if (table.size === 0) return text
    // Every placeholder is bracketed, so one pattern covers both the numbered
    // form (`[工艺-1]`) and the group form (`[公司1-1]`). A code without a
    // sequence (`[A]`) is spliced back by its exact bracketed text.
    let restored = text.replace(/\[[^\]\n]{1,32}-\d{1,6}\]/g, match => table.get(match) ?? match)
    for (const [code, original] of table) {
      if (!code.startsWith('[') || !restored.includes(code)) continue
      restored = restored.split(code).join(original)
    }
    return restored
  }

  /**
   * The lookup one restore runs against: every pairing the machine's file
   * recorded, plus everything this process issued.
   * @returns Placeholder (in the shape it wears in text) to original.
   */
  #tableFor(): ReadonlyMap<string, string> {
    if (this.#filed.length === 0) return this.#byPlaceholder
    const merged = new Map(this.#byPlaceholder)
    for (const entry of this.#filed) {
      const shaped = codeShape(entry.placeholder)
      // A live entry for the same shape wins: this process issued it and knows
      // what it stands for right now.
      if (!merged.has(shaped)) merged.set(shaped, entry.original)
    }
    return merged
  }

  /** Distinct values this process has replaced. */
  get size(): number {
    return this.#byOriginal.size
  }

  /**
   * Every pairing a reader can use: what the machine's file recorded, then what
   * this process issued.
   * @returns The recorded entries; empty before the first replacement.
   */
  entries(): readonly RedactionEntry[] {
    if (this.#filed.length === 0) return this.#entries
    const seen = new Set(this.#filed.map(entry => entry.placeholder))
    return [...this.#filed, ...this.#entries.filter(entry => !seen.has(entry.placeholder))]
  }

  /**
   * Everything this process replaced, in the order it was first seen — the part
   * the writer still has to append.
   * @returns The recorded entries; empty before the first replacement.
   */
  liveEntries(): readonly RedactionEntry[] {
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
    this.#filed.length = 0
    this.#filedOriginal.clear()
  }
}
