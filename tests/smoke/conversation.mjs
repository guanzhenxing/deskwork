// M3 conversation smoke: one real turn through the official web surface with
// the M1 mock LLM, a complete Desktop exit, and a fresh Desktop launch that
// continues the very same session.
import { access } from 'node:fs/promises'
import { setTimeout as sleepTimer } from 'node:timers'
import path from 'node:path'

import {
  createSharedHomeFixture,
  driveOneTurn,
  ensureLauncherBuilt,
  listSessions,
  waitForTurns,
  withDesktop,
} from '../helpers/desktop-driver.mjs'

await ensureLauncherBuilt()
const fixture = await createSharedHomeFixture()

async function waitForSessionFile(home, sessionId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const sessions = await listSessions(home)
    const found = sessions.find((session) => session.header.id === sessionId)
    if (found !== undefined) return found
    if (Date.now() > deadline) {
      throw new Error(`session ${sessionId} did not persist within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => sleepTimer(resolve, 250))
  }
}

try {
  let sessionId
  // First launch: create the session and finish one turn.
  await withDesktop(
    fixture.home,
    fixture.userData,
    async ({ client }) => {
      sessionId = await driveOneTurn(client, {
        cwd: fixture.cwd,
        text: 'start the desktop session',
      })
      const created = await waitForSessionFile(fixture.home, sessionId)
      await waitForTurns(created.file, 1)
    },
    'conversation',
  )

  // A complete exit leaves no live owner record: the next launch boots
  // cleanly against the same home.
  const lock = path.join(fixture.home, 'run', 'host-owner.json')
  const leftover = await access(lock)
    .then(() => 'present')
    .catch((error) => (error.code === 'ENOENT' ? undefined : 'unreadable'))
  if (leftover !== undefined) {
    throw new Error(`host owner record survived the full Desktop exit (${leftover})`)
  }

  // Second launch: the official surface lists and continues the same session.
  await withDesktop(
    fixture.home,
    fixture.userData,
    async ({ client }) => {
      const listed = await client.rpc('session/list', { _request: {} })
      const found = listed.items.find((item) => item.sessionId === sessionId)
      if (found === undefined) throw new Error('restarted Desktop did not list the prior session')
      const continued = await driveOneTurn(client, {
        cwd: fixture.cwd,
        sessionId,
        text: 'continue after the restart',
      })
      if (continued !== sessionId) {
        throw new Error('continuation changed the session id')
      }
      const sessions = await listSessions(fixture.home)
      const target = sessions.find((session) => session.header.id === sessionId)
      if (target === undefined) throw new Error('continued session vanished')
      const turns = await waitForTurns(target.file, 2)
      if (turns !== 2) throw new Error(`expected exactly 2 turns after restart, got ${turns}`)
    },
    'conversation',
  )
  console.log('M3 conversation smoke passed')
} finally {
  await fixture.dispose()
}
