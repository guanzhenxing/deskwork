import { spawn } from 'node:child_process'
import { clearTimeout, setTimeout } from 'node:timers'
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { createMockLlm } from './mock-llm.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dshNativeScript = path.join(repositoryRoot, 'scripts', 'dsh-native.mjs')
const launcherDirectory = path.join(repositoryRoot, 'apps', 'desktop-launcher')
const requireFromLauncher = createRequire(path.join(launcherDirectory, 'package.json'))
const electronBinary = requireFromLauncher('electron')

export const SENTINEL_REF = 'DSH_SHARED_HOME_SENTINEL'

export async function createSharedHomeFixture() {
  // The userData prefix must satisfy the launcher smoke override contract so
  // the Desktop entry can boot against this exact fixture.
  const userData = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-m0-smoke-'))
  const recorded = await recordDirectoryIdentity(userData)
  const home = path.join(userData, 'home')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const cwdDirectory = await realpathish(path.join(userData, 'cwd'))
  const mockLlm = createMockLlm()
  const baseURL = await mockLlm.started
  const sentinel = `sentinel-${Date.now()}-${Math.floor(Math.random() * 1e9)}`

  await writeFile(
    path.join(home, '.credentials.yaml'),
    `version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-mock-shared-home\n  ${SENTINEL_REF}: ${sentinel}\n`,
  )
  await chmod(path.join(home, '.credentials.yaml'), 0o600)
  await writeFile(path.join(home, 'settings.yaml'), `llm-deepseek:\n  baseURL: ${baseURL}\n`)
  // Plain JSONL keeps the scenario assertions about persisted turns readable;
  // this patch belongs to the synthetic fixture only.
  await writeFile(
    path.join(home, 'cordis.patch.yml'),
    "- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('sessions')\n    compression: none\n",
  )

  async function dispose() {
    await mockLlm.stop()
    await removeVerifiedTree(userData, recorded)
  }

  return {
    userData,
    home,
    cwd: cwdDirectory,
    mockLlm,
    sentinel,
    baseURL,
    dispose,
  }
}

async function realpathish(target) {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(target, { recursive: true })
  const { realpath } = await import('node:fs/promises')
  return realpath(target)
}

/** Snapshot the identity (realpath + dev/ino) a cleanup must re-verify. */
async function recordDirectoryIdentity(target) {
  const { lstat, realpath } = await import('node:fs/promises')
  const stat = await lstat(target)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`shared-home fixture must be a real directory: ${target}`)
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    canonical: await realpath(target),
    canonicalParent: await realpath(tmpdir()),
  }
}

async function removeVerifiedTree(target, recorded) {
  const resolved = path.resolve(target)
  const { lstat, realpath, rm } = await import('node:fs/promises')
  const stat = await lstat(resolved)
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith('dsh-desktop-m0-smoke-') ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== recorded.dev ||
    stat.ino !== recorded.ino ||
    (await realpath(resolved)) !== recorded.canonical ||
    (await realpath(tmpdir())) !== recorded.canonicalParent
  ) {
    throw new Error(`refusing to clean an unexpected shared-home fixture: ${resolved}`)
  }
  await rm(resolved, { recursive: true })
}

/** Build the workspace (and the native helper) before spawning the app. */
export async function ensureLauncherBuilt() {
  const { spawn } = await import('node:child_process')
  for (const [command, args] of [
    ['pnpm', ['run', 'build']],
    ['pnpm', ['run', 'build:native']],
  ]) {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: repositoryRoot, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve(undefined)
        else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
      })
    })
  }
}

export async function runDshNative(argv, options = {}) {
  const child = spawn(process.execPath, [dshNativeScript, ...argv], {
    cwd: options.cwd ?? repositoryRoot,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      DSH_TELEMETRY_DISABLED: '1',
      DESKWORK_HOME: options.home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => output.push(chunk))
  }
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  return { ...exit, output: output.join('') }
}

function consumeLines(stream, onLine) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    pending += chunk
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      onLine(line)
    }
  })
}

/**
 * Boot the Electron Desktop against the fixture home in the given smoke mode
 * (default `shared-home`), expose its authenticated surface to `action`, then
 * stop it with SIGTERM so the normal before-quit chain releases the lease.
 */
export async function withDesktop(home, userData, action, mode = 'shared-home') {
  let desktopExit
  const child = spawn(electronBinary, ['.'], {
    cwd: launcherDirectory,
    env: {
      ...process.env,
      DSH_DESKTOP_SMOKE: mode,
      DSH_DESKTOP_M0_USER_DATA: userData,
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const reports = []
  const nextReport = (predicate) => waitFor(() => reports.find(predicate), 90_000, 'desktop report')
  consumeLines(child.stdout, (line) => {
    if (line.startsWith('DSH_DESKTOP_SMOKE ')) {
      reports.push(JSON.parse(line.slice('DSH_DESKTOP_SMOKE '.length)))
    } else {
      process.stdout.write(`${line}\n`)
    }
  })
  consumeLines(child.stderr, (line) => process.stderr.write(`${line}\n`))
  // Watch the exit from spawn time: modes that quit themselves (lifecycle)
  // can be gone before the finally block attaches a listener.
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  try {
    const ready = await waitFor(
      () => {
        const report = reports.find((candidate) => candidate.kind === 'ui-ready')
        if (report === undefined) return undefined
        return report
      },
      90_000,
      'desktop ui-ready report',
    )
    // The authenticated URL arrives through the userData file, never stdout.
    if (ready.surfaceUrlFile !== 'surface-url') {
      throw new Error('desktop ui-ready report did not point at the surface URL file')
    }
    const surfaceUrl = (await readFile(path.join(userData, 'surface-url'), 'utf8')).trim()
    const client = await createWebApiClient(surfaceUrl)
    await action({
      client,
      surfaceUrl,
      report: ready,
      reports,
      waitForReport: (predicate) => nextReport(predicate),
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    const exit = await exited
    clearTimeout(killTimer)
    await waitUntilDead(child.pid)
    if (exit.code !== 0) {
      desktopExit = new Error(`desktop exited with code ${exit.code} and signal ${exit.signal}`)
    }
  }
  if (desktopExit !== undefined) throw desktopExit
}

/** Boot `dsh-native --profile web` and expose its authenticated API. */
export async function withCliWeb(home, cwd, action) {
  const child = spawn(
    process.execPath,
    [dshNativeScript, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
    {
      cwd,
      env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', DESKWORK_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let url
  const output = []
  try {
    for (const stream of [child.stdout, child.stderr]) {
      consumeLines(stream, (line) => {
        output.push(line)
        const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._-]+/.exec(line)
        if (match !== null && url === undefined) url = match[0]
      })
    }
    await waitFor(() => url, 90_000, 'dsh-native web surface URL')
    const client = await createWebApiClient(url)
    await action({ client, surfaceUrl: url })
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(undefined)
      }, 30_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
    })
    await waitUntilDead(child.pid)
  }
}

export async function createWebApiClient(surfaceUrl) {
  const login = await globalThis.fetch(surfaceUrl, { redirect: 'manual' })
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0]
  if (cookie === undefined) throw new Error('surface URL did not establish a session cookie')
  const origin = new URL(surfaceUrl).origin
  let rpcId = 0
  return {
    async rpc(method, args) {
      const [namespace, endpoint] = method.split('/')
      rpcId += 1
      const response = await globalThis.fetch(`${origin}/api/${namespace}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: String(rpcId),
          method,
          payload: { args },
        }),
      })
      const body = await response.json()
      const result = body?.result
      if (result?.ok !== true) {
        throw new Error(`rpc ${method} failed: ${JSON.stringify(result ?? body).slice(0, 400)}`)
      }
      return result.value
    },
  }
}

export async function listSessions(home) {
  const root = path.join(home, 'sessions')
  const sessions = []
  for (const project of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue
    for (const session of await readdir(path.join(root, project.name), {
      withFileTypes: true,
    })) {
      const sessionDir = path.join(root, project.name, session.name)
      // The engine names session files by their format version (v4 in the
      // rc.2 baseline); fall back to the plain name for older-engine homes.
      let file = path.join(sessionDir, 'session.v4.jsonl')
      let content = await readFile(file, 'utf8').catch(() => undefined)
      if (content === undefined) {
        file = path.join(sessionDir, 'session.jsonl')
        content = await readFile(file, 'utf8').catch(() => undefined)
      }
      if (content === undefined) continue
      const nonEmpty = content.split('\n').filter(Boolean)
      const lines = nonEmpty
        .map((line, index) => {
          try {
            return JSON.parse(line)
          } catch {
            // A trailing line still being appended (no closing newline) can
            // be torn mid-write; anything else is real corruption and must
            // fail loudly instead of vanishing into a count mismatch.
            if (index === nonEmpty.length - 1 && !content.endsWith('\n')) return undefined
            throw new Error(`session jsonl corrupt at ${file}: ${line.slice(0, 120)}`)
          }
        })
        .filter((line) => line !== undefined)
      sessions.push({
        file,
        header: lines.find((line) => line.type === 'session'),
        turns: lines.filter((line) => line.type === 'turn/end').length,
      })
    }
  }
  return sessions
}

export async function waitForTurns(sessionFile, expected, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let turns = 0
  while (Date.now() < deadline) {
    const content = await readFile(sessionFile, 'utf8').catch(() => '')
    turns = content
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        try {
          return JSON.parse(line).type === 'turn/end'
        } catch {
          return false
        }
      }).length
    if (turns >= expected) return turns
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return turns
}

async function waitForSession(home, sessionId, timeoutMs = 30_000) {
  return await waitFor(
    async () => {
      const sessions = await listSessions(home)
      return sessions.find((session) => session.header.id === sessionId)
    },
    timeoutMs,
    `session ${sessionId} to persist`,
  )
}

async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

export async function waitUntilDead(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`process ${pid} survived shared-home shutdown`)
}

/** Create one turn in a fresh or adopted session through a web API client. */
export async function driveOneTurn(client, { cwd, sessionId, text }) {
  const created = await client.rpc('session/create', {
    request: sessionId === undefined ? { cwd } : { sessionId, cwd },
  })
  const target = created.sessionId
  await client.rpc('session/prompt', {
    request: {
      requestId: `dsh-native-driver-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      sessionId: target,
      mode: 'queue',
      content: [{ type: 'text', text: text ?? 'continue the conversation' }],
    },
  })
  return target
}

export async function firstSessionId(client) {
  const listed = await client.rpc('session/list', { _request: {} })
  return listed.items[0]?.sessionId
}

/**
 * One full bidirectional scenario over a synthetic shared home.
 *
 * `cli-to-desktop`: the CLI creates the session, the Desktop lists and
 * continues it. `desktop-to-cli`: the Desktop creates it, the CLI continues.
 * Both entries run the real official DSH graph against the mock LLM.
 */
export async function runSharedHomeScenario(direction) {
  const fixture = await createSharedHomeFixture()
  try {
    let sessionId
    if (direction === 'cli-to-desktop') {
      const created = await runDshNative(['--profile', 'headless', 'start the shared session'], {
        home: fixture.home,
        cwd: fixture.cwd,
      })
      if (created.code !== 0) {
        throw new Error(`headless creation failed (${created.code}): ${created.output.slice(-400)}`)
      }
      const sessions = await listSessions(fixture.home)
      if (sessions.length !== 1 || sessions[0].turns !== 1) {
        throw new Error(
          `expected one persisted session with one turn, got ${JSON.stringify(
            sessions.map((session) => ({ turns: session.turns })),
          )}`,
        )
      }
      sessionId = sessions[0].header.id
      await withDesktop(fixture.home, fixture.userData, async ({ client }) => {
        const listed = await client.rpc('session/list', { _request: {} })
        const found = listed.items.find((item) => item.sessionId === sessionId)
        if (found === undefined) {
          throw new Error('desktop did not list the CLI-created session')
        }
        const continued = await driveOneTurn(client, {
          cwd: fixture.cwd,
          sessionId,
          text: 'continue from the desktop',
        })
        if (continued !== sessionId) throw new Error('desktop continuation changed the session id')
        await waitForTurns(sessions[0].file, 2)
      })
    } else if (direction === 'desktop-to-cli') {
      await withDesktop(fixture.home, fixture.userData, async ({ client }) => {
        sessionId = await driveOneTurn(client, {
          cwd: fixture.cwd,
          text: 'start from the desktop',
        })
        const created = await waitForSession(fixture.home, sessionId)
        await waitForTurns(created.file, 1)
      })
      await withCliWeb(fixture.home, fixture.cwd, async ({ client }) => {
        const listed = await client.rpc('session/list', { _request: {} })
        const found = listed.items.find((item) => item.sessionId === sessionId)
        if (found === undefined) {
          throw new Error('dsh-native web did not list the desktop-created session')
        }
        const continued = await driveOneTurn(client, {
          cwd: fixture.cwd,
          sessionId,
          text: 'continue from the cli',
        })
        if (continued !== sessionId) throw new Error('cli continuation changed the session id')
        const sessions = await listSessions(fixture.home)
        await waitForTurns(sessions.find((session) => session.header.id === sessionId).file, 2)
      })
    } else {
      throw new Error(`unknown direction ${JSON.stringify(direction)}`)
    }

    const sessions = await listSessions(fixture.home)
    const target = sessions.find((session) => session.header.id === sessionId)
    const persistedTurns = target?.turns ?? 0
    const credentials = await readFile(path.join(fixture.home, '.credentials.yaml'), 'utf8')
    if (!credentials.includes(fixture.sentinel)) {
      throw new Error('shared credentials lost the fixture sentinel')
    }
    const credentialCopies = await countCredentialCopies(fixture.userData)
    if (credentialCopies !== 1) {
      throw new Error(`expected exactly one credentials file, found ${credentialCopies}`)
    }
    return { sessionId, persistedTurns, home: fixture.home }
  } finally {
    await fixture.dispose()
  }
}

async function countCredentialCopies(userData) {
  let count = 0
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(target)
      else if (entry.name === '.credentials.yaml') count += 1
    }
  }
  await walk(userData)
  return count
}
