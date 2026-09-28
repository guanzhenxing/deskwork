import {
  createNativeProcessProbe,
  unlockHome,
  type GuardLock,
  type ProcessProbe,
} from '@deskwork/home-lease'

import {
  resolveCliRuntime,
  resolveReleaseFactsLine,
  type CliRuntimePaths,
} from './runtime-paths.js'

export type RunDoctorUnlockInput = Readonly<{
  home: string
  runtime?: CliRuntimePaths
  probe?: ProcessProbe
  guard?: GuardLock
  stderr?: NodeJS.WritableStream
}>

function doctorProbe(runtime: CliRuntimePaths | undefined): ProcessProbe {
  // Without the caller's runtime (packaged installs inject it) the env-based
  // resolver would describe the DEV layout: its scan needles cannot see the
  // installed desktop app, and doctor's degraded scan path could then delete
  // a lock held by the live app.
  const resolved = runtime ?? resolveCliRuntime(process.env)
  return createNativeProcessProbe({
    helperPath: resolved.leaseHelper,
    entryExecutables: resolved.desktopEntryExecutables,
    scanArgvNeedles: resolved.scanArgvNeedles,
    excludePids: [process.pid],
  })
}

/**
 * Execute the user's explicit `doctor --unlock` request. Refusals explain
 * why and never offer a force escape hatch.
 */
export async function runDoctorUnlock(input: RunDoctorUnlockInput): Promise<number> {
  const stderr = input.stderr ?? process.stderr
  const result = await unlockHome({
    home: input.home,
    probe: input.probe ?? doctorProbe(input.runtime),
    ...(input.guard === undefined ? {} : { guard: input.guard }),
  })
  if (result.status === 'refused') {
    stderr.write(`dsh-native: refused to unlock (${result.code}): ${result.detail}\n`)
    stderr.write(
      'dsh-native: doctor never force-unlocks; fully exit the running entrypoint first\n',
    )
    return 2
  }
  stderr.write(`dsh-native: ${result.status}: ${result.detail ?? 'home lock state'}\n`)
  const releaseFacts = resolveReleaseFactsLine()
  if (releaseFacts !== undefined) {
    stderr.write(`dsh-native: ${releaseFacts}\n`)
  }
  return 0
}
