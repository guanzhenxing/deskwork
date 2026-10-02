import { describe, expect, it } from 'vitest'

import { resolveInstalledRuntime } from '../src/resource-paths.js'

describe('resolveInstalledRuntime', () => {
  it('derives every runtime path from the explicit resources root only', () => {
    const root = '/Applications/DSH.app/Contents/Resources'
    const paths = resolveInstalledRuntime(root)
    expect(paths.hostEntry).toBe(`${root}/runtime-host/lib/host-entry.js`)
    expect(paths.hostInstallAnchor).toBe(`${root}/runtime-host/package.json`)
    expect(paths.recoveryHtml).toBe(`${root}/recovery/recovery-view.html`)
    expect(paths.recoveryPreload).toBe(`${root}/recovery/recovery-preload.cjs`)
    expect(paths.compatibilityManifest).toBe(`${root}/compatibility.json`)
    expect(paths.trayIcon).toBe(`${root}/icons/trayTemplate.png`)
    for (const value of Object.values(paths)) {
      expect(value.startsWith(root)).toBe(true)
    }
  })

  it('normalizes relative resource roots without changing the layout', () => {
    const paths = resolveInstalledRuntime('relative/resources')
    expect(paths.compatibilityManifest).toBe(
      `${process.cwd()}/relative/resources/compatibility.json`.replace(/\/\//gu, '/'),
    )
  })
})
