/**
 * Host Remote owner for publishing local skills: the list of skills this machine
 * can send, and the upload that sends one.
 *
 * The skill repository provider owns the files, the target and the identity
 * lookup; this controller only maps its records onto types the wire can carry.
 * No reply describes where a skill landed beyond its own name, so the surface
 * never becomes a way to enumerate the repository.
 *
 * @module @deepseek-ai/dsh-api-skill-repo-controller
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill-repo'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from 'zod'
import type {
  SkillRepoDepartmentView,
  SkillRepoEntryView,
  SkillRepoLocalView,
  SkillRepoUploadView,
} from './types.ts'

/** One skill to publish, addressed by its directory name. */
const UploadRequest = z.object({
  name: z.string().min(1).max(64),
  /** `new` refuses to replace an existing copy; `update` replaces it. */
  mode: z.enum(['new', 'update']).default('new'),
})

/** One published skill to delete, addressed by its directory name. */
const RemoveRequest = z.object({ name: z.string().min(1).max(64) })

/**
 * Read and publish skills over Remote.
 *
 * A failed upload is a caller-visible failure, not a silent no-op: the page has
 * to tell a colleague whether their skill arrived, and "nothing happened" is the
 * one answer it cannot show.
 */
export class SkillRepoController extends TypertRemoteService {
  /** Required service: the provider that owns the mirror and the publishing seam. */
  static inject = ['skillRepo']

  /**
   * @param ctx - Host with the skill repository provider mounted.
   */
  constructor(ctx: Context) {
    super(ctx, 'skillRepoController', { namespace: 'skillRepo' })
  }

  /**
   * List the skills this machine can publish.
   * @returns One entry per skill under the publish root that carries a `SKILL.md`.
   */
  @Remote
  async skills(): Promise<readonly SkillRepoLocalView[]> {
    const skills = await this.ctx.skillRepo.localSkills()
    return skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      version: skill.version,
      files: skill.files,
      bytes: skill.bytes,
    }))
  }

  /**
   * This machine's skills beside what the repository already holds.
   * @returns One row per local skill, sorted by name.
   */
  @Remote
  async entries(): Promise<readonly SkillRepoEntryView[]> {
    const rows = await this.ctx.skillRepo.skillEntries()
    return rows.map(row => ({
      name: row.name,
      description: row.description,
      version: row.version,
      files: row.files,
      bytes: row.bytes,
      state: row.state,
      publishedVersion: row.publishedVersion,
      department: row.department,
      uploader: row.uploader,
      uploadedAt: row.uploadedAt,
      owned: row.owned,
    }))
  }

  /**
   * Every department skill the repository holds, so a colleague can see what
   * other departments published without opening the repository by hand.
   * @returns One entry per published department skill.
   */
  @Remote
  async departments(): Promise<readonly SkillRepoDepartmentView[]> {
    return await this.ctx.skillRepo.departmentSkills()
  }

  /**
   * Publish one local skill into this deployment's repository.
   *
   * The provider files it under the signed-in colleague's department and records
   * who sent it; a path that already exists with different bytes is reported and
   * left alone, so uploading never rewrites someone else's skill.
   * @param request - The skill directory name.
   * @returns What the upload wrote, what already matched, and what was refused.
   */
  @Remote
  async upload(request: { readonly name: string; readonly mode?: 'new' | 'update' }): Promise<SkillRepoUploadView> {
    const parsed = UploadRequest.safeParse(request)
    if (!parsed.success) {
      const first = parsed.error.issues[0]?.message ?? 'invalid payload'
      throw new RemoteError('gateway/bad-request', `invalid payload for skillRepo.upload: ${first}`, {})
    }
    const outcome = await this.ctx.skillRepo.uploadSkill(parsed.data.name, parsed.data.mode)
    return {
      name: outcome.name,
      written: outcome.written,
      unchanged: outcome.unchanged,
      conflicts: outcome.conflicts,
      skipped: outcome.skipped,
    }
  }
  /**
   * Delete this colleague's own copy of one skill.
   *
   * Only the publisher can remove it: the stamp beside the files is the record
   * of who sent them, and a copy published by someone else stays.
   * @param request - The skill directory name.
   * @returns How many files were removed.
   */
  @Remote
  async drop(request: { readonly name: string }): Promise<number> {
    const parsed = RemoveRequest.safeParse(request)
    if (!parsed.success) {
      const first = parsed.error.issues[0]?.message ?? 'invalid payload'
      throw new RemoteError('gateway/bad-request', `invalid payload for skillRepo.drop: ${first}`, {})
    }
    return await this.ctx.skillRepo.removeSkill(parsed.data.name)
  }
}

/** The loader mounts the class itself, matching the other Remote owners. */
export default SkillRepoController
