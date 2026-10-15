import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import * as SkillRepo from '../src/index.ts'
import { archiveCoordinates, archiveUrl, branchRevision, readArchive, writeArchive } from '../src/archive.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
/** Every HTTP server started by this file, closed after each test. */
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => { server.close(() => { done() }) })
  }
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  tempDirs.push(dir)
  return dir
}

/** NUL byte, spelled without an octal escape that an ES module rejects. */
const NUL = String.fromCharCode(0)

/** One tar header plus its padded payload, enough for this reader's fields. */
function tarEntry(name: string, content: Buffer, kind = '0'): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'utf8')
  header.write('0000000\0', 108, 8, 'utf8')
  header.write('0000000\0', 116, 8, 'utf8')
  header.write(`${content.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
  header.write('00000000000\0', 136, 12, 'utf8')
  header.write(kind, 156, 1, 'utf8')
  header.write(`ustar${NUL}`, 257, 6, 'latin1')
  header.write('00', 263, 2, 'utf8')
  const padded = Buffer.alloc(Math.ceil(content.byteLength / 512) * 512)
  content.copy(padded)
  return Buffer.concat([header, padded])
}

/** A `<repository>-<branch>/…` archive holding one skill, as gitea serves it. */
function giteaArchive(): Buffer {
  return Buffer.concat([
    tarEntry('dsh-skills-main/', Buffer.alloc(0), '5'),
    tarEntry('dsh-skills-main/README.md', Buffer.from('# skills\n', 'utf8')),
    tarEntry('dsh-skills-main/skills/', Buffer.alloc(0), '5'),
    tarEntry('dsh-skills-main/skills/demo/', Buffer.alloc(0), '5'),
    tarEntry('dsh-skills-main/skills/demo/SKILL.md', Buffer.from('---\nname: demo\n---\n', 'utf8')),
    Buffer.alloc(1024),
  ])
}

interface Origin {
  readonly remote: string
  readonly archiveRequests: string[]
}

/** A local gitea stand-in serving one archive per request, then one branch record. */
async function origin(archives: Buffer[] = [giteaArchive()]): Promise<Origin> {
  const archiveRequests: string[] = []
  const server = createServer((request, response) => {
    if (request.url === '/api/v1/repos/ITPublic/dsh-skills/branches/main') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ commit: { id: 'abc1234def' } }))
      return
    }
    archiveRequests.push(request.url ?? '')
    if (request.url === '/ITPublic/dsh-skills/archive/main.tar.gz') {
      response.writeHead(200, { 'content-type': 'application/gzip' })
      response.end(gzipSync(archives[Math.min(archiveRequests.length - 1, archives.length - 1)] ?? giteaArchive()))
      return
    }
    response.writeHead(404)
    response.end()
  })
  servers.push(server)
  await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', ready) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the test origin has no port')
  return { remote: `http://127.0.0.1:${String(address.port)}/ITPublic/dsh-skills.git`, archiveRequests }
}

describe('archiveUrl', () => {
  it('turns a git remote into the branch archive beside it', () => {
    expect(archiveUrl('http://host:3000/ITPublic/dsh-skills.git', 'main'))
      .toBe('http://host:3000/ITPublic/dsh-skills/archive/main.tar.gz')
  })

  it('accepts a remote without the .git suffix', () => {
    expect(archiveUrl('http://host:3000/ITPublic/dsh-skills/', 'dev'))
      .toBe('http://host:3000/ITPublic/dsh-skills/archive/dev.tar.gz')
  })
})

describe('archiveCoordinates', () => {
  it('splits a remote into the API origin and the repository path', () => {
    expect(archiveCoordinates('http://host:3000/ITPublic/dsh-skills.git'))
      .toEqual({ api: 'http://host:3000', repository: 'ITPublic/dsh-skills' })
  })

  it('reports nothing for a remote it cannot address', () => {
    expect(archiveCoordinates('/srv/git/skills.git')).toBeUndefined()
  })
})

describe('readArchive', () => {
  it('strips the wrapping directory and reports directories separately', () => {
    const entries = readArchive(giteaArchive(), 0)
    expect(entries.map(entry => entry.path)).toEqual([
      'dsh-skills-main',
      'dsh-skills-main/README.md',
      'dsh-skills-main/skills',
      'dsh-skills-main/skills/demo',
      'dsh-skills-main/skills/demo/SKILL.md',
    ])
    expect(entries[0]?.directory).toBe(true)
    expect(entries[4]?.directory).toBe(false)
    expect(entries[4]?.content.toString('utf8')).toBe('---\nname: demo\n---\n')
  })

  it('honours long names recorded in a separate record', () => {
    const long = 'dsh-skills-main/skills/demo/'.padEnd(120, 'x')
    const tar = Buffer.concat([
      tarEntry('././@LongLink', Buffer.from(`${long}/SKILL.md\0`, 'utf8'), 'L'),
      tarEntry('dsh-skills-main/skills/demo/placeholder', Buffer.from('body\n', 'utf8')),
      Buffer.alloc(1024),
    ])
    const entries = readArchive(tar, 1)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.path.endsWith('SKILL.md')).toBe(true)
  })

  it('drops every path inside the stripped components', () => {
    const tar = Buffer.concat([tarEntry('dsh-skills-main/', Buffer.alloc(0), '5'), Buffer.alloc(1024)])
    expect(readArchive(tar, 1)).toEqual([])
  })

  it('stops at the first blank block pair', () => {
    const tar = Buffer.concat([
      tarEntry('root/keep.md', Buffer.from('kept\n', 'utf8')),
      Buffer.alloc(512),
      Buffer.alloc(512),
      tarEntry('root/ignored.md', Buffer.from('ignored\n', 'utf8')),
    ])
    expect(readArchive(tar, 1).map(entry => entry.path)).toEqual(['keep.md'])
  })
})

describe('writeArchive', () => {
  it('creates directories and files below the destination', async () => {
    const root = await tempDir('skill-write')
    await writeArchive(readArchive(giteaArchive(), 1), root)
    expect((await stat(join(root, 'skills', 'demo'))).isDirectory()).toBe(true)
    expect(await readFile(join(root, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('---\nname: demo\n---\n')
  })

  it('refuses entries that would escape the destination', async () => {
    const root = await tempDir('skill-escape')
    await writeArchive([{ path: '../outside.md', content: Buffer.from('nope\n', 'utf8'), directory: false }], root)
    await expect(readFile(join(root, '..', 'outside.md'), 'utf8')).rejects.toThrow()
  })
})

describe('branchRevision', () => {
  it('reads the commit the branch points at', async () => {
    const { remote } = await origin()
    expect(await branchRevision(remote, 'main', 5_000)).toBe('abc1234def')
  })

  it('reports nothing when the host does not answer', async () => {
    expect(await branchRevision('http://127.0.0.1:1/nobody/nothing.git', 'main', 500)).toBeNull()
  })
})

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

describe('SkillRepository', () => {
  it('unpacks the branch archive into the mirror without a git binary', async () => {
    const { remote, archiveRequests } = await origin()
    const home = await tempDir('skill-home')
    const directory = join(home, 'skills-repo')
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, { url: remote, directory, skillsDirectory: 'skills', publishDirectory: join(home, 'skills') })
    const status = await ctx.skillRepo.sync()
    expect(status.state).toBe('ready')
    expect(status.revision).toBe('abc1234def')
    expect(archiveRequests).toEqual(['/ITPublic/dsh-skills/archive/main.tar.gz'])
    expect(await readFile(join(directory, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('---\nname: demo\n---\n')
    expect(status.skillsDirectory).toBe(join(directory, 'skills'))
    expect(await readFile(join(home, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('---\nname: demo\n---\n')
    await fiber.dispose()
  })

  it('replaces an older mirror and leaves no staging directory behind', async () => {
    const { remote } = await origin()
    const home = await tempDir('skill-home')
    const directory = join(home, 'skills-repo')
    await writeFile(join(home, 'placeholder'), '')
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, { url: remote, directory, skillsDirectory: 'skills', publishDirectory: join(home, 'skills') })
    await ctx.skillRepo.sync()
    const status = await ctx.skillRepo.sync()
    expect(status.state).toBe('ready')
    await expect(stat(`${directory}.staging`)).rejects.toThrow()
    await fiber.dispose()
  })

  it('publishes every synced skill into the user skill root', async () => {
    const { remote } = await origin()
    const home = await tempDir('skill-home')
    const published = join(home, 'skills')
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, { url: remote, directory: join(home, 'skills-repo'), publishDirectory: published })
    const status = await ctx.skillRepo.sync()
    expect(status.state).toBe('ready')
    expect(status.publishDirectory).toBe(published)
    expect(await readFile(join(published, 'demo', 'SKILL.md'), 'utf8')).toBe('---\nname: demo\n---\n')
    expect(JSON.parse(await readFile(join(home, '.dsh-skill-repo-published.json'), 'utf8'))).toEqual(['demo'])
    await fiber.dispose()
  })

  it('keeps a hand-written skill that shares a name with a synced one', async () => {
    const { remote } = await origin()
    const home = await tempDir('skill-home')
    const published = join(home, 'skills')
    await writeArchive([{ path: 'demo/SKILL.md', content: Buffer.from('mine\n', 'utf8'), directory: false }], published)
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, { url: remote, directory: join(home, 'skills-repo'), publishDirectory: published })
    const status = await ctx.skillRepo.sync()
    expect(status.state).toBe('ready')
    expect(await readFile(join(published, 'demo', 'SKILL.md'), 'utf8')).toBe('mine\n')
    await fiber.dispose()
  })

  it('drops a published skill the archive no longer carries', async () => {
    const emptied = Buffer.concat([
      tarEntry('dsh-skills-main/', Buffer.alloc(0), '5'),
      tarEntry('dsh-skills-main/skills/', Buffer.alloc(0), '5'),
      Buffer.alloc(1024),
    ])
    const { remote } = await origin([giteaArchive(), emptied])
    const home = await tempDir('skill-home')
    const published = join(home, 'skills')
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, { url: remote, directory: join(home, 'skills-repo'), publishDirectory: published })
    await ctx.skillRepo.sync()
    expect(await readFile(join(published, 'demo', 'SKILL.md'), 'utf8')).toBe('---\nname: demo\n---\n')
    const status = await ctx.skillRepo.sync()
    expect(status.state).toBe('ready')
    await expect(stat(join(published, 'demo'))).rejects.toThrow()
    await fiber.dispose()
  })

  it('falls back to the skills this build carries when no mirror exists yet', async () => {
    const home = await tempDir('skill-home')
    const published = join(home, 'skills')
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, {
      url: join(home, 'nope', 'repo'),
      directory: join(home, 'skills-repo'),
      publishDirectory: published,
    })
    const status = await ctx.skillRepo.sync()
    expect(status.state).toBe('ready')
    expect(status.source).toBe('bundled')
    expect(status.revision).toBeNull()
    expect(status.detail).not.toBeNull()
    expect(await readFile(join(published, 'tsd-reader', 'SKILL.md'), 'utf8')).toContain('tsd-reader')
    await fiber.dispose()
  })

  it('still reports a failure when this build carries no skills to fall back on', async () => {
    const home = await tempDir('skill-home')
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, {
      url: join(home, 'nope', 'repo'),
      directory: join(home, 'skills-repo'),
      bundledDirectory: join(home, 'no-such-bundled-copy'),
    })
    const status = await ctx.skillRepo.sync()
    expect(status.state).toBe('failed')
    expect(status.detail).not.toBeNull()
    await fiber.dispose()
  })

  it('keeps the existing mirror when a later sync fails', async () => {
    const home = await tempDir('skill-home')
    const directory = join(home, 'skills-repo')
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, { url: 'http://127.0.0.1:1/none.git', directory })
    await ctx.skillRepo.sync()
    await writeArchive([{ path: 'skills/demo/SKILL.md', content: Buffer.from('kept\n', 'utf8'), directory: false }], directory)
    const status = await ctx.skillRepo.sync()
    expect(status.state).toBe('failed')
    expect(await readFile(join(directory, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('kept\n')
    await fiber.dispose()
  })

  it('touches nothing when disabled', async () => {
    const directory = join(await tempDir('skill-home'), 'skills-repo')
    const ctx = new Context()
    const fiber = await ctx.plugin(SkillRepo.default, { enabled: false, directory, url: '/does/not/exist' })
    await expect(stat(directory)).rejects.toThrow()
    expect(ctx.skillRepo.status.state).toBe('idle')
    await fiber.dispose()
  })
})
