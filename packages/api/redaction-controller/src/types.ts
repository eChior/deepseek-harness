/**
 * Display-safe snapshot of the redaction provider.
 *
 * The type is declared here rather than reused from the provider on purpose:
 * the analyzer behind the Remote boundary walks the declarations of a public
 * type subpath, and a subpath that only re-exports another module leaves it
 * without a declaration of its own. Every field is a count, an identifier, or
 * a fixed state name; the text that was rewritten never rides along.
 *
 * @module @deepseek-ai/dsh-api-redaction-controller/types
 */

/** What the provider has loaded and how much it has replaced so far. */
export interface RedactionStatusView {
  /** Always true: the provider has no off switch. */
  readonly enabled: boolean
  /** Revision the loaded term list declares. */
  readonly revision: string | null
  /** Term entries the loaded list declares. */
  readonly terms: number
  /** Regular expressions the loaded list declares. */
  readonly patterns: number
  /** Replacements this process has made since it started. */
  readonly replacements: number
  /** Which copy of the list the loaded rules came from. */
  readonly source: 'bundled' | 'cache' | 'remote'
  /** When the publisher was last asked, as an ISO timestamp. */
  readonly lastChecked: string | null
  /** Why the last refresh kept the rules it already had. */
  readonly lastError: string | null
  /** Why nothing is being replaced, when a list could not be loaded at all. */
  readonly detail: string | null
  /** Term requests waiting on this machine for a delivery target. */
  readonly pending: number
}
