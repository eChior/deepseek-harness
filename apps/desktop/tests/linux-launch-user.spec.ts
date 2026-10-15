import { posix } from 'node:path'

import { describe, expect, it } from 'vitest'

import { adoptLinuxLaunchUser, resolveLinuxLaunchUser } from '../src/linux-launch-user.ts'

describe('resolveLinuxLaunchUser', () => {
  it('adopts the invoking account when a sudo launch is root', () => {
    expect(resolveLinuxLaunchUser('linux', 0, { SUDO_UID: '1000', SUDO_GID: '1000' }))
      .toEqual({ uid: 1000, gid: 1000 })
  })

  it('leaves a launch that already runs as the invoking account alone', () => {
    expect(resolveLinuxLaunchUser('linux', 1000, { SUDO_UID: '1000', SUDO_GID: '1000' })).toBeUndefined()
  })

  it('leaves platforms that report no uid alone', () => {
    expect(resolveLinuxLaunchUser('darwin', 0, { SUDO_UID: '1000', SUDO_GID: '1000' })).toBeUndefined()
    expect(resolveLinuxLaunchUser('win32', undefined, {})).toBeUndefined()
  })

  it('leaves a root login that has no invoking account alone', () => {
    expect(resolveLinuxLaunchUser('linux', 0, {})).toBeUndefined()
    expect(resolveLinuxLaunchUser('linux', 0, { SUDO_UID: '0', SUDO_GID: '0' })).toBeUndefined()
    expect(resolveLinuxLaunchUser('linux', 0, { SUDO_UID: '0', SUDO_GID: '1000' })).toBeUndefined()
  })

  it('leaves a partially published account alone', () => {
    expect(resolveLinuxLaunchUser('linux', 0, { SUDO_UID: '1000' })).toBeUndefined()
    expect(resolveLinuxLaunchUser('linux', 0, { SUDO_GID: '1000' })).toBeUndefined()
    expect(resolveLinuxLaunchUser('linux', 0, { SUDO_UID: 'IT2', SUDO_GID: '1000' })).toBeUndefined()
  })
})

describe('adoptLinuxLaunchUser', () => {
  it('sets the group before the user and repoints the session variables', () => {
    const calls: string[] = []
    const environment: NodeJS.ProcessEnv = {
      HOME: '/root',
      USER: 'root',
      LOGNAME: 'root',
      XDG_CONFIG_HOME: '/root/.config',
    }
    const result = adoptLinuxLaunchUser({ uid: 1000, gid: 1000 }, environment, {
      setIds: (gid, uid) => { calls.push(`gid:${String(gid)}`, `uid:${String(uid)}`) },
      account: () => ({ homedir: '/home/IT2', username: 'IT2' }),
    })
    expect(calls).toEqual(['gid:1000', 'uid:1000'])
    expect(result).toEqual({ adopted: true, username: 'IT2' })
    expect(environment.HOME).toBe('/home/IT2')
    expect(environment.USER).toBe('IT2')
    expect(environment.LOGNAME).toBe('IT2')
    expect(environment.XDG_CONFIG_HOME).toBe(posix.join('/home/IT2', '.config'))
  })

  it('keeps an XDG root that already belongs to the invoking account', () => {
    const environment: NodeJS.ProcessEnv = {
      XDG_CONFIG_HOME: '/home/IT2/.config',
      XDG_RUNTIME_DIR: '/run/user/1000',
    }
    adoptLinuxLaunchUser({ uid: 1000, gid: 1000 }, environment, {
      setIds: () => {},
      account: () => ({ homedir: '/home/IT2', username: 'IT2' }),
    })
    expect(environment.XDG_CONFIG_HOME).toBe('/home/IT2/.config')
    expect(environment.XDG_RUNTIME_DIR).toBe('/run/user/1000')
  })

  it('leaves an absent runtime root absent when the runtime directory is not there', () => {
    const environment: NodeJS.ProcessEnv = {}
    adoptLinuxLaunchUser({ uid: 4_294_967_295, gid: 1000 }, environment, {
      setIds: () => {},
      account: () => ({ homedir: '/home/IT2', username: 'IT2' }),
    })
    expect(environment.XDG_RUNTIME_DIR).toBeUndefined()
  })

  it('reports why it stayed root when the id switch fails, and rewrites nothing', () => {
    const environment: NodeJS.ProcessEnv = {}
    const result = adoptLinuxLaunchUser({ uid: 1000, gid: 1000 }, environment, {
      setIds: () => { throw new Error('EPERM: operation not permitted') },
      account: () => ({ homedir: '/home/IT2', username: 'IT2' }),
    })
    expect(result).toEqual({ adopted: false, reason: 'EPERM: operation not permitted' })
    expect(environment.HOME).toBeUndefined()
    expect(environment.XDG_CONFIG_HOME).toBeUndefined()
  })

  it('reports a non-error throw as text', () => {
    const result = adoptLinuxLaunchUser({ uid: 1000, gid: 1000 }, {}, {
      setIds: () => { throw 'nope' },
      account: () => ({ homedir: '/home/IT2', username: 'IT2' }),
    })
    expect(result).toEqual({ adopted: false, reason: 'nope' })
  })
})
