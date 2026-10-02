// Shared driver for the Desktop smoke scripts: build the workspace, boot the
// real launcher against an isolated fixture, talk to its authenticated surface,
// and make sure nothing survives the shutdown.
import { spawn } from 'node:child_process'
import { clearTimeout, setTimeout } from 'node:timers'
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { createMockLlm } from './mock-llm.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const launcherDirectory = path.join(repositoryRoot, 'apps', 'desktop-launcher')
const requireFromLauncher = createRequire(path.join(launcherDirectory, 'package.json'))
const electronBinary = requireFromLauncher('electron')

const SENTINEL_REF = 'DSH_SHARED_HOME_SENTINEL'
const fixturePrefix = 'dsh-desktop-m0-smoke-'

export async function createSharedHomeFixture() {
  // The userData prefix must satisfy the launcher smoke override contract so
  // the Desktop entry can boot against this exact fixture.
  const userData = await mkdtemp(path.join(tmpdir(), fixturePrefix))
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
  const { mkdir, realpath } = await import('node:fs/promises')
  await mkdir(target, { recursive: true })
  return realpath(target)
}

/** Snapshot the identity (realpath + dev/ino) a cleanup must re-verify. */
async function recordDirectoryIdentity(target) {
  const { lstat, realpath } = await import('node:fs/promises')
  const stat = await lstat(target)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`desktop fixture must be a real directory: ${target}`)
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
    !path.basename(resolved).startsWith(fixturePrefix) ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== recorded.dev ||
    stat.ino !== recorded.ino ||
    (await realpath(resolved)) !== recorded.canonical ||
    (await realpath(tmpdir())) !== recorded.canonicalParent
  ) {
    throw new Error(`refusing to clean an unexpected desktop fixture: ${resolved}`)
  }
  await rm(resolved, { recursive: true })
}

/** Build the workspace before spawning the app. */
export async function ensureLauncherBuilt() {
  for (const [command, args] of [['pnpm', ['run', 'build']]]) {
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

function consumeLines(stream, onLine) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    pending += chunk
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline === -1) break
      onLine(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
    }
  })
  stream.on('end', () => {
    if (pending.length > 0) onLine(pending)
  })
}

/**
 * Boot the Desktop app against `home`/`userData` in the launcher's scripted
 * smoke mode (default `shared-home`), expose its authenticated surface to
 * `action`, then stop it with SIGTERM so the normal before-quit chain releases
 * the lease.
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
      () => reports.find((candidate) => candidate.kind === 'ui-ready'),
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
  throw new Error(`process ${pid} survived desktop shutdown`)
}

/** Create one turn in a fresh or adopted session through a web API client. */
export async function driveOneTurn(client, { cwd, sessionId, text }) {
  const created = await client.rpc('session/create', {
    request: sessionId === undefined ? { cwd } : { sessionId, cwd },
  })
  const target = created.sessionId
  await client.rpc('session/prompt', {
    request: {
      requestId: `desktop-driver-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      sessionId: target,
      mode: 'queue',
      content: [{ type: 'text', text: text ?? 'continue the conversation' }],
    },
  })
  return target
}
