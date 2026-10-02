import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createHomeSession } from '@deskwork/desktop-contracts/home-session'

import { quarantineProjectionCache } from '../src/projection-cache.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

const fixtures: IsolatedHomeFixture[] = []

async function home(): Promise<string> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  return fixture.home
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

describe('projection cache quarantine (real session)', () => {
  it('quarantines an oversized cache under a real session', async () => {
    const dir = await home()
    const cache = path.join(dir, 'storages', 'session_projcache', 'sessions')
    await mkdir(cache, { recursive: true })
    // Sparse file: apparent size over threshold, few allocated blocks.
    await writeFile(path.join(cache, 'proj.bin'), Buffer.alloc(4096, 7))
    const session = await createHomeSession({ home: dir, profile: 'deskwork' })
    const result = await quarantineProjectionCache({ home: dir, session, thresholdBytes: 1024 })
    expect(result.kind).toBe('quarantined')
    if (result.kind === 'quarantined') {
      const backup = path.join(dir, result.relativeBackupPath)
      expect((await readFile(path.join(backup, 'proj.bin'))).length).toBe(4096)
      await expect(stat(cache)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})
