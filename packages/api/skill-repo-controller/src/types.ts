/**
 * Wire shapes for the skill publishing surface: what this machine can publish,
 * and what one upload did.
 * @module @deepseek-ai/dsh-api-skill-repo-controller/types
 */

/** One skill on this machine, as the settings page lists it. */
export interface SkillRepoLocalView {
  /** Directory name under the skills root. */
  readonly name: string
  /** First sentence of the skill's own description, or its title. */
  readonly description: string | null
  /** How many files an upload would carry. */
  readonly files: number
  /** Total size of those files. */
  readonly bytes: number
}

/** What publishing one skill did. */
export interface SkillRepoUploadView {
  /** Directory name under the skills root. */
  readonly name: string
  /** Files written as new repository paths. */
  readonly written: number
  /** Files whose published bytes already matched. */
  readonly unchanged: number
  /** Repository paths that already hold different bytes; never overwritten. */
  readonly conflicts: readonly string[]
  /** Files skipped because one request cannot carry them. */
  readonly skipped: readonly string[]
}

/**
 * One row of the publishing page: this machine's copy beside the repository's,
 * which is what decides between publishing, replacing and deleting.
 */
export interface SkillRepoEntryView {
  readonly name: string
  readonly description: string | null
  readonly version: string | null
  readonly files: number
  readonly bytes: number
  /** `new` when the repository holds nothing, `published` when both agree. */
  readonly state: 'new' | 'published' | 'ahead' | 'behind'
  readonly publishedVersion: string | null
  readonly department: string | null
  readonly uploader: string | null
  readonly uploadedAt: string | null
  /** Whether the signed-in colleague published the copy the repository holds. */
  readonly owned: boolean
}

/** One department skill the repository holds, as the page lists them. */
export interface SkillRepoDepartmentView {
  readonly name: string
  readonly department: string
  readonly version: string | null
  readonly description: string | null
  readonly uploader: string | null
  readonly uploadedAt: string | null
  readonly files: number
}
