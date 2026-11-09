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
  /** Department lists that applied to this reader. */
  readonly departments: number
  /** Names the staff directory contributed to the rules. */
  readonly roster: number
  /** Whether an ended session writes its placeholder table to the local mappings directory. */
  readonly mappings: boolean
  /** Whether the read-image tool is denied for every agent of this deployment. */
  readonly imageTool: boolean
  /** Which local reader reads an image, and whether the optional one is installed. */
  readonly ocr: RedactionVisionView
  /** Whether an attached picture is read as it arrives or only when the model asks. */
  readonly ocrMode: 'tool' | 'prompt'

  readonly ocrBackend: 'auto' | 'cpu' | 'gpu'
  /** Whether a document the model writes gets its placeholders replaced, and how that went. */
  readonly restore: RedactionRestoreView
  /** Multiplier applied to quantities, one-way; `1` leaves them alone. */
  readonly numberScale: number

  /** Whether the scale applies at all, so a scale of 1 can still be switched on. */
  readonly numberScaleOn: boolean
}

/** How the document write-back stands on this machine. */
export interface RedactionRestoreView {
  /** Whether a written document is repaired without asking. */
  readonly onWrite: boolean
  /** Why the last write-back could not run at all, or null when it ran. */
  readonly lastError: string | null
  /** What the last write-back found but left alone, such as an unmapped placeholder. */
  readonly lastResult: string | null
  /** Placeholders replaced in files on disk since this process started. */
  readonly files: number
}

/**
 * What one on-demand write-back did.
 *
 * Paths are absolute and originals never appear: a row names a file the user
 * already owns and the reason it was left alone, both display-safe.
 */
export interface RedactionRestorePassView {
  /** How many placeholders the pass replaced in total. */
  readonly restored: number
  /** One row per document the pass rewrote. */
  readonly files: readonly { readonly path: string; readonly hits: number }[]
  /** One row per document it looked at and left alone, with the reason. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
  /** Set when no interpreter could run or the pass failed outright. */
  readonly error?: string
}

/** Which local reader reads an image. */
export interface RedactionVisionView {
  /** Reader in force: the optional binary, or the platform engine. */
  readonly engine: 'paddle' | 'windows' | 'tesseract'
  /** Path of the reader in force; empty when this machine has none. */
  readonly path: string
  /** Whether that path holds a file. */
  readonly present: boolean
  readonly download: string
  /** Directory a downloaded reader is unpacked into to switch itself on. */
  readonly directory: string
  /** Which device the optional reader uses: measured on first run, or pinned. */
  readonly backend: 'auto' | 'cpu' | 'gpu'
}

/** One department list as the settings page lists it. */
export interface RedactionDepartmentView {
  /** Department the list belongs to. */
  readonly name: string
  /** Whether the list takes part in redaction for this reader. */
  readonly enabled: boolean
  /** Whether this is the department the signed-in colleague belongs to. */
  readonly own: boolean
  /** Term entries the list declares. */
  readonly terms: number
  /** Regular expressions the list declares. */
  readonly patterns: number
  /** Revision the list declares. */
  readonly revision: string
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
