import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  findDshBaselineDrift,
  findFloatingDshSpecifiers,
  findIndependentPackageConflicts,
  findMultipleSingletonVersions,
  findOverrideRangeViolations,
} from './verify-dsh-closure.mjs'

function record(name, version) {
  return {
    name,
    version,
    integrity: 'sha512-x',
    relativePath: `node_modules/.pnpm/${name}@${version}/node_modules/${name}`,
  }
}

test('a DSH package drifting off the baseline is flagged, Cordis never matches the dsh pattern', () => {
  const records = [
    record('@deepseek-ai/dsh', '0.1.2-alpha.3'),
    record('@deepseek-ai/dsh-web-app', '0.1.2-alpha.4'),
    record('@deepseek-ai/cordis', '0.1.2-alpha.3'),
    record('react', '18.3.1'),
  ]
  const drift = findDshBaselineDrift(records, '0.1.2-alpha.3')
  assert.deepEqual(drift, [{ name: '@deepseek-ai/dsh-web-app', version: '0.1.2-alpha.4' }])
})

test('every dsh package on the baseline yields no drift', () => {
  const records = [
    record('@deepseek-ai/dsh', '0.1.2-alpha.3'),
    record('@deepseek-ai/dsh-base', '0.1.2-alpha.3'),
    record('@deepseek-ai/cordis', '4.0.2'),
  ]
  assert.deepEqual(findDshBaselineDrift(records, '0.1.2-alpha.3'), [])
})

test('floating specifiers in workspace manifests are refused, exact pins pass', () => {
  const manifests = [
    {
      file: 'apps/bundled-cli/package.json',
      name: '@deskwork/bundled-cli',
      dependencies: {
        '@deepseek-ai/dsh': '0.1.2-alpha.3',
      },
    },
    {
      file: 'packages/host-supervisor/package.json',
      name: '@deskwork/host-supervisor',
      dependencies: {
        '@deepseek-ai/dsh': '^0.1.2-alpha.3',
      },
    },
    {
      file: 'packages/shell-core/package.json',
      name: '@deskwork/shell-core',
      dependencies: {
        '@deskwork/host-supervisor': 'workspace:*',
      },
    },
  ]
  const floating = findFloatingDshSpecifiers(manifests)
  assert.deepEqual(floating, [
    {
      file: 'packages/host-supervisor/package.json',
      name: '@deskwork/host-supervisor',
      dependency: '@deepseek-ai/dsh',
      specifier: '^0.1.2-alpha.3',
    },
  ])
})

test('a second Cordis or React version anywhere in the closure is flagged', () => {
  const records = [
    record('@deepseek-ai/cordis', '4.0.2'),
    record('@deepseek-ai/cordis', '4.0.3'),
    record('react', '18.3.1'),
    record('@deepseek-ai/dsh', '0.1.2-alpha.3'),
  ]
  const duplicates = findMultipleSingletonVersions(records, [
    'react',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh',
  ])
  assert.deepEqual(duplicates, [{ name: '@deepseek-ai/cordis', versions: ['4.0.2', '4.0.3'] }])
})

test('independently versioned packages must match their declared provenance version', () => {
  const records = [record('@deepseek-ai/cordis', '4.0.2'), record('@deepseek-ai/cordis', '4.1.0')]
  const conflicts = findIndependentPackageConflicts(records, [
    { name: '@deepseek-ai/cordis', version: '4.0.2' },
  ])
  assert.deepEqual(conflicts, [
    { name: '@deepseek-ai/cordis', expected: '4.0.2', found: ['4.0.2', '4.1.0'] },
  ])
  const missing = findIndependentPackageConflicts(
    [record('react', '18.3.1')],
    [{ name: '@deepseek-ai/cordis', version: '4.0.2' }],
  )
  assert.deepEqual(missing, [{ name: '@deepseek-ai/cordis', expected: '4.0.2', found: [] }])
})

test('workspace override ranges on @deepseek-ai packages are refused', () => {
  const yaml = [
    'packages:',
    '  - apps/*',
    'overrides:',
    "  '@deepseek-ai/dsh': 0.1.2-alpha.3",
    '  react: ^18.0.0',
    '',
  ].join('\n')
  const watched = ['react', '@deepseek-ai/cordis', '@deepseek-ai/dsh']
  assert.deepEqual(findOverrideRangeViolations(yaml, watched), [
    { name: 'react', specifier: '^18.0.0' },
  ])
  assert.deepEqual(findOverrideRangeViolations('packages:\n  - apps/*\n', watched), [])
})

test('patch ledger validation accepts the explicit empty ledger and refuses malformed rows', async () => {
  const { validatePatchLedger } = await import('./verify-patches.mjs')
  const empty = { schemaVersion: 1, patches: [] }
  assert.deepEqual(validatePatchLedger(empty, 'dd6322d604e00eec1ba5e0c8541159906a21094a'), {
    patches: [],
    problems: [],
  })

  const malformed = {
    schemaVersion: 1,
    patches: [
      {
        id: 'fix-thing',
        file: 'patches/fix-thing.diff',
        upstreamCommit: 'dd6322d604e00eec1ba5e0c8541159906a21094a',
        reason: '',
        testCommand: 'pnpm test',
        status: 'active',
      },
    ],
  }
  const result = validatePatchLedger(malformed, 'dd6322d604e00eec1ba5e0c8541159906a21094a')
  assert.equal(result.problems.length, 1)
  assert.match(result.problems[0], /reason/)

  const staleUpstream = validatePatchLedger(
    {
      schemaVersion: 1,
      patches: [
        {
          id: 'fix-thing',
          file: 'patches/fix-thing.diff',
          upstreamCommit: '4e84901e6471b79ec0338099867ebb4606d12bb5',
          reason: 'keep',
          testCommand: 'pnpm test',
          status: 'active',
        },
      ],
    },
    'dd6322d604e00eec1ba5e0c8541159906a21094a',
  )
  assert.match(staleUpstream.problems[0], /not the baseline/)
})

test('the repository declares exactly the qualified upstream baseline', () => {
  const expectedDshBaseline = Object.freeze({
    tag: 'dsh-v0.2.0-rc.1',
    commit: '4878cdabd87d4041bdaff61d04c966883b9fd07a',
    npmVersion: '0.2.0-rc.1',
  })
  const artifacts = JSON.parse(
    readFileSync(new URL('../build/upstream-artifacts.json', import.meta.url), 'utf8'),
  )
  const compatibility = JSON.parse(
    readFileSync(new URL('../docs/compatibility.json', import.meta.url), 'utf8'),
  )

  assert.deepEqual(
    {
      tag: artifacts.dsh.tag,
      commit: artifacts.dsh.commit,
      npmVersion: artifacts.dsh.npmVersion,
    },
    expectedDshBaseline,
    'build/upstream-artifacts.json must pin the qualified upstream baseline',
  )
  assert.deepEqual(
    {
      tag: compatibility.dsh.tag,
      commit: compatibility.dsh.commit,
      npmVersion: compatibility.dsh.npmVersion,
    },
    expectedDshBaseline,
    'docs/compatibility.json must pin the qualified upstream baseline',
  )
  assert.ok(artifacts.dsh.packages.length > 0, 'the ledger must own at least one package record')
  for (const entry of artifacts.dsh.packages) {
    assert.equal(
      entry.version,
      expectedDshBaseline.npmVersion,
      `${entry.name} must be pinned to the family version`,
    )
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u, `${entry.name} needs integrity`)
    assert.equal(
      entry.tarball,
      `https://registry.npmjs.org/${entry.name}/-/${entry.name.split('/').pop()}-${expectedDshBaseline.npmVersion}.tgz`,
      `${entry.name} tarball URL must name the family version`,
    )
    assert.ok(
      artifacts.dsh.evidence.some((url) => url.includes(expectedDshBaseline.commit)),
      'the evidence links must name the baseline commit',
    )
  }
})
