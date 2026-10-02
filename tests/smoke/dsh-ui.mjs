import { requireReport, runLauncherSmoke } from './assert-cleanup.mjs'

// The shell's whole job is to boot the official surface and step aside, so
// this smoke asserts exactly that and nothing about a product layer: the
// launcher and the DSH Host are separate processes, the Host reports ready,
// and the booted profile is the one the product owns. The official UI's own
// markers — session tree, composer, settings, the official client graph and
// the absence of a plugin-load failure — are asserted inside the launcher
// before it emits `ui-ready`, so reaching that report at all proves the
// surface mounted; any failure there exits non-zero and fails this run.
const reports = await runLauncherSmoke('ui')
const ready = requireReport(reports, 'ui-ready')
if (!Number.isSafeInteger(ready.launcherPid) || !Number.isSafeInteger(ready.hostPid)) {
  throw new Error('ui-ready did not contain valid launcher and Host PIDs')
}
if (ready.launcherPid === ready.hostPid) {
  throw new Error('DSH Host did not run in an independent process')
}
if (ready.profile !== 'deskwork') {
  throw new Error(`ui-ready booted the wrong profile: ${String(ready.profile)}`)
}
// SECURITY: whatever the report carries must never include the authenticated
// URL's token. Modes that need the URL receive it through a 0600 file, so the
// report may legitimately omit the origin entirely — it may never leak it.
if (/[?&](token|t)=/u.test(JSON.stringify(ready))) {
  throw new Error('the authenticated surface token leaked into the smoke report')
}
console.log('DSH UI smoke passed')
