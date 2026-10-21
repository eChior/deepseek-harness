/**
 * Display-safe snapshots the redaction namespace publishes.
 *
 * The types are declared here rather than reused from the provider on purpose:
 * the analyzer behind the Remote boundary walks the declarations of a public
 * type subpath, and a subpath that only re-exports another module leaves it
 * without a declaration of its own.
 *
 * Nothing here describes session text. A status is counts and fixed state
 * names, an upload is a file the user wrote and can already read, and a roster
 * summary is a headcount.
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
  /** Uploaded lists that compiled into the rules in force. */
  readonly localFiles: number
  /** Names the staff directory contributed to the rules. */
  readonly roster: number
  /** Whether an ended session writes its placeholder table to the local mappings directory. */
  readonly mappings: boolean
  /** Whether the read-image tool is denied for every agent of this deployment. */
  readonly imageTool: boolean
}

/** One term list a department uploaded to this machine. */
export interface RedactionUploadView {
  /** File name the upload is stored under. */
  readonly name: string
  /** Size on disk, in bytes. */
  readonly bytes: number
  /** Revision the uploaded list declares. */
  readonly revision: string
  /** Department the upload is attributed to, or null when it declares none. */
  readonly department: string | null
  /** Person the upload is attributed to, or null when it declares none. */
  readonly author: string | null
  /** False when the upload is kept on disk but not in force. */
  readonly enabled: boolean
  /** Term entries the upload declares. */
  readonly terms: number
  /** Regular expressions the upload declares. */
  readonly patterns: number
  /** Why the upload cannot take part, one `line: message` per problem; empty when it can. */
  readonly problems: readonly string[]
}

/**
 * What the staff directory contributes, and what it says about the caller.
 *
 * The caller's own department is here because it is the one field an upload
 * cannot be expected to carry by hand: the directory already knows it, and the
 * account the person signed in with is the only key needed to look it up.
 */
export interface RedactionRosterView {
  /** False when this deployment turned the directory off. */
  readonly enabled: boolean
  /** Revision stamp the directory was built with, or null when it is not loaded. */
  readonly revision: string | null
  /** Colleagues the directory lists. */
  readonly people: number
  /** Departments the directory lists. */
  readonly departments: number
  /** Department the signed-in account belongs to, or null when nobody is signed in or the directory does not list them. */
  readonly department: string | null
  /** Employee number of the signed-in account, or null under the same conditions. */
  readonly employeeId: string | null
  /** Name the account service reports, or null when nobody is signed in. */
  readonly account: string | null
}

/** The example a department can download and start from. */
export interface RedactionExampleView {
  /** File name the download should carry. */
  readonly name: string
  /** The example term list, exactly as it ships. */
  readonly text: string
}

/** One placeholder this machine issued, and the value it stands for. */
export interface RedactionEntryView {
  /** Placeholder as it appears in session text: numbered, or the fixed code. */
  readonly placeholder: string
  /** Category the placeholder belongs to. */
  readonly category: string
  /** The value the model must not see but the user may. */
  readonly original: string
}
