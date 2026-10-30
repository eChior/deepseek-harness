import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as SkillRepo from '../src/index.ts'

/** Temp roots created here, removed after each case. */
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

/** A temp home plus the manifest name the provider keeps beside it. */
async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-skills-'))
  roots.push(root)
  return root
}

/** A directory that looks like a skill to the provider. */
async function skill(directory: string, name: string, version: string): Promise<void> {
  const target = join(directory, name)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), `---\nname: ${name}\nversion: ${version}\n---\n\n# ${name}\n`, 'utf8')
}

describe('localSkills', () => {
  it('offers what somebody wrote here and hides what the repository handed down', async () => {
    const root = await home()
    const published = join(root, 'skills')
    const repository = join(root, 'repository')
    await skill(published, 'improvement-proposal', '0.1.2')
    await skill(published, 'hand-written', '1.0.0')
    await writeFile(
      join(dirname(repository), '.dsh-skill-repo-published.json'),
      `${JSON.stringify(['improvement-proposal'], null, 2)}\n`,
      'utf8',
    )

    const ctx = new Context()
    await ctx.plugin(SkillRepo.default, { url: 'http://127.0.0.1:1/none/none.git', directory: repository, publishDirectory: published })

    const listed = await ctx.skillRepo.localSkills()

    expect(listed.map(entry => entry.name)).toEqual(['hand-written'])
  })

  it('offers every skill while no manifest has been written yet', async () => {
    const root = await home()
    const published = join(root, 'skills')
    await skill(published, 'first', '0.1.0')
    await skill(published, 'second', '0.2.0')

    const ctx = new Context()
    await ctx.plugin(SkillRepo.default, { url: 'http://127.0.0.1:1/none/none.git', directory: join(root, 'repository'), publishDirectory: published })

    const listed = await ctx.skillRepo.localSkills()

    expect(listed.map(entry => entry.name)).toEqual(['first', 'second'])
  })
})
