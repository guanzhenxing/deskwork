import { spawn, spawnSync } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { createNativeProcessProbe, defaultLeaseHelperPath } from '@deskwork/home-lease'

import { runBundledCli } from '../src/main.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

const helperPath = defaultLeaseHelperPath()
const holderScript = fileURLToPath(
  new URL('../../../tests/fixtures/lease-holder.mjs', import.meta.url),
)

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

class MemoryStderr extends Writable {
  readonly chunks: string[] = []

  override _write(
    chunk: string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(String(chunk))
    callback()
  }

  text(): string {
    return this.chunks.join('')
  }
}

function doctorProbe() {
  return createNativeProcessProbe({
    helperPath,
    entryExecutables: [],
    excludePids: [process.pid],
  })
}

async function runDoctor(home: string): Promise<{ code: number; stderr: string }> {
  const stderr = new MemoryStderr()
  const code = await runBundledCli(['doctor', '--unlock'], {
    env: { DESKWORK_HOME: home },
    probe: doctorProbe(),
    stderr,
    spawnChild: () => {
      throw new Error('doctor must never fork the CLI child')
    },
  })
  return { code, stderr: stderr.text() }
}

describe.skipIf(!helperAvailable)('dsh-native doctor --unlock', () => {
  it('refuses while another process holds the home', async () => {
    const home = await isolatedHome()
    const holder = spawn(process.execPath, [holderScript, home], {
      env: { ...process.env, DSH_DESKTOP_LEASE_HELPER: helperPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      await waitForLine(holder, (line) => line.startsWith('ACQUIRED '))
      const result = await runDoctor(home)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('ACTIVE_OWNER')
      expect(result.stderr).toContain('force')
    } finally {
      holder.stdin.write('release\n')
      await new Promise((resolve) => holder.once('exit', resolve))
    }
  })

  it('unlocks the stale lock of a killed holder', async () => {
    const home = await isolatedHome()
    const holder = spawn(process.execPath, [holderScript, home], {
      env: { ...process.env, DSH_DESKTOP_LEASE_HELPER: helperPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    await waitForLine(holder, (line) => line.startsWith('ACQUIRED '))
    holder.kill('SIGKILL')
    await new Promise((resolve) => holder.once('exit', resolve))

    const before = await runDoctor(home)
    expect(before.code).toBe(0)
    expect(before.stderr).toContain('unlocked')
    await expect(stat(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const after = await runDoctor(home)
    expect(after.code).toBe(0)
    expect(after.stderr).toContain('already-unlocked')
  })

  it('reports a home without any lease layout as already unlocked', async () => {
    const home = await isolatedHome()
    const result = await runDoctor(home)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('already-unlocked')
  })
})

function waitForLine(
  child: ReturnType<typeof spawn>,
  predicate: (line: string) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const stdout = child.stdout
    if (stdout === null) {
      reject(new Error('holder has no stdout'))
      return
    }
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (predicate(line)) {
          resolve()
          return
        }
        newline = buffer.indexOf('\n')
      }
    })
    child.once('exit', () => reject(new Error('holder exited before acquiring')))
    setTimeout(() => reject(new Error('timed out waiting for the holder')), 15_000)
  })
}
