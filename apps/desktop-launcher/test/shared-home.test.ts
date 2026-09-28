import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { sanitizeHostEnvironment } from '../src/host-environment.js'
import { describeLeaseBlock, resolveSmokeHome } from '../src/lease-diagnostics.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('describeLeaseBlock', () => {
  it('shows the owner summary, the doctor command, and the shared-home hint without paths', () => {
    const view = describeLeaseBlock({
      code: 'HOME_BUSY',
      ownerSummary:
        'entrypoint=bundled-cli profile=headless supervisor=1234 host=none createdAt=2026-09-02T00:00:00.000Z',
    })
    expect(view.title).toBe('Deskwork 无法独占数据目录')
    expect(view.body.join('\n')).toContain('bundled-cli')
    expect(view.body.join('\n')).toContain('不同 profile 不构成并发例外')
    expect(view.body.join('\n')).toContain('DSH_HOME')
    expect(view.body.join('\n')).not.toMatch(/\/Users\//u)
    expect(view.doctorCommand).toBe('dsh-native doctor --unlock')
  })

  it('points stale or unknown owners at the doctor cleanup path', () => {
    for (const code of ['HOME_STALE', 'LEASE_UNKNOWN']) {
      const view = describeLeaseBlock({ code })
      expect(view.body.join('\n')).toContain('doctor')
    }
    const busy = describeLeaseBlock({ code: 'HOME_BUSY' })
    expect(busy.body.join('\n')).not.toContain('锁残留')
  })
})

describe('resolveSmokeHome', () => {
  it('derives the home from the smoke userData directory only', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-m0-smoke-'))
    temporaryDirectories.push(userData)
    const home = resolveSmokeHome({ smokeMode: 'ui', userData, osHome: '/Users/test' })
    expect(home).toBe(path.join(userData, 'home'))
  })

  it('refuses to run without a smoke mode', () => {
    expect(() =>
      resolveSmokeHome({ smokeMode: undefined, userData: '/tmp/x', osHome: '/Users/test' }),
    ).toThrow(/smoke mode/u)
  })

  it('never resolves to the real default home', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-m0-smoke-'))
    temporaryDirectories.push(userData)
    const home = resolveSmokeHome({
      smokeMode: 'host-crash',
      userData,
      osHome: homedir(),
    })
    expect(home).not.toBe(path.join(homedir(), '.dsh'))
    expect(path.dirname(home)).toBe(userData)
  })
})

describe('sanitizeHostEnvironment', () => {
  it('drops the entry-home override so the Host only learns home from bootstrap', () => {
    const sanitized = sanitizeHostEnvironment({
      DSH_HOME: '/Users/test/.dsh',
      NODE_OPTIONS: '--inspect',
      NODE_PATH: '/evil',
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_SMOKE: 'ui',
      PATH: '/usr/bin',
    })
    expect(sanitized).toEqual({ PATH: '/usr/bin' })
  })
})
