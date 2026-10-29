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
import type { SkillRepoLocalView, SkillRepoUploadView } from './types.ts'

/** One skill to publish, addressed by its directory name. */
const UploadRequest = z.object({ name: z.string().min(1).max(64) })

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
      files: skill.files,
      bytes: skill.bytes,
    }))
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
  async upload(request: { readonly name: string }): Promise<SkillRepoUploadView> {
    const parsed = UploadRequest.safeParse(request)
    if (!parsed.success) {
      const first = parsed.error.issues[0]?.message ?? 'invalid payload'
      throw new RemoteError('gateway/bad-request', `invalid payload for skillRepo.upload: ${first}`, {})
    }
    const outcome = await this.ctx.skillRepo.uploadSkill(parsed.data.name)
    return {
      name: outcome.name,
      written: outcome.written,
      unchanged: outcome.unchanged,
      conflicts: outcome.conflicts,
      skipped: outcome.skipped,
    }
  }
}

/** The loader mounts the class itself, matching the other Remote owners. */
export default SkillRepoController
