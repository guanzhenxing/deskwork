// Headless boot smoke: the `deskwork` profile must boot inside a plain Node
// process — no Electron anywhere in the picture — publish the official Web UI
// on loopback, and compose the complete official client graph. This is the
// evidence that the host layer is reusable outside the desktop shell, and it is
// the signal that must stay green across every upstream engine upgrade.
import assert from 'node:assert/strict'
import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'

import {
  createEnvelopeWriter,
  parseHostEnvelope,
} from '../../packages/desktop-contracts/lib/host-control.js'
import { runDshHost } from '../../packages/host-supervisor/lib/host-runner.js'
import {
  createIsolatedHomeAuthority,
  createProfileRef,
  reconcileDesktopProfile,
} from '../../packages/profile-manager/lib/index.js'
import { createIsolatedHomeFixture } from '../helpers/isolated-home.mjs'

const surfaceDeadlineMs = 180_000
const capability = 'h'.repeat(43)
const leaseGeneration = 'headless-boot-smoke'
const breakMode = process.env.DSH_HEADLESS_SMOKE_BREAK

/**
 * Self-break hook, mirroring the launcher's scripted smoke sequences: it proves the
 * smoke fails loudly when the profile cannot boot instead of passing on a degraded path.
 */
async function applyBreakMode(ref) {
  if (breakMode === undefined || breakMode === '') return
  if (breakMode !== 'profile-patch') {
    throw new Error(`unknown DSH_HEADLESS_SMOKE_BREAK mode ${JSON.stringify(breakMode)}`)
  }
  const patchPath = path.join(ref.dir, 'cordis.patch.yml')
  await writeFile(patchPath, 'this is not a loader patch array\n')
  console.log('headless boot smoke: broke the profile patch layer on purpose')
}

/** Loaded native modules that would prove Electron is in the picture. */
function loadedElectronEntries() {
  const loadList = process.moduleLoadList
  if (!Array.isArray(loadList)) return []
  return loadList.filter((entry) => /electron/iu.test(entry))
}

function assertNoElectron(stage) {
  assert.equal(
    process.versions.electron,
    undefined,
    `${stage}: the smoke must run under plain Node, not Electron`,
  )
  assert.deepEqual(loadedElectronEntries(), [], `${stage}: Electron modules were loaded`)
}

/** Launcher side of Host-control over an in-process loopback transport. */
class LoopbackTransport {
  #listener
  #writer
  #settle
  #fail

  constructor() {
    this.messages = []
    this.#writer = createEnvelopeWriter('launcher-to-host', capability, leaseGeneration)
    this.surface = new Promise((resolve, reject) => {
      this.#settle = resolve
      this.#fail = reject
    })
  }

  postMessage(message) {
    this.messages.push(message)
    const envelope = parseHostEnvelope(message)
    if (envelope.message.kind === 'hello') {
      globalThis.queueMicrotask(() =>
        this.emit(this.#writer.next({ kind: 'accept', selectedMinor: 0 })),
      )
    }
    if (envelope.message.kind === 'surface') this.#settle(envelope.message.surface)
    if (envelope.message.kind === 'fatal') {
      this.#fail(
        new Error(
          `Host reported a fatal boot failure at ${envelope.message.stage}: ${envelope.message.summary}`,
        ),
      )
    }
  }

  onMessage(listener) {
    this.#listener = listener
    return () => {
      this.#listener = undefined
    }
  }

  emit(message) {
    this.#listener?.(message)
  }
}

async function withDeadline(promise, label) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${surfaceDeadlineMs}ms`)),
      surfaceDeadlineMs,
    )
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Walk the authenticated loopback surface exactly as the desktop shell does:
 * the first request redirects, the redirect target carries the boot graph the
 * official web client renders from.
 */
async function readOfficialBootGraph(surfaceUrl) {
  const login = await globalThis.fetch(surfaceUrl, { redirect: 'manual' })
  assert.ok(
    [302, 303].includes(login.status),
    `surface login must redirect, received ${String(login.status)}`,
  )
  const location = login.headers.get('location')
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0]
  assert.ok(location !== null, 'surface login did not return a redirect target')
  assert.ok(cookie !== undefined, 'surface login did not establish a session cookie')
  const page = await globalThis.fetch(new URL(location, surfaceUrl), { headers: { cookie } })
  assert.equal(page.status, 200, 'authenticated surface did not serve the official page')
  const html = await page.text()
  const bootMatch = /globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/u.exec(html)
  assert.ok(bootMatch?.[1] !== undefined, 'official page did not inject a boot graph')
  return JSON.parse(bootMatch[1])
}

function assertOfficialClientGraph(bootGraph) {
  const ids = bootGraph.entries.map((entry) => entry.id)
  for (const required of [
    '@deepseek-ai/dsh-client-modules',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-layout',
  ]) {
    assert.ok(ids.includes(required), `official boot graph is missing ${required}`)
  }
  assert.ok(
    bootGraph.batches.some(
      (batch) =>
        batch.phase === 'bootstrap' && batch.entries.includes('@deepseek-ai/dsh-client-modules'),
    ),
    'official boot graph did not bootstrap its client modules',
  )
}

assertNoElectron('startup')

const fixture = await createIsolatedHomeFixture()
let host

try {
  const ref = createProfileRef(fixture.home, 'deskwork')
  await reconcileDesktopProfile(
    ref,
    createIsolatedHomeAuthority(fixture.home, path.dirname(fixture.home)),
  )
  await applyBreakMode(ref)

  const transport = new LoopbackTransport()
  host = await runDshHost({
    home: fixture.home,
    profileName: 'deskwork',
    mode: 'normal',
    capability,
    leaseGeneration,
    hostIdentity: { pid: process.pid, startIdentity: leaseGeneration },
    transport,
  })

  const surface = await withDeadline(transport.surface, 'loopback surface publication')
  assert.equal(surface.kind, 'loopback', 'surface must be a loopback surface')
  assert.match(surface.url, /^http:\/\/127\.0\.0\.1:\d+/u, `unexpected surface url ${surface.url}`)

  const bootGraph = await readOfficialBootGraph(surface.url)
  assertOfficialClientGraph(bootGraph)
  assertNoElectron('after boot')

  console.log(
    `headless boot smoke passed: profile deskwork booted in plain Node and served the official Web UI (${bootGraph.entries.length} client entries)`,
  )
} finally {
  if (host !== undefined) await host.dispose().catch(() => undefined)
  await fixture.dispose()
}

const homeSurvived = await stat(fixture.home).then(
  () => true,
  () => false,
)
assert.equal(homeSurvived, false, 'the isolated home must be removed after the smoke')
