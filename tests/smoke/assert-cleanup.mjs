import { spawn } from 'node:child_process'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const launcherDir = path.join(root, 'apps', 'desktop-launcher')

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitUntilDead(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`process ${pid} survived smoke shutdown`)
}

export const smokeDirectoryPrefix = 'dsh-desktop-m0-smoke-'

async function assertSafeCleanupTarget(target, prefixes = [smokeDirectoryPrefix]) {
  const resolved = path.resolve(target)
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !prefixes.some((prefix) => path.basename(resolved).startsWith(prefix))
  ) {
    throw new Error(`refusing to clean an unexpected smoke target: ${resolved}`)
  }
  const stat = await lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing to clean a non-directory smoke target: ${resolved}`)
  }
}

async function runCommand(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code} and signal ${signal}`))
    })
  })
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
  stream.on('end', () => {
    if (pending.length > 0) onLine(pending)
  })
}

export async function runLauncherSmoke(mode) {
  await runCommand('pnpm', ['--filter', '@deskwork/desktop-launcher', 'build'], {
    cwd: root,
    env: process.env,
  })
  const userData = await mkdtemp(path.join(tmpdir(), smokeDirectoryPrefix))
  const reports = []
  let child
  let timeout
  try {
    const requireFromLauncher = createRequire(path.join(launcherDir, 'package.json'))
    const electronPath = requireFromLauncher('electron')
    child = spawn(electronPath, ['.'], {
      cwd: launcherDir,
      detached: true,
      env: {
        ...process.env,
        DSH_DESKTOP_SMOKE: mode,
        DSH_DESKTOP_M0_USER_DATA: userData,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const capture = (line) => {
      process.stdout.write(`${line}\n`)
      const prefix = 'DSH_DESKTOP_SMOKE '
      if (!line.startsWith(prefix)) return
      reports.push(JSON.parse(line.slice(prefix.length)))
    }
    consumeLines(child.stdout, capture)
    consumeLines(child.stderr, (line) => process.stderr.write(`${line}\n`))

    const exit = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${mode} smoke timed out`)), 60_000)
    })
    const result = await Promise.race([exit, timedOut])
    if (result.code !== 0) {
      throw new Error(`launcher exited with code ${result.code} and signal ${result.signal}`)
    }
    const failed = reports.find((report) => report.kind === 'failed')
    if (failed !== undefined) throw new Error(`launcher reported failure at ${failed.stage}`)

    const pids = new Set(
      reports.flatMap((report) =>
        [report.launcherPid, report.hostPid].filter(Number.isSafeInteger),
      ),
    )
    for (const pid of pids) await waitUntilDead(pid)
    return reports
  } finally {
    clearTimeout(timeout)
    if (child !== undefined && isAlive(child.pid)) {
      process.kill(-child.pid, 'SIGTERM')
      try {
        await waitUntilDead(child.pid, 2_000)
      } catch {
        process.kill(-child.pid, 'SIGKILL')
        await waitUntilDead(child.pid)
      }
    }
    await assertSafeCleanupTarget(userData)
    await rm(userData, { recursive: true })
  }
}

export function requireReport(reports, kind) {
  const report = reports.find((candidate) => candidate.kind === kind)
  if (report === undefined) throw new Error(`launcher did not report ${kind}`)
  return report
}
