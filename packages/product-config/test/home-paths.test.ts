import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveDesktopHome } from '../src/home-paths.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function tempCwd(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-home-resolution-'))
  temporaryDirectories.push(cwd)
  return realpath(cwd)
}

describe('resolveDesktopHome', () => {
  it('uses the Deskwork home default when DESKWORK_HOME is unset or blank', () => {
    expect(resolveDesktopHome({ env: {}, osHome: '/Users/test', cwd: '/tmp/work' })).toBe(
      '/Users/test/.deskwork',
    )
    expect(
      resolveDesktopHome({ env: { DESKWORK_HOME: '  ' }, osHome: '/Users/test', cwd: '/tmp/work' }),
    ).toBe('/Users/test/.deskwork')
    expect(
      resolveDesktopHome({ env: { DESKWORK_HOME: '' }, osHome: '/Users/test', cwd: '/tmp/work' }),
    ).toBe('/Users/test/.deskwork')
  })

  it('never reads the upstream DSH_HOME variable: a stale value cannot redirect the home', () => {
    expect(
      resolveDesktopHome({
        env: { DSH_HOME: '/Users/test/.dsh' },
        osHome: '/Users/test',
        cwd: '/tmp/work',
      }),
    ).toBe('/Users/test/.deskwork')
  })

  it('resolves relative overrides against the caller cwd', () => {
    expect(
      resolveDesktopHome({
        env: { DESKWORK_HOME: 'data' },
        osHome: '/Users/test',
        cwd: '/tmp/work',
      }),
    ).toBe('/tmp/work/data')
    expect(
      resolveDesktopHome({
        env: { DESKWORK_HOME: '../up' },
        osHome: '/Users/test',
        cwd: '/tmp/work',
      }),
    ).toBe('/tmp/up')
  })

  it('expands tilde overrides against the OS home', () => {
    expect(
      resolveDesktopHome({
        env: { DESKWORK_HOME: '~/data' },
        osHome: '/Users/test',
        cwd: '/tmp/work',
      }),
    ).toBe('/Users/test/data')
    expect(
      resolveDesktopHome({ env: { DESKWORK_HOME: '~' }, osHome: '/Users/test', cwd: '/tmp/work' }),
    ).toBe('/Users/test')
  })

  it('keeps absolute overrides absolute', () => {
    expect(
      resolveDesktopHome({
        env: { DESKWORK_HOME: '/srv/dsh' },
        osHome: '/Users/test',
        cwd: '/tmp/work',
      }),
    ).toBe('/srv/dsh')
  })

  it('rejects homes that resolve to the filesystem root', () => {
    expect(() =>
      resolveDesktopHome({ env: { DESKWORK_HOME: '/' }, osHome: '/Users/test', cwd: '/tmp/work' }),
    ).toThrow(/root/u)
    expect(() =>
      resolveDesktopHome({
        env: { DESKWORK_HOME: '../../..' },
        osHome: '/Users/test',
        cwd: '/tmp/work',
      }),
    ).toThrow(/root/u)
  })

  it('rejects relative cwd or OS home inputs', () => {
    expect(() => resolveDesktopHome({ env: {}, osHome: 'home', cwd: '/tmp/work' })).toThrow(
      /absolute/u,
    )
    expect(() => resolveDesktopHome({ env: {}, osHome: '/Users/test', cwd: 'work' })).toThrow(
      /absolute/u,
    )
  })

  it('resolves the real-machine default to ~/.deskwork', async () => {
    const canonicalCwd = await tempCwd()
    expect(resolveDesktopHome({ env: {}, osHome: homedir(), cwd: canonicalCwd })).toBe(
      path.join(homedir(), '.deskwork'),
    )
  })
})
