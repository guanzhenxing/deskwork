import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { sanitizeHostEnvironment } from '../src/host-environment.js'
import { resolveSmokeHome } from '../src/smoke-home.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
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
