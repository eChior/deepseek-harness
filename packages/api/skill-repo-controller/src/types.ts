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
