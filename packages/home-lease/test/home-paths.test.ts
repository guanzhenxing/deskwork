import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveDesktopHome } from '../src/home-paths.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const upstreamEntry = path.join(
  packageRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-home-paths',
  'lib',
  'index.js',
)

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function resolveUpstreamInChildProcess(input: {
  cwd: string
  dshHome: string | undefined
}): Promise<string> {
  const script = `
import { pathToFileURL } from 'node:url'
const { resolveDshHome } = await import(pathToFileURL(${JSON.stringify(upstreamEntry)}).href)
process.stdout.write(resolveDshHome(undefined, process.env))
`
  const env: Record<string, string> = { HOME: homedir() }
  if (input.dshHome !== undefined) env.DSH_HOME = input.dshHome
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { cwd: input.cwd, env, timeout: 15_000 },
  )
  return stdout.trim()
}

describe('resolveDesktopHome', () => {
  it('uses the Deskwork home default when DSH_HOME is unset or blank', () => {
    expect(resolveDesktopHome({ env: {}, osHome: '/Users/test', cwd: '/tmp/work' })).toBe(
      '/Users/test/.deskwork',
    )
    expect(
      resolveDesktopHome({ env: { DSH_HOME: '  ' }, osHome: '/Users/test', cwd: '/tmp/work' }),
    ).toBe('/Users/test/.deskwork')
    expect(
      resolveDesktopHome({ env: { DSH_HOME: '' }, osHome: '/Users/test', cwd: '/tmp/work' }),
    ).toBe('/Users/test/.deskwork')
  })

  it('resolves relative overrides against the caller cwd', () => {
    expect(
      resolveDesktopHome({ env: { DSH_HOME: 'data' }, osHome: '/Users/test', cwd: '/tmp/work' }),
    ).toBe('/tmp/work/data')
    expect(
      resolveDesktopHome({ env: { DSH_HOME: '../up' }, osHome: '/Users/test', cwd: '/tmp/work' }),
    ).toBe('/tmp/up')
  })

  it('expands tilde overrides against the OS home', () => {
    expect(
      resolveDesktopHome({
        env: { DSH_HOME: '~/data' },
        osHome: '/Users/test',
        cwd: '/tmp/work',
      }),
    ).toBe('/Users/test/data')
    expect(
      resolveDesktopHome({ env: { DSH_HOME: '~' }, osHome: '/Users/test', cwd: '/tmp/work' }),
    ).toBe('/Users/test')
  })

  it('keeps absolute overrides absolute', () => {
    expect(
      resolveDesktopHome({
        env: { DSH_HOME: '/srv/dsh' },
        osHome: '/Users/test',
        cwd: '/tmp/work',
      }),
    ).toBe('/srv/dsh')
  })

  it('rejects homes that resolve to the filesystem root', () => {
    expect(() =>
      resolveDesktopHome({ env: { DSH_HOME: '/' }, osHome: '/Users/test', cwd: '/tmp/work' }),
    ).toThrow(/root/u)
    expect(() =>
      resolveDesktopHome({
        env: { DSH_HOME: '../../..' },
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
})

describe('resolveDesktopHome parity with the pinned upstream resolver', () => {
  const cases: readonly { label: string; dshHome: string }[] = [
    { label: 'absolute override', dshHome: '/tmp/dsh-parity-absolute' },
    { label: 'relative override', dshHome: 'relative-home' },
    { label: 'tilde override', dshHome: '~/tilde-home' },
  ]

  for (const testCase of cases) {
    it(`matches upstream for a ${testCase.label}`, async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-home-parity-'))
      temporaryDirectories.push(cwd)
      // Node reports process.cwd() through its canonical path, so compare
      // against the realpath the child process actually resolves from.
      const canonicalCwd = await realpath(cwd)
      const upstream = await resolveUpstreamInChildProcess({ cwd, dshHome: testCase.dshHome })
      const local = resolveDesktopHome({
        env: { DSH_HOME: testCase.dshHome },
        osHome: homedir(),
        cwd: canonicalCwd,
      })
      expect(local).toBe(upstream)
    }, 20_000)
  }

  it('diverges from upstream only on the default: Deskwork owns ~/.deskwork, never ~/.dsh', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-home-parity-'))
    temporaryDirectories.push(cwd)
    const canonicalCwd = await realpath(cwd)
    const upstream = await resolveUpstreamInChildProcess({ cwd, dshHome: undefined })
    expect(upstream).toBe(path.join(homedir(), '.dsh'))
    const local = resolveDesktopHome({ env: {}, osHome: homedir(), cwd: canonicalCwd })
    expect(local).toBe(path.join(homedir(), '.deskwork'))
  }, 20_000)

  it('treats a blank DSH_HOME as unset: Deskwork default, not the upstream ~/.dsh', () => {
    expect(
      resolveDesktopHome({ env: { DSH_HOME: '   ' }, osHome: homedir(), cwd: '/tmp/work' }),
    ).toBe(path.join(homedir(), '.deskwork'))
  })
})
