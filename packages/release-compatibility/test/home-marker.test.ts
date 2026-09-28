import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { HomeLease } from '@dsh-desktop/home-lease'

import { HomeAdmissionError, markerPath } from '../src/home-admission.js'
import { runHomeCompatibilityChain } from '../src/home-marker.js'
import type { ReleaseManifest } from '../src/manifest.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-admission-chain-'))
  temporaryDirectories.push(home)
  return home
}

function stubLease(home: string): HomeLease {
  return { home, assertHeld: async () => undefined } as unknown as HomeLease
}

function release(
  input?: Partial<{ dataEpoch: number; supportedDataEpochs: number[] }>,
): ReleaseManifest {
  return {
    releaseId: 'test-release',
    dataEpoch: input?.dataEpoch ?? 1,
    supportedDataEpochs: input?.supportedDataEpochs ?? [1],
  } as unknown as ReleaseManifest
}

describe('runHomeCompatibilityChain (minimal marker-only admission)', () => {
  it('admits a fresh home twice in a row and reserves an empty-formats marker', async () => {
    const home = await tempHome()
    const lease = stubLease(home)
    await expect(
      runHomeCompatibilityChain({ home, release: release(), lease, reserve: true }),
    ).resolves.toBe('allow')
    const marker = JSON.parse(await readFile(markerPath(home), 'utf8'))
    expect(marker).toMatchObject({ schemaVersion: 1, dataEpoch: 1, formats: {} })
    // The second boot reads back the marker the first boot reserved: the home
    // this release wrote must admit this release, with no format evidence.
    await expect(
      runHomeCompatibilityChain({ home, release: release(), lease, reserve: true }),
    ).resolves.toBe('allow')
  })

  it('admits a home without inspecting any on-disk format evidence', async () => {
    const home = await tempHome()
    await mkdir(path.join(home, 'sessions'), { recursive: true })
    await writeFile(
      path.join(home, 'sessions', 'session.jsonl'),
      '{"type":"session","version":99}\n',
    )
    await expect(
      runHomeCompatibilityChain({ home, release: release(), reserve: false }),
    ).resolves.toBe('allow')
  })

  it('refuses a marker whose schemaVersion is unknown', async () => {
    const home = await tempHome()
    await mkdir(path.join(home, 'run'), { recursive: true })
    await writeFile(
      markerPath(home),
      JSON.stringify({ schemaVersion: 2, dataEpoch: 1, lastWriterReleaseId: 'x', formats: {} }),
    )
    await expect(
      runHomeCompatibilityChain({ home, release: release(), reserve: false }),
    ).resolves.toBe('unknown-schema')
  })

  it('refuses a marker epoch this release does not support', async () => {
    const home = await tempHome()
    await mkdir(path.join(home, 'run'), { recursive: true })
    await writeFile(
      markerPath(home),
      JSON.stringify({
        schemaVersion: 1,
        dataEpoch: 2,
        lastWriterReleaseId: 'future-release',
        formats: {},
      }),
    )
    await expect(
      runHomeCompatibilityChain({ home, release: release(), reserve: false }),
    ).resolves.toBe('unsupported-data')
  })

  it('reports migration-required for an older supported epoch', async () => {
    const home = await tempHome()
    await mkdir(path.join(home, 'run'), { recursive: true })
    await writeFile(
      markerPath(home),
      JSON.stringify({
        schemaVersion: 1,
        dataEpoch: 0,
        lastWriterReleaseId: 'past-release',
        formats: {},
      }),
    )
    await expect(
      runHomeCompatibilityChain({
        home,
        release: release({ dataEpoch: 1, supportedDataEpochs: [0, 1] }),
        reserve: false,
      }),
    ).resolves.toBe('migration-required')
  })

  it('refuses to reserve without holding the home lease', async () => {
    const home = await tempHome()
    await expect(
      runHomeCompatibilityChain({ home, release: release(), reserve: true }),
    ).rejects.toThrow(HomeAdmissionError)
  })
})
