import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeManifest } from '../src/index.ts'
import {
  UPLOADER_FILE,
  departmentManifest,
  encodePath,
  giteaTarget,
  readSkillDirectory,
  uploadSkillFiles,
} from '../src/upload.ts'

/** Repository URL this distribution mirrors. */
const REMOTE = 'http://10.151.5.175:3000/ITPublic/dsh-skills.git'

describe('giteaTarget', () => {
  it('reads the API root and both path segments', () => {
    expect(giteaTarget(REMOTE)).toEqual({
      api: 'http://10.151.5.175:3000/api/v1',
      owner: 'ITPublic',
      repo: 'dsh-skills',
    })
  })

  it('accepts a URL without the git suffix and with a trailing slash', () => {
    expect(giteaTarget('https://github.com/acme/skills/')).toEqual({
      api: 'https://github.com/api/v1',
      owner: 'acme',
      repo: 'skills',
    })
  })

  it('refuses a remote that is not HTTP', () => {
    expect(giteaTarget('git@10.151.5.175:ITPublic/dsh-skills.git')).toBeUndefined()
  })
})

describe('encodePath', () => {
  it('escapes each segment and keeps the separators', () => {
    expect(encodePath('研发部/a b.md')).toBe('%E7%A0%94%E5%8F%91%E9%83%A8/a%20b.md')
  })
})

describe('readSkillDirectory', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'skill-upload-'))
    await writeFile(join(directory, 'SKILL.md'), '# demo\n', 'utf8')
    await mkdir(join(directory, 'scripts'))
    await writeFile(join(directory, 'scripts', 'run.py'), 'print(1)\n', 'utf8')
    await mkdir(join(directory, 'node_modules'))
    await writeFile(join(directory, 'node_modules', 'ignored.js'), 'x\n', 'utf8')
    await mkdir(join(directory, '.git'))
    await writeFile(join(directory, '.git', 'config'), 'x\n', 'utf8')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('collects the skill files and skips the tool directories', async () => {
    const contents = await readSkillDirectory(directory)
    expect(contents.files.map(file => file.path)).toEqual(['SKILL.md', 'scripts/run.py'])
    expect(contents.skipped).toEqual([])
  })

  it('leaves out a file one request cannot carry', async () => {
    await writeFile(join(directory, 'huge.bin'), Buffer.alloc(1024 * 1024 + 1), 'utf8')
    const contents = await readSkillDirectory(directory)
    expect(contents.skipped).toEqual(['huge.bin'])
    expect(contents.files.map(file => file.path)).toEqual(['SKILL.md', 'scripts/run.py'])
  })
})

describe('uploadSkillFiles', () => {
  const target = { api: 'http://host/api/v1', owner: 'ITPublic', repo: 'dsh-skills' }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes a new path, leaves an identical one and refuses a different one', async () => {
    const calls: string[] = []
    const published = new Map<string, string>([
      ['研发部/demo/SAME.md', Buffer.from('same').toString('base64')],
      ['研发部/demo/OTHER.md', Buffer.from('theirs').toString('base64')],
    ])
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const path = decodeURIComponent(url.split('/contents/')[1]?.split('?')[0] ?? '')
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}') as { content: string }
        published.set(path, body.content)
        return { ok: true, status: 201, json: async () => ({}) }
      }
      const stored = published.get(path)
      return stored === undefined
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ content: stored }) }
    })
    const outcome = await uploadSkillFiles({
      target,
      token: 'secret',
      branch: 'main',
      directory: '研发部/demo',
      contents: {
        files: [
          { path: 'NEW.md', bytes: new TextEncoder().encode('new') },
          { path: 'SAME.md', bytes: new TextEncoder().encode('same') },
          { path: 'OTHER.md', bytes: new TextEncoder().encode('mine') },
        ],
        skipped: ['huge.bin'],
      },
      message: 'skill: demo by 毛子艺 (研发部)',
    })
    expect(outcome).toEqual({
      written: 1,
      unchanged: 1,
      conflicts: ['研发部/demo/OTHER.md'],
      skipped: ['huge.bin'],
    })
    expect(calls.filter(call => call.startsWith('POST'))).toHaveLength(1)
  })

  it('names the uploader file as the record of who published', () => {
    expect(UPLOADER_FILE).toBe('.uploader.json')
  })
})

describe('describeManifest', () => {
  it('prefers the front matter description', () => {
    expect(describeManifest('---\nname: demo\ndescription: 整理工艺数据\n---\n# Demo\n')).toBe('整理工艺数据')
  })

  it('falls back to the first prose line after the heading', () => {
    expect(describeManifest('# Demo\n\n读一遍再写一遍。\n')).toBe('读一遍再写一遍。')
  })

  it('returns undefined when the manifest explains nothing', () => {
    expect(describeManifest('# Demo\n')).toBeUndefined()
  })
})

describe('departmentManifest', () => {
  const manifest = (body: string): Uint8Array => new TextEncoder().encode(body)

  it('writes the department into the name the skills manager reads', () => {
    const bytes = manifest('---\nname: proposal-scoring\ndescription: 打分\n---\n\n# 打分\n')
    const text = new TextDecoder().decode(departmentManifest(bytes, '研发部', 'proposal-scoring', '毛子艺'))
    expect(text).toContain('name: 研发部-proposal-scoring')
    expect(text).toContain('# 打分')
  })

  it('names the department and the colleague ahead of the description', () => {
    const bytes = manifest('---\nname: proposal-scoring\ndescription: 打分\n---\n')
    const text = new TextDecoder().decode(departmentManifest(bytes, '研发部', 'proposal-scoring', '毛子艺'))
    expect(text).toContain('description: [研发部 · 毛子艺] 打分')
  })

  it('keeps the quotes a description was written with', () => {
    const bytes = manifest('---\nname: proposal-scoring\ndescription: "打分"\n---\n')
    const text = new TextDecoder().decode(departmentManifest(bytes, '研发部', 'proposal-scoring', '毛子艺'))
    expect(text).toContain('description: "[研发部 · 毛子艺] 打分"')
  })

  it('adds a name when the manifest carries none', () => {
    const bytes = manifest('---\ndescription: 打分\n---\n')
    const text = new TextDecoder().decode(departmentManifest(bytes, '研发部', 'proposal-scoring', '毛子艺'))
    expect(text.startsWith('---\nname: 研发部-proposal-scoring\n')).toBe(true)
  })

  it('leaves a manifest without frontmatter untouched', () => {
    const bytes = manifest('# 打分\n')
    expect(new TextDecoder().decode(departmentManifest(bytes, '研发部', 'proposal-scoring', '毛子艺'))).toBe('# 打分\n')
  })

  it('does not repeat a stamp the manifest already carries', () => {
    const bytes = manifest('---\nname: 研发部-proposal-scoring\ndescription: [研发部 · 毛子艺] 打分\n---\n')
    const text = new TextDecoder().decode(departmentManifest(bytes, '研发部', 'proposal-scoring', '毛子艺'))
    expect(text).toBe('---\nname: 研发部-proposal-scoring\ndescription: [研发部 · 毛子艺] 打分\n---\n')
  })
})
