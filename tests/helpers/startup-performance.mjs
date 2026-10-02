#!/usr/bin/env node
// Packaged startup-performance harness: validate smoke timelines, summarize
// warm runs with nearest-rank statistics, and validate the whole report
// against the measured candidate. Pure validation lives here; the driving
// loop (install → one initialization → ten warm runs) lives in
// runStartupPerformance, used by tests/smoke/startup-performance.mjs.
import { access, mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const STAGES = [
  'launcher-ready',
  'loading-visible',
  'home-admitted',
  'host-spawned',
  'host-ready',
  'surface-loaded',
  'official-ui-ready',
]

const EVENT_KEYS = ['elapsedMs', 'kind', 'stage']

export function percentile95(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Exact-shape validation of one smoke timeline: the seven stages in order,
 * nondecreasing non-negative integer elapsed, no extra fields. Returns
 * undefined when valid (assertion-style, like the other gates). */
export function validateTimeline(events) {
  if (!Array.isArray(events) || events.length !== STAGES.length) {
    throw new Error(
      `startup-performance: timeline is missing stages: must hold all ${STAGES.length}`,
    )
  }
  for (const [index, event] of events.entries()) {
    if (typeof event !== 'object' || event === null) {
      throw new Error(`startup-performance: event ${index} is not an object`)
    }
    const keys = Object.keys(event).sort()
    if (keys.length !== EVENT_KEYS.length || keys.some((key, at) => key !== EVENT_KEYS[at])) {
      throw new Error(`startup-performance: event ${index} carries an extra field`)
    }
    if (event.kind !== 'startup-perf-stage' || event.stage !== STAGES[index]) {
      throw new Error(`startup-performance: event ${index} breaks the stage order`)
    }
    if (!Number.isInteger(event.elapsedMs) || event.elapsedMs < 0) {
      throw new Error(`startup-performance: event ${index} elapsed is not a non-negative integer`)
    }
    if (index > 0 && event.elapsedMs < events[index - 1].elapsedMs) {
      throw new Error(`startup-performance: event ${index} elapsed decreased`)
    }
  }
  return undefined
}

/** Adjacent stage durations plus totals for the warm population. */
export function summarizeWarmRuns(runs) {
  const totals = runs.map((run) => run.events[run.events.length - 1].elapsedMs)
  const stageMediansMs = {}
  const stageP95Ms = {}
  for (const [index, stage] of STAGES.entries()) {
    const start = index === 0 ? () => 0 : (run) => run.events[index - 1].elapsedMs
    const durations = runs.map((run) => run.events[index].elapsedMs - start(run))
    stageMediansMs[stage] = median(durations)
    stageP95Ms[stage] = percentile95(durations)
  }
  return {
    runs: runs.length,
    totalMedianMs: median(totals),
    totalP95Ms: percentile95(totals),
    stageMediansMs,
    stageP95Ms,
  }
}

const REPORT_KEYS = ['schemaVersion', 'candidate', 'platform', 'initialization', 'warm']
const CANDIDATE_KEYS = ['releaseId', 'dmgSha256', 'sourceCommit']
const PLATFORM_KEYS = ['osRelease', 'arch', 'node', 'electron']
const INITIALIZATION_KEYS = ['events', 'stages', 'totalMs']
const WARM_KEYS = ['runs', 'totalMedianMs', 'totalP95Ms', 'stageMediansMs', 'stageP95Ms']
const RUN_KEYS = ['events']

function assertExactKeys(value, keys, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`startup-performance: ${where} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, at) => key !== expected[at])) {
    throw new Error(
      `startup-performance: ${where} fields ${JSON.stringify(actual)} are not the closed set (unexpected field)`,
    )
  }
}

function scanAbsolutePaths(value, where) {
  if (typeof value === 'string') {
    if (value.startsWith('/')) {
      throw new Error(`startup-performance: absolute path in ${where}: ${value}`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanAbsolutePaths(entry, `${where}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) scanAbsolutePaths(entry, `${where}.${key}`)
  }
}

/** Whole-report validation: identity binding, population size, timeline
 * validity, honest statistics, and no absolute paths or lease leftovers. */
export function validateStartupReport(report, artifact, identity) {
  if (report.schemaVersion !== 1) throw new Error('startup-performance: schemaVersion != 1')
  assertExactKeys(report, REPORT_KEYS, 'report')
  assertExactKeys(report.candidate, CANDIDATE_KEYS, 'candidate')
  assertExactKeys(report.platform, PLATFORM_KEYS, 'platform')
  assertExactKeys(report.initialization, INITIALIZATION_KEYS, 'initialization')
  assertExactKeys(report.warm, WARM_KEYS, 'warm')
  for (const run of report.warm.runs) {
    assertExactKeys(run, RUN_KEYS, 'warm run')
  }
  if (JSON.stringify(report.initialization.stages) !== JSON.stringify(STAGES)) {
    throw new Error('startup-performance: initialization.stages is not the seven-stage contract')
  }
  if (identity !== undefined) {
    if (report.candidate.sourceCommit !== identity.sourceCommit) {
      throw new Error('startup-performance: report sourceCommit != the measured manifest commit')
    }
    if (report.platform.node !== identity.node) {
      throw new Error('startup-performance: report node != the driver runtime')
    }
    if (report.platform.electron !== identity.electron) {
      throw new Error('startup-performance: report electron != the launcher pin')
    }
  }
  scanAbsolutePaths(report, 'report')
  if (report.candidate.releaseId !== artifact.releaseId) {
    throw new Error(`startup-performance: candidate releaseId does not match the artifact record`)
  }
  if (report.candidate.dmgSha256 !== artifact.sha256) {
    throw new Error('startup-performance: candidate DMG digest does not match the artifact record')
  }
  if (report.platform.arch !== artifact.arch) {
    throw new Error('startup-performance: report arch does not match the artifact record')
  }
  validateTimeline(report.initialization.events)
  if (report.initialization.totalMs !== report.initialization.events.at(-1).elapsedMs) {
    throw new Error('startup-performance: initialization totalMs disagrees with its timeline')
  }
  const warm = report.warm
  if (!Array.isArray(warm.runs) || warm.runs.length < 10) {
    throw new Error('startup-performance: at least ten warm trials are required')
  }
  for (const [index, run] of warm.runs.entries()) {
    validateTimeline(run.events)
    if (run.leaseSurvived === true) {
      throw new Error(`startup-performance: warm run ${index} reports a surviving lease`)
    }
  }
  const recomputed = summarizeWarmRuns(warm.runs)
  for (const key of ['totalMedianMs', 'totalP95Ms']) {
    if (warm[key] !== recomputed[key]) {
      throw new Error(`startup-performance: warm ${key} disagrees with the raw timelines`)
    }
  }
  for (const key of ['stageMediansMs', 'stageP95Ms']) {
    for (const stage of STAGES) {
      if (warm[key][stage] !== recomputed[key][stage]) {
        throw new Error(
          `startup-performance: warm ${key}.${stage} disagrees with the raw timelines`,
        )
      }
    }
  }
  return undefined
}

/**
 * Drive the packaged benchmark: install the candidate DMG once, run ONE
 * initialization trial then TEN sequential warm trials against the same
 * fixture, enforce per-run cleanup (launcher exit, home lease gone), and
 * return the validated report object (the caller writes it atomically).
 */
export async function runStartupPerformance({ artifact, identity }) {
  const { installFromDmg, runInstalledApp } = await import('./installed-app.mjs')
  const install = await installFromDmg(artifact.dmgPath, artifact.appName)
  const userData = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-m0-smoke-startup-perf-'))
  const home = path.join(userData, 'home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const lockPath = path.join(home, 'run', 'host-owner.json')
  const waitLeaseGone = async () => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const gone = await access(lockPath)
        .then(() => false)
        .catch((error) => error.code === 'ENOENT')
      if (gone) return
      if (Date.now() > deadline) {
        throw new Error('startup-performance: host owner record survived the app exit')
      }
      await sleep(200)
    }
  }

  const trials = []
  try {
    for (let index = 0; index < 11; index += 1) {
      const reports = await runInstalledApp({
        executable: install.executable,
        mode: 'startup-perf',
        userData,
        cwd: userData,
        timeoutMs: 300_000,
        async action({ waitFor }) {
          await waitFor(
            (report) =>
              report.kind === 'startup-perf-stage' && report.stage === 'official-ui-ready',
            'official-ui-ready stage event',
          )
        },
      })
      const events = reports.filter((report) => report.kind === 'startup-perf-stage')
      validateTimeline(events)
      await waitLeaseGone()
      trials.push({ events })
    }
  } finally {
    await install.dispose()
    await (
      await import('node:fs/promises')
    ).rm(userData, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    })
  }

  const [initialization, ...warmRuns] = trials
  const warm = summarizeWarmRuns(warmRuns)
  return {
    schemaVersion: 1,
    candidate: {
      releaseId: identity.releaseId,
      dmgSha256: identity.dmgSha256,
      sourceCommit: identity.sourceCommit,
    },
    platform: {
      osRelease: identity.osRelease,
      arch: process.arch,
      node: process.versions.node,
      electron: identity.electron,
    },
    initialization: {
      events: initialization.events,
      stages: [...STAGES],
      totalMs: initialization.events[initialization.events.length - 1].elapsedMs,
    },
    warm: {
      runs: warmRuns.map((run) => ({ events: run.events })),
      totalMedianMs: warm.totalMedianMs,
      totalP95Ms: warm.totalP95Ms,
      stageMediansMs: warm.stageMediansMs,
      stageP95Ms: warm.stageP95Ms,
    },
  }
}
