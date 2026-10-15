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

/** Hand out placeholders, resolve them back, and remember nothing after a restart. */
export class RedactionMap {
  readonly #byOriginal = new Map<string, string>()
  readonly #byPlaceholder = new Map<string, string>()
  readonly #counters = new Map<string, number>()
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
    return text.replace(/\[[^\]\n]{1,32}-\d{1,6}\]/g, match => this.#byPlaceholder.get(match) ?? match)
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

  /** Forget every placeholder and value, returning the map to its initial state. */
  clear(): void {
    this.#byOriginal.clear()
    this.#byPlaceholder.clear()
    this.#counters.clear()
    this.#entries.length = 0
  }
}
