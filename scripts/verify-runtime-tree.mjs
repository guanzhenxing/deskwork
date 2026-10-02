#!/usr/bin/env node
// Verify the staged runtime tree (release/staging) is complete and
// self-contained before it is packaged:
//
//   - every required file exists (Host entry, web assets, package metadata,
//     recovery assets);
//   - no symlink anywhere in the tree resolves outside the tree (the packaged
//     copies must never point back at the repository or a pnpm store);
//   - the singleton packages the DSH runtime requires (React, Cordis, dsh)
//     resolve to exactly one realpath;
//   - native addons load under the ABI of the runtime that will use them
//     (Electron, for the Host closure).
//
// Usage: node scripts/verify-runtime-tree.mjs [--staging <dir>]
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const REQUIRED_STAGING_FILES = [
  'app-shell/package.json',
  'app-shell/main.cjs',
  'runtime-host/package.json',
  'runtime-host/lib/main.js',
  'runtime-host/lib/host-entry.js',
  'runtime-host/node_modules/@deskwork/host-supervisor/package.json',
  'runtime-host/node_modules/@deskwork/shell-core/lib/index.js',
  'runtime-host/node_modules/.pnpm/node_modules/@deepseek-ai/dsh/package.json',
  'runtime-host/node_modules/.pnpm/node_modules/@deepseek-ai/dsh-web-frontend/package.json',
  'runtime-host/node_modules/.pnpm/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'runtime-host/node_modules/@deskwork/desktop-recovery-bridge/package.json',
  'runtime-host/node_modules/@deskwork/desktop-recovery-bridge/cordis.patch.yml',
  'recovery/recovery-view.html',
  'recovery/recovery-view.js',
  'recovery/recovery-preload.cjs',
  'compatibility.json',
]

const SINGLETON_PACKAGES = ['react', '@deepseek-ai/cordis', '@deepseek-ai/dsh']

async function walk(directory, visit) {
  // Only ENOENT may read as "absent" (a concurrent removal): any other
  // failure (EACCES on a chmod-000 subtree, EMFILE, ...) must fail the gate
  // — swallowing it would silently scan a smaller tree and pass.
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    await visit(target, entry)
    if (entry.isDirectory()) await walk(target, visit)
  }
}

/** Every symlink in the tree must resolve back inside the tree. */
export async function findEscapingSymlinks(treeRoot) {
  const canonicalRoot = await realpath(treeRoot)
  const escapes = []
  await walk(treeRoot, async (target, entry) => {
    if (!entry.isSymbolicLink()) return
    const resolved = await realpath(target).catch(() => undefined)
    if (resolved === undefined) {
      escapes.push({ link: target, resolved: '<unresolvable>' })
      return
    }
    const relative = path.relative(canonicalRoot, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      escapes.push({ link: target, resolved })
    }
  })
  return escapes
}

/** Required staging files that are missing (or not regular files). */
export async function findMissingRequiredFiles(treeRoot) {
  const missing = []
  for (const relative of REQUIRED_STAGING_FILES) {
    const target = path.join(treeRoot, relative)
    const identity = await stat(target).catch(() => undefined)
    if (identity === undefined || !identity.isFile()) missing.push(relative)
  }
  return missing
}

/**
 * The pnpm virtual store names singleton entries `name@version`; more than
 * one distinct version for a watched name would mean two different runtime
 * singletons inside one closure.
 */
export async function findDuplicateSingletons(closureRoot, names = SINGLETON_PACKAGES) {
  const store = path.join(closureRoot, 'node_modules', '.pnpm')
  const found = new Map()
  const duplicates = []
  const entries = await readdir(store, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const name of names) {
      const prefix = `${name.replace('/', '+')}@`
      if (!entry.name.startsWith(prefix)) continue
      const version = entry.name.slice(prefix.length)
      const previous = found.get(name)
      found.set(name, [...(previous ?? []), version])
    }
  }
  for (const [name, versions] of found) {
    const sorted = [...versions].sort()
    const distinct = new Set(sorted.map((version) => version.split('_')[0]))
    if (distinct.size > 1) duplicates.push({ name, versions: sorted })
  }
  return duplicates
}

/** Resolve each watched singleton through Node resolution inside the closure. */
export async function findUnresolvableSingletons(
  closureRoot,
  names,
  anchorRelative = 'package.json',
) {
  const canonicalRoot = await realpath(closureRoot)
  const failures = []
  // The anchor is realpathed first: pnpm links packages into .pnpm, and Node
  // resolution must start from the real location to see the store siblings.
  const requireHere = createRequire(await realpath(path.join(closureRoot, anchorRelative)))
  for (const name of names) {
    try {
      const resolved = requireHere.resolve(`${name}/package.json`)
      const canonical = await realpath(resolved)
      const relative = path.relative(canonicalRoot, canonical)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        failures.push({ name, reason: `resolved outside the closure: ${resolved}` })
      }
    } catch (error) {
      failures.push({ name, reason: String(error.message ?? error) })
    }
  }
  return failures
}

/**
 * DSH runtime packages peer-require each other; the development workspace
 * satisfies those peers from the full install set, but a deployed closure
 * only contains what the closure owner declares. Every @deepseek-ai peer
 * that no package in the closure's virtual store provides would crash the
 * Host at plugin-load time, so the missing ones are surfaced here.
 */
export async function findUnmetDeepseekPeers(closureRoot) {
  const store = path.join(closureRoot, 'node_modules', '.pnpm')
  const hoisted = path.join(store, 'node_modules')
  const missing = new Map()
  await walk(store, async (target, entry) => {
    if (!entry.isFile() || entry.name !== 'package.json') return
    // Only manifests of store packages (their own package.json).
    if (!target.includes(`${path.sep}node_modules${path.sep}`)) return
    let manifest
    try {
      manifest = JSON.parse(await readFile(target, 'utf8'))
    } catch {
      return
    }
    const name = manifest.name
    if (typeof name !== 'string') return
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!peer.startsWith('@deepseek-ai/')) continue
      if (!(await exists(path.join(hoisted, peer, 'package.json')))) {
        const users = missing.get(peer) ?? new Set()
        users.add(name)
        missing.set(peer, users)
      }
    }
  })
  return [...missing.entries()].map(([peer, users]) => ({
    peer,
    peeredBy: [...users].sort(),
  }))
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/** All .node addons of one closure for the current platform. */
export async function findNativeAddons(
  closureRoot,
  platform = process.platform,
  arch = process.arch,
) {
  // Packages ship every platform's binaries (prebuilds/, reflink, pnpm's
  // optional deps); only the current platform's can load here, so foreign
  // platform tokens exclude an addon from ABI verification.
  const platformTokens = [
    'darwin-x64',
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
    'linux-arm',
    'win32-x64',
    'win32-arm64',
    'win32-ia32',
    'freebsd-x64',
  ]
  const mine = `${platform}-${arch}`
  const addons = []
  await walk(closureRoot, async (target, entry) => {
    if (!entry.isFile() || !target.endsWith('.node')) return
    const foreign = platformTokens.filter((token) => token !== mine && target.includes(token))
    if (foreign.length > 0) return
    addons.push(target)
  })
  return addons
}

function canLoadAddon(runtimeBinary, addonPath, env) {
  const result = spawnSync(runtimeBinary, ['-e', 'require(process.argv[1])', addonPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return result.status === 0
}

/**
 * Verify every native addon loads under the runtime that will use it. The
 * Electron check uses the development Electron with ELECTRON_RUN_AS_NODE=1
 * (no fuses flipped there); the staged files are copied byte-identically into
 * the app, so a load here proves the load there.
 */
export async function verifyAddonAbis(options) {
  const { stagingRoot, electronBinary } = options
  const failures = []
  const hostAddons = await findNativeAddons(path.join(stagingRoot, 'runtime-host'))
  for (const addon of hostAddons) {
    if (!canLoadAddon(electronBinary, addon, { ...process.env, ELECTRON_RUN_AS_NODE: '1' })) {
      failures.push({ addon, runtime: 'electron' })
    }
  }
  return { failures, hostAddons: hostAddons.length }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function main() {
  const flagIndex = process.argv.indexOf('--staging')
  const stagingRoot = path.resolve(
    flagIndex >= 0 ? process.argv[flagIndex + 1] : path.join(root, 'release', 'staging'),
  )
  const errors = []

  const missing = await findMissingRequiredFiles(stagingRoot)
  for (const file of missing) errors.push(`missing required staging file: ${file}`)

  const escapes = await findEscapingSymlinks(stagingRoot)
  for (const escape of escapes) {
    errors.push(`symlink escapes the staging tree: ${escape.link} -> ${escape.resolved}`)
  }

  // Watched singletons: the Host process must see exactly one Cordis/React/
  // DSH runtime. Uniqueness comes from the pnpm store scan; resolvability is proven from
  // every runtime anchor that Node-imports the singletons itself — the Host
  // runner (host-supervisor) and the normal bundle (desktop-plugin). The Safe
  // Mode bundle (desktop-recovery-bridge, staged as a real directory) is
  // loaded by the Host's cordis loader and Node-imports nothing, so its
  // singleton guarantee is the closure-level uniqueness check plus the
  // required staging files, not a resolution probe.
  const closureSingletons = {
    'runtime-host': {
      unique: ['react', '@deepseek-ai/cordis', '@deepseek-ai/dsh'],
      resolve: ['@deepseek-ai/cordis', '@deepseek-ai/dsh'],
      anchors: [
        'node_modules/@deskwork/host-supervisor/package.json',
        'node_modules/@deskwork/desktop-plugin/package.json',
      ],
    },
  }
  for (const [closure, config] of Object.entries(closureSingletons)) {
    const closureRoot = path.join(stagingRoot, closure)
    for (const duplicate of await findDuplicateSingletons(closureRoot, config.unique)) {
      errors.push(
        `singleton ${duplicate.name} has multiple versions: ${duplicate.versions.join(', ')}`,
      )
    }
    for (const anchor of config.anchors) {
      for (const failure of await findUnresolvableSingletons(closureRoot, config.resolve, anchor)) {
        errors.push(
          `singleton ${failure.name} did not resolve in ${closure} (anchor ${path.basename(path.dirname(anchor))}): ${failure.reason}`,
        )
      }
    }
  }

  for (const closure of ['runtime-host']) {
    for (const unmet of await findUnmetDeepseekPeers(path.join(stagingRoot, closure))) {
      errors.push(
        `closure ${closure} is missing the @deepseek-ai peer ${unmet.peer} (peered by ${unmet.peeredBy.join(', ')})`,
      )
    }
  }

  // Manifest consistency: embedded compatibility facts match the repository.
  const manifest = await readJson(path.join(stagingRoot, 'compatibility.json')).catch(
    () => undefined,
  )
  if (manifest === undefined) {
    errors.push('compatibility.json is missing or corrupt')
  } else {
    const rootManifest = await readJson(path.join(root, 'package.json'))
    const launcherManifest = await readJson(
      path.join(root, 'apps', 'desktop-launcher', 'package.json'),
    )
    const shellManifest = await readJson(path.join(stagingRoot, 'app-shell', 'package.json'))
    const product = createRequire(path.join(root, 'package.json'))(
      './packages/product-config/lib/index.js',
    ).PRODUCT
    if (manifest.schemaVersion !== 2) {
      errors.push('compatibility.json is not the schema-2 release manifest')
    }
    const docsCompatibility = await readJson(path.join(root, 'docs', 'compatibility.json'))
    if (JSON.stringify(manifest.dsh) !== JSON.stringify(docsCompatibility.dsh)) {
      errors.push('compatibility.json dsh facts diverge from docs/compatibility.json')
    }
    if (manifest.desktopVersion !== rootManifest.version) {
      errors.push('compatibility.json desktopVersion does not match the root package version')
    }
    if (manifest.electron !== launcherManifest.devDependencies.electron) {
      errors.push('compatibility.json electron does not match the pinned launcher dependency')
    }
    if (shellManifest.version !== rootManifest.version) {
      errors.push('app-shell version does not match the root package version')
    }
    if (manifest.productExecutableName !== product.name) {
      errors.push('compatibility.json productExecutableName does not match PRODUCT.name')
    }
  }

  // Native addon ABI verification needs the development Electron binary.
  const electronBinary = createRequire(path.join(root, 'apps', 'desktop-launcher', 'package.json'))(
    'electron',
  )
  const abi = await verifyAddonAbis({ stagingRoot, electronBinary })
  for (const failure of abi.failures) {
    errors.push(`native addon failed to load under ${failure.runtime}: ${failure.addon}`)
  }

  if (errors.length > 0) {
    console.error(`runtime tree verification failed with ${errors.length} error(s):`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`runtime tree verification passed (${abi.hostAddons} host addons verified)`)
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)
if (invokedDirectly) await main()
