#!/usr/bin/env node
// smoke:startup-performance — measure the INSTALLED candidate's startup
// (one initialization + ten warm trials) and write the validated report to
// release/startup-performance.json. Refuses a missing or stale artifact
// index, and never uses workspace Electron.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertAcceptanceRuntime } from '../helpers/acceptance-runtime.mjs'

assertAcceptanceRuntime('smoke:startup-performance')

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

const record = (await readJson(path.join(repositoryRoot, 'release', 'artifacts.json'))).find(
  (entry) => entry.arch === process.arch,
)
if (record === undefined) {
  throw new Error(`smoke:startup-performance: release/artifacts.json has no ${process.arch} record`)
}
const dmgPath = path.resolve(repositoryRoot, record.file)
const dmgDigest = createHash('sha256')
  .update(await readFile(dmgPath))
  .digest('hex')
if (dmgDigest !== record.sha256) {
  throw new Error(
    'smoke:startup-performance: release/artifacts.json is stale — the DMG digest moved; rebuild before measuring',
  )
}
const manifest = await readJson(path.join(repositoryRoot, 'release', 'compatibility.json'))
const launcher = await readJson(
  path.join(repositoryRoot, 'apps', 'desktop-launcher', 'package.json'),
)

const { runStartupPerformance, validateStartupReport } =
  await import('../helpers/startup-performance.mjs')
const report = await runStartupPerformance({
  artifact: { dmgPath, appName: 'Deskwork' },
  identity: {
    releaseId: record.releaseId,
    dmgSha256: record.sha256,
    sourceCommit: manifest.sourceCommit,
    osRelease: execFileSync('sw_vers', ['-productVersion']).toString().trim(),
    electron: launcher.devDependencies.electron,
  },
})
validateStartupReport(report, record, {
  sourceCommit: manifest.sourceCommit,
  node: process.versions.node,
  electron: launcher.devDependencies.electron,
})

const target = path.join(repositoryRoot, 'release', 'startup-performance.json')
await writeFile(`${target}.tmp`, `${JSON.stringify(report, undefined, 2)}\n`)
await rename(`${target}.tmp`, target)
console.log(
  `STARTUP-PERFORMANCE ${record.releaseId}: initialization ${report.initialization.totalMs}ms; warm median ${report.warm.totalMedianMs}ms / P95 ${report.warm.totalP95Ms}ms over ${report.warm.runs.length} trials`,
)
