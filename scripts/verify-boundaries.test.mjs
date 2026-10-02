import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { findBoundaryViolations } from './verify-boundaries.mjs'

async function removeFixture(root) {
  const target = path.resolve(root)
  const identity = await lstat(target)
  if (
    path.dirname(target) !== path.resolve(tmpdir()) ||
    !path.basename(target).startsWith('dsh-boundaries-') ||
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    path.dirname(await realpath(target)) !== (await realpath(tmpdir()))
  ) {
    throw new Error('refusing to remove an unsafe boundary fixture')
  }
  await rm(target, { recursive: true })
}

test('rejects product plugin imports from the Host mechanism', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'packages', 'host-supervisor', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      path.join(sourceDir, 'host-runner.ts'),
      "import type { DesktopSurfaceService } from '@deskwork/desktop-plugin'\n",
    )
    assert.deepEqual(
      (await findBoundaryViolations(root)).map((item) => item.rule),
      ['mechanism-no-product-plugin'],
    )
  } finally {
    await removeFixture(root)
  }
})

test('rejects Electron imports from mechanism packages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'packages', 'profile-manager', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, 'index.ts'), "import { app } from 'electron'\n")

    const violations = await findBoundaryViolations(root)
    assert.deepEqual(
      violations.map((item) => item.rule),
      ['mechanism-no-electron'],
    )
  } finally {
    await removeFixture(root)
  }
})

test('rejects DSH runtime imports from Electron Main', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'apps', 'desktop-launcher', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      path.join(sourceDir, 'main.ts'),
      "import { boot } from '@deepseek-ai/dsh-app-boot'\n",
    )

    const violations = await findBoundaryViolations(root)
    assert.deepEqual(
      violations.map((item) => item.rule),
      ['main-no-dsh-runtime'],
    )
  } finally {
    await removeFixture(root)
  }
})

test('allows the Electron Host entry adapter to import the Host runner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'apps', 'desktop-launcher', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      path.join(sourceDir, 'host-entry.ts'),
      "import { runDshHost } from '@deskwork/host-supervisor/host-runner'\n",
    )

    assert.deepEqual(await findBoundaryViolations(root), [])
  } finally {
    await removeFixture(root)
  }
})

test('rejects exporting the DSH Host runner from the supervisor root entry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'packages', 'host-supervisor', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, 'index.ts'), "export * from './host-runner.js'\n")

    const violations = await findBoundaryViolations(root)
    assert.deepEqual(
      violations.map((item) => item.rule),
      ['supervisor-root-no-host-runner'],
    )
  } finally {
    await removeFixture(root)
  }
})

test('rejects loading the DSH boot runtime through profile-manager', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'packages', 'profile-manager', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      path.join(sourceDir, 'reconcile.ts'),
      "import { initProfile } from '@deepseek-ai/dsh-app-boot'\n",
    )

    const violations = await findBoundaryViolations(root)
    assert.deepEqual(
      violations.map((item) => item.rule),
      ['profile-manager-no-dsh-boot'],
    )
  } finally {
    await removeFixture(root)
  }
})

test('rejects DSH imports from the product configuration package', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'packages', 'product-config', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      path.join(sourceDir, 'index.ts'),
      "export { resolveDshHome } from '@deepseek-ai/dsh-home-paths'\n",
    )

    const violations = await findBoundaryViolations(root)
    assert.deepEqual(
      violations.map((item) => item.rule),
      ['product-config-pure'],
    )
  } finally {
    await removeFixture(root)
  }
})

test('requires capability-specific desktop-contracts imports', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'packages', 'feature', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      path.join(sourceDir, 'index.ts'),
      "import { HOST_CONTROL_PROTOCOL } from '@deskwork/desktop-contracts'\n",
    )

    const violations = await findBoundaryViolations(root)
    assert.deepEqual(
      violations.map((item) => item.rule),
      ['contracts-capability-subpath'],
    )
  } finally {
    await removeFixture(root)
  }
})
