import { spawnSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireHomeLease,
  createNativeProcessProbe,
  defaultLeaseHelperPath,
} from '@deskwork/home-lease'

import { quarantineProjectionCache } from '../src/projection-cache.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

const helperAvailable =
  process.platform === 'darwin' &&
  spawnSync(defaultLeaseHelperPath(), ['identity', String(process.pid)], { timeout: 5_000 })
    .status === 0

const fixtures: IsolatedHomeFixture[] = []

async function home(): Promise<string> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  return fixture.home
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

describe.skipIf(!helperAvailable)('projection cache quarantine (real lease)', () => {
  it('quarantines an oversized cache under a real lease', async () => {
    const dir = await home()
    const cache = path.join(dir, 'storages', 'session_projcache', 'sessions')
    await mkdir(cache, { recursive: true })
    // Sparse file: apparent size over threshold, few allocated blocks.
    await writeFile(path.join(cache, 'proj.bin'), Buffer.alloc(4096, 7))
    const lease = await acquireHomeLease({
      home: dir,
      entrypoint: 'desktop',
      profile: 'deskwork',
      appVersion: '0.0.0',
      probe: createNativeProcessProbe({
        helperPath: defaultLeaseHelperPath(),
        entryExecutables: [],
      }),
    })
    const result = await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1024 })
    expect(result.kind).toBe('quarantined')
    if (result.kind === 'quarantined') {
      const backup = path.join(dir, result.relativeBackupPath)
      expect((await readFile(path.join(backup, 'proj.bin'))).length).toBe(4096)
      await expect(stat(cache)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await lease.release()
  })
})
