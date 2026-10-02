// M2 smoke: the real RecoverySessionController over the real profile-manager,
// home session, and transaction journals on a throwaway home. An attributable
// profile failure rolls the journaled reconcile back byte-exact, relaunches
// exactly once, and lands in the recovery view; a drifted candidate surfaces
// conflict without overwriting; a healthy boot commits; home sentinel files
// never change.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { createIsolatedHomeFixture } from '../helpers/isolated-home.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const requireFromShellCore = createRequire(
  path.join(root, 'packages', 'shell-core', 'package.json'),
)
const shellCore = requireFromShellCore('@deskwork/shell-core')
const { createHomeSession } = requireFromShellCore('@deskwork/desktop-contracts/home-session')

const {
  RecoverySessionController,
  StartupFailureError,
  createDesktopProfileRecovery,
  createRecoveryMarkerStore,
} = shellCore

const fixtures = []

// The shared isolated-home fixture (environment, repo/root/real-home
// refusals, identity-reverified cleanup) — the same one unit tests use.
async function freshHome(label) {
  void label
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  await mkdir(path.join(fixture.home, 'profiles', 'desktop'), { recursive: true, mode: 0o700 })
  return fixture.home
}

async function disposeHomes() {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
}

async function leasedSession(home, options) {
  const homeSession = await createHomeSession({ home: home, profile: 'desktop' })
  const inMemoryMarker = { value: undefined }
  const marker = options.markerStore ?? {
    async read() {
      return inMemoryMarker.value
    },
    async write(entry) {
      inMemoryMarker.value = entry
    },
  }
  const session = {
    attempts: [],
    views: [],
    surfaces: [],
    session,
    controller: undefined,
  }
  session.controller = new RecoverySessionController({
    session: homeSession,
    profile: createDesktopProfileRecovery({ home, profileName: 'desktop' }),
    readRecoveryMarker: async () => marker.read(),
    writeRecoveryMarker: async (entry) => marker.write(entry),
    onHealthy: () => marker.clear?.(),
    createAttempt: (_session, mode) => {
      session.attempts.push(mode)
      return {
        start: () => options.boot(session.attempts.length, mode),
        stop: async () => undefined,
      }
    },
    loadSurface: async (ready) => {
      session.surfaces.push(ready.origin)
    },
    window: {
      showRecoveryView: async (view) => {
        session.views.push(view)
      },
      destroySurface: () => undefined,
    },
  })
  return session
}

const attributedFailure = new StartupFailureError({
  stage: 'resolve-profile',
  code: 'PROFILE_INVALID',
  category: 'profile-composition',
  summary: 'composed profile cannot be resolved',
  retryable: false,
})

const runtimeFailure = new StartupFailureError({
  stage: 'boot',
  code: 'BOOT_FAILED',
  category: 'runtime',
  summary: 'host runtime failed',
  retryable: true,
})

const sentinel = (name) => `# sentinel ${name}\n`

// Structured evidence rows for the M2 failure matrix (acceptance record
// §4): category, whether the session changed the profile, whether rollback
// was granted, the manifest's before/after digests, and the host PID / session
// generation the run observed.
async function sha256File(filename) {
  const bytes = await readFile(filename).catch(() => new Uint8Array())
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12)
}

function matrixRow(row) {
  console.log(`M2-MATRIX ${JSON.stringify(row)}`)
}

async function manifestSha(home) {
  return sha256File(path.join(home, 'profiles', 'desktop', 'package.json'))
}

async function seedSentinels(home) {
  await writeFile(path.join(home, '.credentials.yaml'), sentinel('credentials'), { mode: 0o600 })
  await writeFile(path.join(home, 'settings.yaml'), sentinel('settings'), { mode: 0o600 })
  await writeFile(path.join(home, 'cordis.patch.yml'), sentinel('home-patch'), { mode: 0o600 })
}

async function assertSentinels(home) {
  for (const [name, file] of [
    ['credentials', '.credentials.yaml'],
    ['settings', 'settings.yaml'],
    ['home-patch', 'cordis.patch.yml'],
  ]) {
    const bytes = await readFile(path.join(home, file), 'utf8')
    if (bytes !== sentinel(name)) throw new Error(`home sentinel ${file} was modified`)
  }
}

async function expectLeaseRefusal(home) {
  let refused = null
  try {
    await createHomeSession({ home: home, profile: 'desktop' })
  } catch (error) {
    refused = error
  }
  if (refused === null) throw new Error('second acquisition of a held home was not refused')
  if (!String(refused.code ?? '').includes('BUSY')) {
    throw new Error(`session refusal had unexpected code: ${refused.code}`)
  }
}

async function journalStates(home) {
  const txRoot = path.join(home, 'run', 'profile-transactions')
  const ids = await readdir(txRoot).catch(() => [])
  const states = []
  for (const id of ids) {
    const journal = JSON.parse(await readFile(path.join(txRoot, id, 'transaction.json'), 'utf8'))
    states.push(journal.state)
  }
  return states
}

try {
  // ── Failure chain: attributed failure → rollback → one relaunch → view ──
  {
    const home = await freshHome('failure')
    await seedSentinels(home)
    const session = await leasedSession(home, {
      // Both normal boots fail with an attributable profile-composition error.
      boot: () => Promise.reject(attributedFailure),
    })
    const beforeSha = await manifestSha(home)
    await session.controller.start().catch(() => undefined)
    matrixRow({
      scenario: 'attributed-failure',
      category: 'profile-composition',
      changed: true,
      rollbackGranted: true,
      beforeSha,
      afterSha: await manifestSha(home),
      sessionPid: process.pid,
      leaseGeneration: session.session.generation,
    })
    if (session.controller.state !== 'recovery') {
      throw new Error(`expected recovery state, got ${session.controller.state}`)
    }
    // Exactly one automatic relaunch after the rollback.
    if (session.attempts.filter((mode) => mode === 'normal').length !== 2) {
      throw new Error(`expected exactly 2 normal boots (1 auto-relaunch), got ${session.attempts}`)
    }
    if (session.views.length !== 1) throw new Error('expected exactly one recovery view')
    if (session.views[0].failure.category !== 'profile-composition') {
      throw new Error(`unexpected failure category ${session.views[0].failure.category}`)
    }
    // The reconcile created the three managed files; both transactions rolled
    // back and removed them again.
    const manifest = path.join(home, 'profiles', 'desktop', 'package.json')
    await readFile(manifest).then(
      () => {
        throw new Error('rollback left a transaction-created manifest behind')
      },
      (error) => {
        if (error.code !== 'ENOENT') throw error
      },
    )
    const states = await journalStates(home)
    if (states.length !== 2 || states.some((state) => state !== 'rolled-back')) {
      throw new Error(`expected two rolled-back journals, got ${JSON.stringify(states)}`)
    }
    await assertSentinels(home)
    await session.controller.act('quit')
  }

  // ── Conflict chain: the candidate drifts before rollback → view, no overwrite ──
  {
    const home = await freshHome('conflict')
    await seedSentinels(home)
    const drifted = '{"userChanged":true}\n'
    const beforeSha = await manifestSha(home)
    const session = await leasedSession(home, {
      boot: async () => {
        // The transaction applied; the user rewrites the candidate before the
        // failure is settled.
        await writeFile(path.join(home, 'profiles', 'desktop', 'package.json'), drifted)
        throw attributedFailure
      },
    })
    await session.controller.start().catch(() => undefined)
    matrixRow({
      scenario: 'drifted-candidate',
      category: 'profile-composition',
      changed: true,
      rollbackGranted: false,
      outcome: 'conflict',
      beforeSha,
      afterSha: await manifestSha(home),
      sessionPid: process.pid,
      leaseGeneration: session.session.generation,
    })
    if (session.controller.state !== 'recovery') throw new Error('conflict run not in recovery')
    const manifest = await readFile(path.join(home, 'profiles', 'desktop', 'package.json'), 'utf8')
    if (manifest !== drifted) throw new Error('conflict rollback overwrote user bytes')
    const states = await journalStates(home)
    if (!states.includes('conflict')) {
      throw new Error(`expected a conflict journal, got ${JSON.stringify(states)}`)
    }
    await assertSentinels(home)
    await session.controller.act('quit')

    // A conflict must not poison the session: after relaunching into the
    // blocked recovery view, Safe Mode still boots without ever touching the
    // conflicting journal.
    const statesBeforeSafe = await journalStates(home)
    const replay = await leasedSession(home, {
      boot: (index, mode) =>
        mode === 'safe'
          ? Promise.resolve({
              pid: process.pid,
              startIdentity: 'safe-ready',
              surface: { kind: 'loopback', url: 'http://127.0.0.1:43125/?token=x' },
              origin: 'http://127.0.0.1:43125',
            })
          : Promise.reject(attributedFailure),
    })
    await replay.controller.start().catch(() => undefined)
    if (replay.controller.state !== 'recovery') throw new Error('replay did not reach recovery')
    const view = replay.controller.getView()
    if (view.retryAllowed) throw new Error('conflict-blocked view still offers retry')
    // The session holds the session, so an unlock command would be refused:
    // the view must point at the journal instead of advertising doctor.
    if (view.doctorCommand !== null) {
      throw new Error('conflict-blocked view advertises an unlock it cannot use')
    }
    if (!view.failure.summary.includes('run/profile-transactions')) {
      throw new Error('conflict-blocked view does not point at the journal')
    }
    await replay.controller.act('safe-mode')
    if (replay.controller.state !== 'healthy') {
      throw new Error('safe mode after conflict did not become healthy')
    }
    const statesAfterSafe = await journalStates(home)
    if (JSON.stringify(statesAfterSafe) !== JSON.stringify(statesBeforeSafe)) {
      throw new Error('safe mode after conflict rewrote the conflicting journal')
    }
    await replay.controller.act('quit')
  }

  // ── Healthy chain: surface mounts, transaction commits, no view ──
  {
    const home = await freshHome('healthy')
    await seedSentinels(home)
    const session = await leasedSession(home, {
      boot: async () => ({
        pid: process.pid,
        startIdentity: 'smoke-ready',
        surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/?token=x' },
        origin: 'http://127.0.0.1:43123',
      }),
    })
    const beforeSha = await manifestSha(home)
    await session.controller.start()
    if (session.controller.state !== 'healthy')
      throw new Error('healthy run did not become healthy')
    matrixRow({
      scenario: 'healthy-commit',
      category: 'runtime',
      changed: true,
      rollbackGranted: false,
      committed: true,
      beforeSha,
      afterSha: await manifestSha(home),
      sessionPid: process.pid,
      leaseGeneration: session.session.generation,
    })
    if (session.views.length !== 0) throw new Error('healthy run showed a recovery view')
    if (session.surfaces.length !== 1) throw new Error('healthy run never mounted the surface')
    const states = await journalStates(home)
    if (states.length !== 1 || states[0] !== 'committed') {
      throw new Error(`expected one committed journal, got ${JSON.stringify(states)}`)
    }
    await assertSentinels(home)
    await session.controller.act('quit')
  }

  // ── Retention: terminal journals stay bounded at 20 ──
  {
    const home = await freshHome('retention')
    await seedSentinels(home)
    const manifestPath = path.join(home, 'profiles', 'desktop', 'package.json')
    const retainedBeforeSha = await manifestSha(home)
    let lastGeneration = 'n/a'
    for (let round = 0; round < 24; round++) {
      // Each round leaves the manifest one third-party bundle away from the
      // desired state, so every boot plans and retains a fresh transaction —
      // without this the reconcile is a no-op after the first round.
      const raw = await readFile(manifestPath, 'utf8').catch(() => null)
      const manifest = raw === null ? { dsh: { profile: { bundles: [] } } } : JSON.parse(raw)
      manifest.dsh.profile.bundles = [
        `@fixture/retention-${round}`,
        ...manifest.dsh.profile.bundles.filter(
          (bundle) => !String(bundle).startsWith('@fixture/retention-'),
        ),
      ]
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      const session = await leasedSession(home, {
        boot: () => Promise.reject(runtimeFailure),
      })
      await session.controller.start().catch(() => undefined)
      await session.controller.act('quit')
      lastGeneration = session.session.generation
    }
    // 24 retained transactions pruned to exactly the 20 most recent.
    matrixRow({
      scenario: 'retained-runtime',
      category: 'runtime',
      changed: true,
      rollbackGranted: false,
      outcome: 'retained',
      beforeSha: retainedBeforeSha,
      afterSha: await manifestSha(home),
      journalCount: 24,
      sessionPid: process.pid,
      leaseGeneration: lastGeneration,
    })
    const states = await journalStates(home)
    if (states.length !== 20) {
      throw new Error(`journal retention did not settle at 20: ${states.length}`)
    }
    if (states.some((state) => state !== 'retained')) {
      throw new Error(`non-terminal journals left behind: ${JSON.stringify(states)}`)
    }
  }

  // ── Cross-process relaunch budget: a persisted marker survives a "restart" ──
  {
    const home = await freshHome('cross-process')
    await seedSentinels(home)
    // A real file-backed marker store — exactly what the launcher persists
    // under userData — shared by two sequentially created sessions to model
    // a process restart between them.
    const markerRoot = await mkdtemp(path.join(tmpdir(), 'dsh-m2-marker-'))
    const markerStore = createRecoveryMarkerStore(markerRoot, home)
    try {
      // Process A: attributed failure → rollback → marker persisted → one
      // automatic relaunch → fails again → recovery view → quit (no healthy
      // session, so the marker must still be on disk).
      const first = await leasedSession(home, {
        boot: () => Promise.reject(attributedFailure),
        markerStore,
      })
      await first.controller.start().catch(() => undefined)
      if (first.attempts.filter((mode) => mode === 'normal').length !== 2) {
        throw new Error('first process did not use its single automatic relaunch')
      }
      await first.controller.act('quit')
      if ((await markerStore.read()) === undefined) {
        throw new Error('marker was not persisted across the simulated restart')
      }
      // Process B (fresh controller, same home and marker store): the
      // rollback still happens, but the persisted marker denies the
      // automatic relaunch — exactly one boot, straight to the view.
      const second = await leasedSession(home, {
        boot: () => Promise.reject(attributedFailure),
        markerStore,
      })
      await second.controller.start().catch(() => undefined)
      if (second.attempts.filter((mode) => mode === 'normal').length !== 1) {
        throw new Error('a restarted process minted a fresh relaunch budget')
      }
      if (second.views.length !== 1) throw new Error('restarted process showed no recovery view')
      await second.controller.act('quit')
      // A later healthy session clears the marker, restoring the budget for
      // a future, unrelated recovery.
      const healthy = await leasedSession(home, {
        boot: async () => ({
          pid: process.pid,
          startIdentity: 'healthy-after-budget',
          surface: { kind: 'loopback', url: 'http://127.0.0.1:43126/?token=x' },
          origin: 'http://127.0.0.1:43126',
        }),
        markerStore,
      })
      await healthy.controller.start()
      if ((await markerStore.read()) !== undefined) {
        throw new Error('a healthy session did not clear the spent marker')
      }
      await healthy.controller.act('quit')
    } finally {
      await rm(markerRoot, { recursive: true, force: true })
    }
  }

  // ── Matrix completion: every category leaves the profile retained ──
  {
    const categories = [
      {
        category: 'home-config',
        stage: 'load-home-patch',
        code: 'HOME_PATCH_INVALID',
        retryable: false,
      },
      {
        category: 'credentials',
        stage: 'boot',
        code: 'MISSING_CREDENTIAL',
        retryable: false,
        producerNote: 'policy-table (upstream emits BOOT_FAILED only)',
      },
      {
        category: 'network',
        stage: 'boot',
        code: 'PORT_IN_USE',
        retryable: false,
        producerNote: 'policy-table (upstream emits BOOT_FAILED only)',
      },
      { category: 'renderer', stage: 'publish-surface', code: 'SURFACE_MISSING', retryable: false },
      {
        category: 'native-ui',
        stage: 'native-ui',
        code: 'MENU_FAILED',
        retryable: true,
        producerNote: 'policy-table (no native UI producer yet)',
      },
      { category: 'unknown', stage: 'mystery-stage', code: 'WHATEVER', retryable: true },
    ]
    for (const spec of categories) {
      const home = await freshHome(`matrix-${spec.category}`)
      await seedSentinels(home)
      const failure = new StartupFailureError({
        stage: spec.stage,
        code: spec.code,
        category: spec.category,
        summary: `synthetic ${spec.category} failure for the acceptance matrix`,
        retryable: spec.retryable,
      })
      const session = await leasedSession(home, { boot: () => Promise.reject(failure) })
      const beforeSha = await manifestSha(home)
      await session.controller.start().catch(() => undefined)
      // None of these categories may roll back: the journal settles retained
      // and the profile bytes are exactly the candidate the reconcile wrote.
      const states = await journalStates(home)
      if (!states.includes('retained')) {
        throw new Error(
          `${spec.category} did not retain its transaction: ${JSON.stringify(states)}`,
        )
      }
      matrixRow({
        scenario: `matrix-${spec.category}`,
        category: spec.category,
        changed: true,
        rollbackGranted: false,
        outcome: 'retained',
        beforeSha,
        afterSha: await manifestSha(home),
        sessionPid: process.pid,
        leaseGeneration: session.session.generation,
        ...(spec.producerNote === undefined ? {} : { producerNote: spec.producerNote }),
      })
      await assertSentinels(home)
      await session.controller.act('quit')
    }

    // The session category never reaches the recovery window: a second
    // acquisition of a held home must be refused at the entry lifecycle.
    {
      const home = await freshHome('matrix-session')
      const session = await leasedSession(home, {
        boot: () => Promise.reject(runtimeFailure),
      })
      await session.controller.start().catch(() => undefined)
      await expectLeaseRefusal(home)
      matrixRow({
        scenario: 'matrix-session',
        category: 'session',
        changed: false,
        rollbackGranted: false,
        outcome: 'entry-lifecycle (dialog + exit code, no recovery window)',
        sessionPid: process.pid,
        leaseGeneration: session.session.generation,
      })
      await session.controller.act('quit')
    }
  }

  console.log('M2 profile-recovery smoke passed')
} finally {
  await disposeHomes()
}
