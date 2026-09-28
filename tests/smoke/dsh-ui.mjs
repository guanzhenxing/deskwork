import { requireReport, runLauncherSmoke } from './assert-cleanup.mjs'

const reports = await runLauncherSmoke('ui')
const ready = requireReport(reports, 'ui-ready')
if (!Number.isSafeInteger(ready.launcherPid) || !Number.isSafeInteger(ready.hostPid)) {
  throw new Error('ui-ready did not contain valid launcher and Host PIDs')
}
if (ready.launcherPid === ready.hostPid) {
  throw new Error('DSH Host did not run in an independent process')
}
const panel = requireReport(reports, 'workbench-panel-verified')
if (panel.panel !== 'deskwork') {
  throw new Error('workbench panel report did not name the deskwork panel')
}
console.log('M0 DSH UI smoke passed')
