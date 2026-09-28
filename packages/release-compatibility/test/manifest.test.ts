import { describe, expect, it } from 'vitest'

import { parseReleaseManifest } from '../src/manifest.js'

/** A minimal well-formed release manifest every test clones and mutates. */
export function validManifestInput(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    releaseId: 'm4-0.0.0-darwin-arm64-98af342',
    desktopVersion: '0.0.0',
    sourceCommit: '98af34292b23ff2087c4d3f4c930465eafc75bbf'.slice(0, 40),
    dsh: {
      tag: 'dsh-v0.1.2-alpha.3',
      commit: 'dd6322d604e00eec1ba5e0c8541159906a21094a',
      npmVersion: '0.1.2-alpha.3',
    },
    platform: 'darwin',
    arch: 'arm64',
    hostControl: { major: 1, minor: 0 },
    profileSchemaVersion: 1,
    pluginApi: {
      strategy: 'verified-exact-baseline',
      dshVersion: '0.1.2-alpha.3',
      singletonPackages: ['react', '@deepseek-ai/cordis', '@deepseek-ai/dsh'],
    },
    formats: [
      {
        provider: '@deepseek-ai/dsh-credentials-local',
        providerVersion: '0.1.2-alpha.3',
        formatId: 'dsh-credentials-file-1',
        readable: ['dsh-credentials-file-1'],
        writable: 'dsh-credentials-file-1',
        evidence: [
          'fixture:tests/fixtures/home-formats/credentials.yaml#0000000000000000000000000000000000000000000000000000000000000000',
        ],
      },
    ],
    dataEpoch: 1,
    supportedDataEpochs: [1],
    dependencyClosureSha256: 'a'.repeat(64),
    patchManifestSha256: 'b'.repeat(64),
  }
}

describe('parseReleaseManifest', () => {
  it('accepts a well-formed manifest and keeps the declared invariants', () => {
    const manifest = parseReleaseManifest(validManifestInput())
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.supportedDataEpochs).toContain(manifest.dataEpoch)
    expect(manifest.formats.every((format) => format.readable.includes(format.writable))).toBe(true)
    expect(manifest.pluginApi.dshVersion).toBe(manifest.dsh.npmVersion)
  })

  it('tolerates the embedded runtime extras staged around the release facts', () => {
    const manifest = parseReleaseManifest({
      ...validManifestInput(),
      productExecutableName: 'Deskwork',
      appId: 'com.deepseek.harness.desktop',
      electron: '44.1.0',
      node: '24.11.1',
      pnpm: '11.7.0',
      closureDigest: { 'runtime-host': { storeSha256: 'c'.repeat(64) } },
    })
    expect(manifest.schemaVersion).toBe(2)
  })

  it('rejects an unknown schema version', () => {
    expect(() => parseReleaseManifest({ schemaVersion: 999 })).toThrow()
    expect(() => parseReleaseManifest({ ...validManifestInput(), schemaVersion: 1 })).toThrow()
  })

  it('rejects a missing DSH commit', () => {
    const input = validManifestInput()
    delete (input.dsh as Record<string, unknown>).commit
    expect(() => parseReleaseManifest(input)).toThrow()
  })

  it('rejects a mixed DSH baseline between pluginApi and dsh facts', () => {
    const input = validManifestInput()
    ;(input.pluginApi as Record<string, unknown>).dshVersion = '0.1.2-alpha.4'
    expect(() => parseReleaseManifest(input)).toThrow()
  })

  it('rejects empty supportedDataEpochs and an epoch outside the supported set', () => {
    expect(() =>
      parseReleaseManifest({ ...validManifestInput(), supportedDataEpochs: [] }),
    ).toThrow()
    expect(() => parseReleaseManifest({ ...validManifestInput(), dataEpoch: 2 })).toThrow()
  })

  it('rejects a format that declares a writable it cannot read', () => {
    const input = validManifestInput()
    const formats = input.formats as Array<Record<string, unknown>>
    formats[0]!.readable = ['dsh-credentials-file-0']
    expect(() => parseReleaseManifest(input)).toThrow()
  })

  it('rejects a platform this product does not ship', () => {
    expect(() => parseReleaseManifest({ ...validManifestInput(), platform: 'linux' })).toThrow()
    expect(() => parseReleaseManifest({ ...validManifestInput(), platform: 'win32' })).toThrow()
  })

  it('rejects an unsupported architecture', () => {
    expect(() => parseReleaseManifest({ ...validManifestInput(), arch: 'ppc64' })).toThrow()
  })

  it('rejects malformed closure and patch digests', () => {
    expect(() =>
      parseReleaseManifest({ ...validManifestInput(), dependencyClosureSha256: 'not-a-hash' }),
    ).toThrow()
    expect(() =>
      parseReleaseManifest({ ...validManifestInput(), patchManifestSha256: 'ZZ'.repeat(32) }),
    ).toThrow()
  })

  it('rejects a source commit that is not a full git object id', () => {
    expect(() =>
      parseReleaseManifest({ ...validManifestInput(), sourceCommit: '98af342' }),
    ).toThrow()
  })

  it('rejects an empty pluginApi singleton list and non-ascending supported epochs', () => {
    const emptySingletons = validManifestInput()
    ;(emptySingletons.pluginApi as Record<string, unknown>).singletonPackages = []
    expect(() => parseReleaseManifest(emptySingletons)).toThrow(/singletonPackages/)

    const duplicate = validManifestInput()
    duplicate.supportedDataEpochs = [1, 1, 2]
    duplicate.dataEpoch = 2
    expect(() => parseReleaseManifest(duplicate)).toThrow(/ascending/)

    const descending = validManifestInput()
    descending.supportedDataEpochs = [1, 0]
    descending.dataEpoch = 1
    expect(() => parseReleaseManifest(descending)).toThrow(/ascending/)

    // dataEpoch must be the NEWEST supported epoch: a higher trailing entry
    // would admit that epoch's homes and silently downgrade-stamp the marker.
    const ceiling = validManifestInput()
    ceiling.supportedDataEpochs = [1, 2]
    ceiling.dataEpoch = 1
    expect(() => parseReleaseManifest(ceiling)).toThrow(/newest/)
  })

  it('rejects non-object and array inputs', () => {
    expect(() => parseReleaseManifest(null)).toThrow()
    expect(() => parseReleaseManifest('manifest')).toThrow()
    expect(() => parseReleaseManifest([])).toThrow()
  })
})
