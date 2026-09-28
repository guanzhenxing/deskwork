import { spawn, spawnSync } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { defaultLeaseHelperPath } from '@dsh-desktop/home-lease'

import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'
import { withCliWeb } from '../../../tests/helpers/shared-home-driver.mjs'

const helperPath = defaultLeaseHelperPath()
const holderScript = fileURLToPath(
  new URL('../../../tests/fixtures/lease-holder.mjs', import.meta.url),
)
const dshNativeScript = fileURLToPath(new URL('../../../scripts/dsh-native.mjs', import.meta.url))

const helperAvailable =
  process.platform === 'darwin' &&
  spawnSync(helperPath, ['identity', String(process.pid)], { timeout: 5_000 }).status === 0

const fixtures: IsolatedHomeFixture[] = []

async function isolatedHome(): Promise<string> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  return fixture.home
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

function startHolder(home: string) {
  const child = spawn(process.execPath, [holderScript, home], {
    env: { ...process.env, DSH_DESKTOP_LEASE_HELPER: helperPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  let settleAcquired!: (won: boolean) => void
  const acquired = new Promise<boolean>((resolve) => {
    settleAcquired = resolve
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('ACQUIRED ')) settleAcquired(true)
    }
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      settleAcquired(false)
      resolve({ code, signal })
    })
  })
  return {
    child,
    acquired,
    exited,
    requestRelease() {
      child.stdin.write('release\n')
    },
  }
}

function runDoctor(home: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dshNativeScript, 'doctor', '--unlock'], {
      env: { ...process.env, DESKWORK_HOME: home, DSH_DESKTOP_LEASE_HELPER: helperPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        output += chunk
      })
    }
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, output }))
  })
}

async function ownerSupervisorPid(home: string): Promise<number | undefined> {
  const raw = await readFile(path.join(home, 'run', 'host.lock', 'owner.json'), 'utf8').catch(
    () => undefined,
  )
  if (raw === undefined) return undefined
  return (JSON.parse(raw) as { supervisor: { pid: number } }).supervisor.pid
}

describe.skipIf(!helperAvailable)('doctor and acquisition race', () => {
  it('never lets a doctor remove a lock a concurrent acquirer just won', async () => {
    for (let round = 0; round < 3; round += 1) {
      const home = await isolatedHome()
      // Create a stale lock: acquire, then kill without releasing.
      const stale = startHolder(home)
      expect(await stale.acquired).toBe(true)
      stale.child.kill('SIGKILL')
      await stale.exited

      // Race two doctors against one fresh acquirer.
      const acquirer = startHolder(home)
      const doctors = [runDoctor(home), runDoctor(home)]
      const won = await acquirer.acquired

      if (won) {
        const results = await Promise.all(doctors)
        // The live acquirer's lock must have survived both doctors.
        await expect(stat(path.join(home, 'run', 'host.lock'))).resolves.toBeTruthy()
        expect(await ownerSupervisorPid(home)).toBe(acquirer.child.pid)
        for (const doctor of results) {
          // A doctor may refuse and name the live owner in its reason, but
          // must never report having *unlocked* the acquirer's lock.
          expect(
            doctor.output.includes('unlocked') &&
              doctor.output.includes(`supervisor=${acquirer.child.pid}`),
          ).toBe(false)
        }
        acquirer.requestRelease()
        const exit = await acquirer.exited
        expect(exit.code).toBe(0)
      } else {
        // The doctors cleaned the stale lock before the acquirer looked.
        await Promise.all(doctors)
        await expect(stat(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
          code: 'ENOENT',
        })
      }
    }
  }, 180_000)

  it('refuses to unlock a corrupt owner while a supported CLI process is running', async () => {
    const home = await isolatedHome()
    await withCliWeb(home, home, async () => {
      // Corrupt the owner while the dsh-native wrapper and its CLI child
      // are alive: doctor must detect them through the argv scan.
      await writeFile(path.join(home, 'run', 'host.lock', 'owner.json'), '{corrupt', 'utf8')
      const doctor = await runDoctor(home)
      expect(doctor.code).toBe(2)
      expect(doctor.output).toContain('ACTIVE_OWNER')
    })
  }, 180_000)
})
