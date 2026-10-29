import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  deleteSkillFiles,
  giteaTarget,
  parseSkillManifest,
  readDepartmentSkills,
  readRepositoryTree,
} from '../src/upload.ts'

/** Repository target every case here publishes to. */
const TARGET = giteaTarget('http://10.151.5.175:3000/ITPublic/dsh-skills.git')

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Answer one request with a fixed body, recording the URL it was asked for. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(handler(url, init))
  })
  return calls
}

/** A `SKILL.md` the way publishers write one. */
const MANIFEST = ['---', 'name: demo', 'description: 演示技能，用于测试。', 'version: 1.4.2', '---', '', '# Demo', ''].join('\n')

describe('parseSkillManifest', () => {
  it('reads the version and the description out of the frontmatter', () => {
    expect(parseSkillManifest(MANIFEST)).toEqual({ version: '1.4.2', description: '演示技能，用于测试。' })
  })

  it('answers two nulls for a file without a frontmatter block', () => {
    expect(parseSkillManifest('# Demo\n\nNo frontmatter here.\n')).toEqual({ version: null, description: null })
  })

  it('strips the quotes a publisher may have wrapped a value in', () => {
    const quoted = ['---', 'version: "2.0.0"', 'description: "带引号"', '---', ''].join('\n')
    expect(parseSkillManifest(quoted)).toEqual({ version: '2.0.0', description: '带引号' })
  })
})

describe('readRepositoryTree', () => {
  it('keeps the blobs and drops the tree entries', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({
      tree: [
        { path: 'skills', type: 'tree', sha: 'a' },
        { path: 'skills/demo/SKILL.md', type: 'blob', sha: 'b' },
        { path: 'skills/研发部/demo/SKILL.md', type: 'blob', sha: 'c' },
      ],
    }), { status: 200 }))
    const tree = await readRepositoryTree({ target: TARGET!, token: 't', branch: 'main' })
    expect(tree).toEqual([
      { path: 'skills/demo/SKILL.md', sha: 'b' },
      { path: 'skills/研发部/demo/SKILL.md', sha: 'c' },
    ])
    expect(calls[0]?.url).toContain('/git/trees/main?recursive=true')
  })

  it('answers an empty tree when the branch does not exist', async () => {
    stubFetch(() => new Response('{"message":"not found"}', { status: 404 }))
    expect(await readRepositoryTree({ target: TARGET!, token: 't', branch: 'main' })).toEqual([])
  })
})

describe('readDepartmentSkills', () => {
  const tree = [
    { path: 'skills/tsd-reader/SKILL.md', sha: 's1' },
    { path: 'skills/研发部/demo/SKILL.md', sha: 'd1' },
    { path: 'skills/研发部/demo/.uploader.json', sha: 'd2' },
    { path: 'skills/研发部/demo/references/sheet.md', sha: 'd3' },
  ]

  it('groups one department directory into one skill, with who published it', async () => {
    // The contents API answers base64, not the file itself.
    stubFetch(url => new Response(JSON.stringify({
      content: Buffer.from(url.includes('SKILL.md')
        ? MANIFEST
        : JSON.stringify({ name: 'demo', uploader: '毛子艺', uploadedAt: '2026-10-29T02:00:00Z' })).toString('base64'),
    }), { status: 200 }))
    const skills = await readDepartmentSkills({ target: TARGET!, token: 't', branch: 'main', tree, sharedRoot: 'skills' })
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'demo',
      department: '研发部',
      version: '1.4.2',
      uploader: '毛子艺',
      uploadedAt: '2026-10-29T02:00:00Z',
      files: [{ path: 'SKILL.md' }, { path: '.uploader.json' }, { path: 'references/sheet.md' }],
    })
  })

  it('leaves the shared skills tree out, because the mirror already publishes it', async () => {
    stubFetch(() => new Response(JSON.stringify({ content: Buffer.from(MANIFEST).toString('base64') }), { status: 200 }))
    const skills = await readDepartmentSkills({ target: TARGET!, token: 't', branch: 'main', tree, sharedRoot: 'skills' })
    expect(skills.map(skill => skill.department)).toEqual(['研发部'])
  })
})

describe('deleteSkillFiles', () => {
  it('deletes every file with the sha the tree handed out', async () => {
    const calls = stubFetch(() => new Response('{}', { status: 200 }))
    const removed = await deleteSkillFiles({
      target: TARGET!,
      token: 't',
      branch: 'main',
      directory: 'skills/研发部/demo',
      files: [{ path: 'SKILL.md', sha: 'd1' }, { path: '.uploader.json', sha: 'd2' }],
      message: 'remove demo',
    })
    expect(removed).toBe(2)
    expect(calls.map(call => call.init?.method)).toEqual(['DELETE', 'DELETE'])
    expect(calls[0]?.url).toContain('/contents/skills/%E7%A0%94%E5%8F%91%E9%83%A8/demo/SKILL.md')
    const body = calls[0]?.init?.body
    expect(body).toBeTypeOf('string')
    expect(JSON.parse(body as string)).toMatchObject({ sha: 'd1', branch: 'main' })
  })

  it('counts a file that is already gone as removed by the repository', async () => {
    stubFetch(() => new Response('{"message":"not found"}', { status: 404 }))
    const removed = await deleteSkillFiles({
      target: TARGET!,
      token: 't',
      branch: 'main',
      directory: 'skills/研发部/demo',
      files: [{ path: 'SKILL.md', sha: 'd1' }],
      message: 'remove demo',
    })
    expect(removed).toBe(0)
  })
})
