import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHomeSession } from '@deskwork/desktop-contracts/home-session'
import { createDesktopProfileRecovery } from '../src/desktop-recovery.js'

describe('desktop recovery port with a non-desktop boot profile', () => {
  it('prepares a CLI-created profile without applying the desktop template reconcile', async () => {
    const home = await import('../../../tests/helpers/isolated-home.mjs').then((m) =>
      m.createIsolatedHomeFixture(),
    )
    try {
      const session = await createHomeSession({
        home: home.home,
        profile: 'plugin-intake-rehearsal',
      })
      // The shape the CLI's plugin flow leaves behind: a manifest with the
      // staged bundle recorded. reconcileDesktopProfile would throw "only
      // owns the desktop profile" on it — reaching 'ready' proves the
      // desktop reconcile was skipped for this boot profile.
      const profileDir = path.join(home.home, 'profiles', 'plugin-intake-rehearsal')
      await mkdir(profileDir, { recursive: true })
      const manifest = {
        name: 'plugin-intake-rehearsal',
        private: true,
        dependencies: { '@fixture/m5-example-bundle': 'file:../bundles/example' },
        dsh: { profile: { bundles: ['@fixture/m5-example-bundle'] } },
      }
      await writeFile(
        path.join(profileDir, 'package.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )

      const port = createDesktopProfileRecovery({
        home: home.home,
        profileName: 'plugin-intake-rehearsal',
        ownedProfileName: 'deskwork',
      })
      const prepared = await port.prepare(session)
      expect(prepared).toEqual({ kind: 'ready', changed: false })

      // The profile's own bytes are untouched by preparation.
      const after = await readFile(path.join(profileDir, 'package.json'), 'utf8')
      expect(JSON.parse(after)).toEqual(manifest)
    } finally {
      await home.dispose()
    }
  })
})
