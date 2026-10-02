import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyManifestPins,
  applyWorkspacePins,
  locateWorkspaceDshBlock,
  lockfileDshNames,
  pinnedDshVersion,
  staleManifestEntries,
} from './sync-dsh-pins.mjs'

const workspace = [
  'packages:',
  '  - apps/*',
  'minimumReleaseAgeExclude:',
  "  - 'typescript-eslint@8.69.0'",
  "  - '@deepseek-ai/dsh-app-boot@0.2.0-rc.1'",
  "  - '@deepseek-ai/dsh-atomic-write@0.2.0-rc.1'",
  "  - '@deepseek-ai/dsh@0.2.0-rc.1'",
  '',
  'overrides:',
  "  '@deepseek-ai/dsh*': 0.2.0-rc.1",
  "  '@deepseek-ai/cordis-plugin-group': 1.0.4",
  '',
].join('\n')

const lockfile = [
  "lockfileVersion: '9.0'",
  '',
  'packages:',
  '',
  "  '@deepseek-ai/dsh-app-boot@0.2.0-rc.1':",
  '    resolution: {integrity: sha512-a}',
  '',
  "  '@deepseek-ai/dsh-app-boot@0.2.0-rc.1(@deepseek-ai/cordis@4.0.4)':",
  '    resolution: {integrity: sha512-b}',
  '',
  "  '@deepseek-ai/dsh@0.2.0-rc.1':",
  '    resolution: {integrity: sha512-c}',
  '',
].join('\n')

test('pinnedDshVersion reads the ledger and rejects an absent pin', () => {
  assert.equal(pinnedDshVersion({ dsh: { npmVersion: '0.3.0' } }), '0.3.0')
  assert.throws(() => pinnedDshVersion({ dsh: {} }), /npmVersion/u)
  assert.throws(() => pinnedDshVersion(undefined), /npmVersion/u)
})

test('locateWorkspaceDshBlock finds the contiguous run and preserves its order', () => {
  const block = locateWorkspaceDshBlock(workspace)
  assert.deepEqual(block.names, [
    '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-atomic-write',
    '@deepseek-ai/dsh',
  ])
  assert.deepEqual(block.versions, ['0.2.0-rc.1'])
})

test('locateWorkspaceDshBlock refuses a non-contiguous pin list', () => {
  const interleaved = [
    'minimumReleaseAgeExclude:',
    "  - '@deepseek-ai/dsh-app-boot@0.2.0-rc.1'",
    "  - 'typescript-eslint@8.69.0'",
    "  - '@deepseek-ai/dsh@0.2.0-rc.1'",
    '',
    'overrides:',
    "  '@deepseek-ai/dsh*': 0.2.0-rc.1",
    '',
  ].join('\n')
  assert.throws(() => locateWorkspaceDshBlock(interleaved), /not contiguous/u)
})

test('applyWorkspacePins rewrites every pin site and preserves stored order', () => {
  const next = applyWorkspacePins(workspace, '0.3.0')
  assert.match(next, /^ {2}- '@deepseek-ai\/dsh-app-boot@0\.3\.0'$/mu)
  assert.match(next, /^ {2}- '@deepseek-ai\/dsh@0\.3\.0'$/mu)
  assert.match(next, /^ {2}'@deepseek-ai\/dsh\*': 0\.3\.0$/mu)
  assert.match(next, /^ {2}'@deepseek-ai\/cordis-plugin-group': 1\.0\.4$/mu)
  assert.match(next, /^ {2}- 'typescript-eslint@8\.69\.0'$/mu)
  const order = next
    .split('\n')
    .filter((line) => line.startsWith("  - '@deepseek-ai/"))
    .map((line) => line.slice(5, -1))
  assert.deepEqual(order, [
    '@deepseek-ai/dsh-app-boot@0.3.0',
    '@deepseek-ai/dsh-atomic-write@0.3.0',
    '@deepseek-ai/dsh@0.3.0',
  ])
})

test('applyWorkspacePins is a no-op when every pin already carries the version', () => {
  assert.equal(applyWorkspacePins(workspace, '0.2.0-rc.1'), workspace)
})

test('applyWorkspacePins appends newly resolved packages in sorted order', () => {
  const next = applyWorkspacePins(workspace, '0.2.0-rc.1', ['@deepseek-ai/dsh-web-app'])
  const added = next
    .split('\n')
    .filter((line) => line.startsWith("  - '@deepseek-ai/"))
    .map((line) => line.slice(5, -1))
  assert.equal(added.at(-1), '@deepseek-ai/dsh-web-app@0.2.0-rc.1')
  assert.equal(added.filter((entry) => entry === '@deepseek-ai/dsh-web-app@0.2.0-rc.1').length, 1)
})

test('lockfileDshNames collects base names and ignores peer-suffixed duplicates', () => {
  assert.deepEqual([...lockfileDshNames(lockfile)].sort(), [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-app-boot',
  ])
})

test('staleManifestEntries ignores the independent cordis axis', () => {
  const manifest = {
    dependencies: {
      '@deepseek-ai/cordis': '4.0.4',
      '@deepseek-ai/dsh-app-boot': '0.2.0-rc.1',
      '@deepseek-ai/dsh-base': '0.1.0',
      '@deskwork/home-lease': 'workspace:*',
    },
  }
  assert.deepEqual(staleManifestEntries(manifest, '0.2.0-rc.1'), [
    { section: 'dependencies', name: '@deepseek-ai/dsh-base', declared: '0.1.0' },
  ])
})

test('applyManifestPins rewrites only DSH dependencies and keeps the file shape', () => {
  const manifest = {
    name: '@deskwork/host-supervisor',
    dependencies: { '@deepseek-ai/cordis': '4.0.4', '@deepseek-ai/dsh': '0.2.0-rc.1' },
  }
  const rendered = applyManifestPins(manifest, '0.3.0')
  assert.equal(rendered.endsWith('}\n'), true)
  const parsed = JSON.parse(rendered)
  assert.equal(parsed.dependencies['@deepseek-ai/dsh'], '0.3.0')
  assert.equal(parsed.dependencies['@deepseek-ai/cordis'], '4.0.4')
  assert.equal(parsed.name, '@deskwork/host-supervisor')
})
