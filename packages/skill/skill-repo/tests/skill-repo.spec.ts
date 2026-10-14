import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import * as SkillRepo from '../src/index.ts'
import { cloneRepository, describeRevision, isRepository, updateRepository } from '../src/git.ts'

const run = promisify(execFile)

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  tempDirs.push(dir)
  return dir
}

/** A local repository holding one skill, usable as a clone source. */
async function originRepo(): Promise<string> {
  const dir = await tempDir('skill-origin')
  await run('git', ['init', '--quiet', '--initial-branch=main', dir])
  await run('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'Test'])
  await mkdir(join(dir, 'skills', 'demo'), { recursive: true })
  await writeFile(join(dir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: A demo skill.\n---\n\nBody.\n')
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '--quiet', '-m', 'initial'])
  return dir
}

describe('skillsDirectoryPath', () => {
  it('joins the mirror and the skills subdirectory', () => {
    expect(SkillRepo.skillsDirectoryPath({ directory: '/mirror', skillsDirectory: 'skills' })).toBe(join('/mirror', 'skills'))
  })

  it('falls back to the DSH home and the default subdirectory', () => {
    const path = SkillRepo.skillsDirectoryPath()
    expect(path.endsWith(join('skills-repo', 'skills'))).toBe(true)
  })
})

describe('Config', () => {
  it('defaults to the distribution skill repository', () => {
    const config = new SkillRepo.Config({})
    expect(config.url).toBe('http://10.151.5.175:3000/ITPublic/dsh-skills.git')
    expect(config.branch).toBe('main')
    expect(config.skillsDirectory).toBe('skills')
    expect(config.enabled).toBe(true)
  })
})

describe('git helpers', () => {
  it('clones a branch and reports its revision', async () => {
    const origin = await originRepo()
    const mirror = join(await tempDir('skill-mirror'), 'repo')
    expect(isRepository(mirror)).toBe(false)
    await cloneRepository(origin, mirror, 'main', 60_000)
    expect(isRepository(mirror)).toBe(true)
    expect(await describeRevision(mirror, 60_000)).toMatch(/^[0-9a-f]{7,}$/u)
  })

  it('fast-forwards an existing mirror onto the remote tip', async () => {
    const origin = await originRepo()
    const mirror = join(await tempDir('skill-mirror'), 'repo')
    await cloneRepository(origin, mirror, 'main', 60_000)
    const before = await describeRevision(mirror, 60_000)
    await writeFile(join(origin, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Changed.\n---\n\nBody.\n')
    await run('git', ['-C', origin, 'add', '-A'])
    await run('git', ['-C', origin, 'commit', '--quiet', '-m', 'second'])
    await updateRepository(mirror, 'main', 60_000)
    expect(await describeRevision(mirror, 60_000)).not.toBe(before)
  })
})

describe('SkillRepository', () => {
  it('mirrors the repository named in its configuration', async () => {
    const origin = await originRepo()
    const directory = join(await tempDir('skill-home'), 'skills-repo')
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, { url: origin, directory, skillsDirectory: 'skills' })
    const repo = ctx.skillRepo
    const status = await repo.sync()
    expect(status.state).toBe('ready')
    expect(status.revision).not.toBeNull()
    expect(isRepository(directory)).toBe(true)
    expect(repo.status.skillsDirectory).toBe(join(directory, 'skills'))
    await fiber.dispose()
  })

  it('reports a failure instead of throwing when the remote is unreachable', async () => {
    const missing = join(await tempDir('skill-home'), 'nope', 'repo')
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, { url: missing, directory: join(missing, 'mirror') })
    const status = await ctx.skillRepo.sync()
    expect(status.state).toBe('failed')
    expect(status.detail).not.toBeNull()
    await fiber.dispose()
  })

  it('touches nothing when disabled', async () => {
    const directory = join(await tempDir('skill-home'), 'skills-repo')
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, { enabled: false, directory, url: '/does/not/exist' })
    expect(isRepository(directory)).toBe(false)
    expect(ctx.skillRepo.status.state).toBe('idle')
    await fiber.dispose()
  })
})
