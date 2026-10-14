import { describe, expect, it, vi } from 'vitest'
import { newestReleaseTag, releaseDownloadUrl, resolveReleaseFeed } from '../src/update-source.ts'

describe('release feed resolution', () => {
  it('builds one download directory per tag and tolerates a trailing origin separator', () => {
    expect(releaseDownloadUrl('http://host:3000', 'ITPublic/deepseek-harness', 'v1.2.3'))
      .toBe('http://host:3000/ITPublic/deepseek-harness/releases/download/v1.2.3')
    expect(releaseDownloadUrl('http://host:3000/', 'ITPublic/deepseek-harness', 'v1.2.3'))
      .toBe('http://host:3000/ITPublic/deepseek-harness/releases/download/v1.2.3')
  })

  it('skips drafts and rejects payloads with no published tag', () => {
    expect(newestReleaseTag([
      { draft: true, tag_name: 'v2.0.0' },
      { draft: false, tag_name: 'v1.2.3' },
      { draft: false, tag_name: 'v1.1.0' },
    ])).toBe('v1.2.3')
    expect(newestReleaseTag([{ draft: true, tag_name: 'v2.0.0' }])).toBeUndefined()
    expect(newestReleaseTag({ not: 'an array' })).toBeUndefined()
  })

  it('resolves the newest published release into a feed URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { draft: false, tag_name: 'v0.2.0-rc.2-hrzszy' },
    ]), { status: 200 }))
    await expect(resolveReleaseFeed('http://host:3000', 'ITPublic/deepseek-harness', fetchImpl as unknown as typeof fetch))
      .resolves.toBe('http://host:3000/ITPublic/deepseek-harness/releases/download/v0.2.0-rc.2-hrzszy')
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0]))
      .toBe('http://host:3000/api/v1/repos/ITPublic/deepseek-harness/releases?limit=20')
  })

  it('rejects a failing lookup and an empty release list', async () => {
    const failing = vi.fn(async () => new Response('nope', { status: 404 }))
    await expect(resolveReleaseFeed('http://host:3000', 'ITPublic/deepseek-harness', failing as unknown as typeof fetch))
      .rejects.toThrow(/release lookup failed with 404/u)
    const empty = vi.fn(async () => new Response('[]', { status: 200 }))
    await expect(resolveReleaseFeed('http://host:3000', 'ITPublic/deepseek-harness', empty as unknown as typeof fetch))
      .rejects.toThrow(/publishes no release/u)
  })
})
