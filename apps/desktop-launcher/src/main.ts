import os from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  screen,
  shell as electronShell,
  Tray,
} from 'electron'

import {
  acquireHomeLease,
  createNativeProcessProbe,
  LeaseError,
  resolveDesktopHome,
  resolveLeaseHelperPath,
} from '@dsh-desktop/home-lease'
import { HostSupervisor, type HostFatalDetail, type HostReady } from '@dsh-desktop/host-supervisor'
import { PRODUCT } from '@dsh-desktop/product-config'
import { SAFE_PROFILE_NAME } from '@dsh-desktop/profile-manager'
import { loadReleaseManifest, runHomeCompatibilityChain } from '@dsh-desktop/release-compatibility'

import { createStartupTimeline } from './startup-timeline.js'
import {
  closeWindowAction,
  createDesktopProfileRecovery,
  createRecoveryMarkerStore,
  isAllowedMainFrameNavigation,
  minWindowSizeFor,
  readWindowState,
  RendererReloadBudget,
  restoreWindowState,
  redactSummaryText,
  RecoverySessionController,
  StartupFailureError,
  toStartupFailure,
  writeWindowState,
  type SavedWindowState,
  type StartupFailure,
} from '@dsh-desktop/shell-core'

import { createElectronHostProcessFactory } from './electron-host-process.js'
import {
  decideMainFrameNavigation,
  externalUrlPolicy,
  type OpenExternalAdapter,
} from './external-links.js'
import { describeLeaseBlock, resolveSmokeHome } from './lease-diagnostics.js'
import { createRecoveryWindow, type RecoveryWindowHandle } from './recovery-window.js'
import { writeSurfaceUrlFile } from './surface-url-file.js'
import { resolveSmokeUserData } from './m0-paths.js'
import {
  buildAboutPanelOptions,
  NativeUiSession,
  type MenuItemSpec,
  type NativeUiAction,
  type NativeUiPort,
} from './native-ui.js'
import {
  resolveInstalledRuntime,
  resolveNativeAssets,
  type InstalledRuntimePaths,
} from './resource-paths.js'
import {
  isScriptedSmokeMode,
  runLifecycleSequence,
  runNavigationSequence,
  runRecoverySequence,
  type SmokeSequenceContext,
} from './smoke-sequence.js'
import { createWindowOpenGuard, DESKTOP_WEB_PREFERENCES } from './window-policy.js'

// A packaged build derives every runtime path from the installed resources
// root; development keeps the repository layout next to this module.
const installedRuntime: InstalledRuntimePaths | undefined = app.isPackaged
  ? resolveInstalledRuntime(process.resourcesPath)
  : undefined
const hostEntryPath =
  installedRuntime?.hostEntry ?? fileURLToPath(new URL('./host-entry.js', import.meta.url))
const smokeMode = process.env.DSH_DESKTOP_SMOKE
const smokeProfileOverride =
  smokeMode === undefined ? undefined : process.env.DSH_DESKTOP_SMOKE_PROFILE
if (
  smokeProfileOverride !== undefined &&
  !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(smokeProfileOverride)
) {
  throw new Error('invalid DSH_DESKTOP_SMOKE_PROFILE')
}
const isLoadingSmoke = smokeMode === 'loading'
const isStartupPerfSmoke = smokeMode === 'startup-perf'
const userDataOverride = await resolveSmokeUserData(smokeMode, process.env.DSH_DESKTOP_M0_USER_DATA)
// Smoke-only startup timeline: normal launches create the disabled
// collector and emit nothing.
const startupTimeline = createStartupTimeline(isStartupPerfSmoke, (event) => {
  smokeReport(event)
})

if (userDataOverride !== undefined) {
  app.setPath('userData', path.resolve(userDataOverride))
} else {
  // The default userData directory derives from app.name, which now follows
  // the product display name — pin it to the frozen data-directory identity
  // so existing data never follows a rename.
  app.setPath('userData', path.join(app.getPath('appData'), PRODUCT.dataDirectoryName))
}

// The running application reports this name to macOS: the Dock tooltip and
// the About/Hide menu-role labels. Menu-role labels follow it, not the
// custom submenu label, so this must be the display name.
app.setName(PRODUCT.displayName)
// Set the Dock icon as a PNG via nativeImage: Dock/LaunchServices icon caching
// for ad-hoc rebuilds is unreliable, and nativeImage guarantees display.
if (process.platform === 'darwin') {
  void app.whenReady().then(() => {
    const pngPath = app.isPackaged
      ? path.join(process.resourcesPath, 'dock-icon.png')
      : path.join(import.meta.dirname, '..', '..', '..', 'release', 'icons', 'dock-icon.png')
    if (existsSync(pngPath) && app.dock) {
      app.dock.setIcon(pngPath)
    }
  })
}
/**
 * DSH release facts for the About panel, read from the embedded release
 * manifest (packaged) or the repository baseline document (development).
 * A missing or corrupt manifest degrades to no DSH line — the About panel
 * never invents version facts and startup never depends on it.
 */
function loadReleaseDshLine(): string | undefined {
  const manifestPath = app.isPackaged
    ? path.join(process.resourcesPath, 'compatibility.json')
    : path.join(import.meta.dirname, '..', '..', '..', 'docs', 'compatibility.json')
  try {
    const facts: {
      releaseId?: unknown
      dataEpoch?: unknown
      dsh?: { tag?: unknown; npmVersion?: unknown }
      release?: { dataEpoch?: unknown }
    } = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const { dsh } = facts
    if (typeof dsh?.tag !== 'string' || typeof dsh?.npmVersion !== 'string') return undefined
    const epoch = [facts.dataEpoch, facts.release?.dataEpoch].find(
      (value) => typeof value === 'number',
    )
    const release =
      typeof facts.releaseId === 'string' ? ` ${facts.releaseId}` : ' development source'
    return `DSH ${dsh.tag} (npm ${dsh.npmVersion}) ·${release}${
      epoch === undefined ? '' : ` · data epoch ${epoch}`
    }`
  } catch {
    return undefined
  }
}
const releaseDshLine = loadReleaseDshLine()
app.setAboutPanelOptions(
  buildAboutPanelOptions({
    displayName: PRODUCT.displayName,
    desktopVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    ...(releaseDshLine === undefined ? {} : { dshLine: releaseDshLine }),
  }),
)

function workAreas(): { x: number; y: number; width: number; height: number }[] {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  return [primary, ...displays.filter((display) => display.id !== primary.id)].map(
    (display) => display.workArea,
  )
}

/** The main window port: loads the Host surface and can retire it. */
class ElectronWindowPort {
  readonly window: BrowserWindow
  readonly reloadBudget = new RendererReloadBudget()
  #allowedOrigin: string | undefined
  #surfaceUrl: string | undefined
  #revealed = false
  readonly #stateFile: string
  readonly #isQuitting: () => boolean
  readonly #openExternal: OpenExternalAdapter
  readonly #loadingHtml: string | undefined
  readonly #loadingPageUrl: string | undefined
  #saveTimer: NodeJS.Timeout | undefined

  constructor(input: {
    initialState: SavedWindowState | undefined
    stateFile: string
    isQuitting: () => boolean
    openExternal: OpenExternalAdapter
    loadingHtml?: string
  }) {
    this.#stateFile = input.stateFile
    this.#isQuitting = input.isQuitting
    this.#openExternal = input.openExternal
    this.#loadingHtml = input.loadingHtml
    this.#loadingPageUrl =
      input.loadingHtml === undefined ? undefined : pathToFileURL(input.loadingHtml).href
    const restored = restoreWindowState(input.initialState, workAreas())
    const minimum = minWindowSizeFor(restored)
    this.window = new BrowserWindow({
      x: restored.bounds.x,
      y: restored.bounds.y,
      width: restored.bounds.width,
      height: restored.bounds.height,
      minWidth: minimum.width,
      minHeight: minimum.height,
      show: false,
      title: PRODUCT.displayName,
      webPreferences: DESKTOP_WEB_PREFERENCES,
    })
    if (restored.maximized) this.window.maximize()
    this.window.webContents.session.setPermissionCheckHandler(() => false)
    this.window.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => {
        callback(false)
      },
    )
    this.window.webContents.setWindowOpenHandler(
      createWindowOpenGuard({
        policy: externalUrlPolicy,
        currentOrigin: () => this.#allowedOrigin,
        openExternal: this.#openExternal,
      }),
    )
    this.window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    const guardNavigation = (event: Electron.Event, target: string): void => {
      if (
        decideMainFrameNavigation({
          allowedOrigin: this.#allowedOrigin,
          target,
          loadingPageUrl: this.#loadingPageUrl,
          surfaceLoaded: this.#revealed,
        }) === 'allow'
      ) {
        return
      }
      // In-frame navigation is blocked outright — user gesture cannot be
      // proven here, so it must never reach the system browser. External
      // handoff happens only in the window-open guard.
      event.preventDefault()
    }
    this.window.webContents.on('will-navigate', guardNavigation)
    this.window.webContents.on('will-redirect', guardNavigation)
    // Closing hides to the tray; only the quitting state machine may close.
    this.window.on('close', (event) => {
      if (closeWindowAction(this.#isQuitting()) === 'hide') {
        event.preventDefault()
        this.window.hide()
      }
    })
    const scheduleSave = (): void => this.#scheduleStateSave()
    this.window.on('resize', scheduleSave)
    this.window.on('move', scheduleSave)
    this.window.on('maximize', scheduleSave)
    this.window.on('unmaximize', scheduleSave)
  }

  async loadSurface(surface: HostReady['surface'], origin: string): Promise<void> {
    this.#allowedOrigin = origin
    this.#surfaceUrl = surface.url
    await this.window.loadURL(surface.url)
    if (!isAllowedMainFrameNavigation(origin, this.window.webContents.getURL())) {
      throw new Error('BrowserWindow finished on an untrusted origin')
    }
    this.reloadBudget.noteSurfaceLoaded()
    this.#revealed = true
    this.window.show()
  }

  /**
   * Show the bundled loading page while the Host runtime boots, so the app
   * answers within the first second instead of appearing dead until the
   * surface is ready. The surface load replaces the page; failures hand the
   * screen to the recovery window (which hides this one).
   */
  async showLoading(): Promise<boolean> {
    if (this.#loadingHtml === undefined || this.window.isDestroyed()) return false
    try {
      await this.window.loadFile(this.#loadingHtml)
      if (this.window.isDestroyed()) return false
      // The user has now seen this window; dock/tray reveal may target it.
      this.#revealed = true
      this.window.show()
      return true
    } catch {
      /* the surface or the recovery view owns every failure */
      return false
    }
  }

  hideIfVisible(): void {
    if (!this.window.isDestroyed() && this.window.isVisible()) this.window.hide()
  }

  /**
   * Dock/tray/second-instance reveal only restores a window the user has
   * already seen: the first launch keeps waiting for the Host surface (and
   * the recovery window owns the failure case).
   */
  canReveal(): boolean {
    return this.#revealed
  }

  /** One policy-checked reload of the current surface after a renderer crash. */
  async reloadSurface(): Promise<void> {
    if (this.#surfaceUrl === undefined) return
    await this.window.loadURL(this.#surfaceUrl)
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
  }

  destroySurface(): void {
    this.#allowedOrigin = undefined
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return
    this.window.webContents.stop()
  }

  /** Persist the normal bounds + maximized flag through an atomic write. */
  persistWindowStateNow(): Promise<void> {
    if (this.window.isDestroyed()) return Promise.resolve()
    return writeWindowState(this.#stateFile, {
      bounds: this.window.getNormalBounds(),
      maximized: this.window.isMaximized(),
    }).catch((error: unknown) => {
      console.error(
        'window state could not be persisted:',
        error instanceof Error ? error.message : error,
      )
    })
  }

  #scheduleStateSave(): void {
    if (this.#saveTimer !== undefined) clearTimeout(this.#saveTimer)
    this.#saveTimer = setTimeout(() => void this.persistWindowStateNow(), 500)
    // The timer must never keep the quit sequence alive.
    this.#saveTimer.unref?.()
  }
}

function smokeReport(payload: Record<string, unknown>): void {
  if (smokeMode === undefined) return
  console.log(`DSH_DESKTOP_SMOKE ${JSON.stringify(payload)}`)
}

function reportLeaseFailure(error: unknown): void {
  const view =
    error instanceof LeaseError
      ? describeLeaseBlock({ code: error.code, ownerSummary: error.ownerSummary })
      : describeLeaseBlock({ code: 'LEASE_UNKNOWN' })
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`${view.title}: ${detail}`)
  smokeReport({ kind: 'lease-refused', code: error instanceof LeaseError ? error.code : 'UNKNOWN' })
  if (smokeMode === undefined) {
    dialog.showErrorBox(view.title, `${view.body.join('\n')}\n\n${view.doctorCommand}`)
    app.exit(1)
  }
}

async function waitForOfficialUi(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 30_000
  let snapshot: unknown
  while (Date.now() < deadline) {
    snapshot = await window.webContents.executeJavaScript(`(() => ({
      title: document.title,
      treeLabels: [...document.querySelectorAll('[role="tree"]')].map((node) => node.getAttribute('aria-label')),
      textboxCount: document.querySelectorAll('[role="textbox"]').length,
      hasSettingsText: document.body.innerText.includes('Settings') || document.body.innerText.includes('设置'),
      bootEntries: window.__DSH_BOOT__?.entries.map((entry) => entry.id) ?? [],
      body: document.body.innerText.slice(0, 240)
    }))()`)
    const state = snapshot as {
      treeLabels: (string | null)[]
      textboxCount: number
      hasSettingsText: boolean
      bootEntries: string[]
      body: string
    }
    const hasSessions = state.treeLabels.some((label) => label === 'Sessions' || label === '会话')
    const hasOfficialGraph =
      state.bootEntries.includes('@deepseek-ai/dsh-client-modules') &&
      state.bootEntries.includes('@deepseek-ai/dsh-client-ui-sidebar')
    if (hasSessions && state.textboxCount > 0 && state.hasSettingsText && hasOfficialGraph) return
    if (state.body.includes('Failed to load plugins')) {
      smokeReport({ kind: 'ui-markers-missing', snapshot })
      throw new Error('Official DSH UI reported a plugin-load failure')
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  smokeReport({ kind: 'ui-markers-missing', snapshot })
  throw new Error('Official DSH UI did not reach the M0 smoke markers')
}

/**
 * ui-smoke acceptance for the Deskwork workbench bundle: the official
 * sidebar must expose the Deskwork entry registered through the
 * `sidebar.panellist` slot, and clicking it must swap in the `main` panel
 * without a plugin-load failure. Runs only in the `ui` smoke mode; the DOM
 * probe asserts by visible label text, not by official markup classes.
 */
async function verifyWorkbenchPanel(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 20_000
  let clicked = false
  while (Date.now() < deadline) {
    const state = (await window.webContents.executeJavaScript(`(() => {
      const findRow = () =>
        [...document.querySelectorAll('button, [role="button"], li, a')].find((el) => {
          const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()
          return name.includes('Deskwork')
        })
      const row = findRow()
      if (row === undefined) return { found: false }
      row.click()
      return { found: true }
    })()`)) as { found: boolean }
    if (state.found) clicked = true
    const bodyText = (await window.webContents.executeJavaScript(
      'document.body.innerText',
    )) as string
    if (bodyText.includes('Failed to load plugins')) {
      smokeReport({ kind: 'workbench-panel-failed' })
      throw new Error(
        'Official DSH UI reported a plugin-load failure while verifying the workbench panel',
      )
    }
    if (clicked && bodyText.includes('Deskwork 工作台（空面板占位）')) {
      smokeReport({ kind: 'workbench-panel-verified', panel: 'deskwork' })
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  smokeReport({
    kind: 'workbench-panel-failed',
    clicked,
    // Diagnostics only: enough to tell "not in the boot graph" from "in the
    // graph but the entry/panel probe missed" without reproducing by hand.
    bootEntries: (await window.webContents
      .executeJavaScript('window.__DSH_BOOT__?.entries?.map((entry) => entry.id) ?? []')
      .catch(() => [])) as string[],
    bodySnippet: (await window.webContents
      .executeJavaScript('document.body.innerText.slice(0, 300)')
      .catch(() => '')) as string,
  })
  throw new Error(
    `workbench entry not verifiable in the official sidebar (clicked=${String(clicked)})`,
  )
}

function toElectronTemplate(
  spec: readonly MenuItemSpec[],
  dispatch: (action: NativeUiAction) => void,
): Electron.MenuItemConstructorOptions[] {
  return spec.map((item): Electron.MenuItemConstructorOptions => {
    switch (item.kind) {
      case 'separator':
        return { type: 'separator' }
      case 'role':
        return item.label === undefined
          ? { role: item.role }
          : { role: item.role, label: item.label }
      case 'action':
        return { label: item.label, click: () => dispatch(item.action) }
      case 'status':
        return { label: item.label, enabled: false }
      case 'submenu':
        return { label: item.label, submenu: toElectronTemplate(item.items, dispatch) }
    }
  })
}

function createNativeUi(showMainWindow: () => void): NativeUiSession {
  const assets = resolveNativeAssets({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  if (assets === undefined) {
    console.error(
      'tray template icons are missing; the tray stays disabled (run scripts/build-icons.mjs)',
    )
  }
  let tray: Tray | undefined
  const session = new NativeUiSession(
    {
      setApplicationMenu: (spec) => {
        Menu.setApplicationMenu(
          Menu.buildFromTemplate(toElectronTemplate(spec, (action) => session.dispatch(action))),
        )
      },
      setTrayMenu: (spec) => {
        if (assets === undefined) return
        tray ??= (() => {
          const image = nativeImage.createFromPath(assets.trayIcon)
          image.addRepresentation({
            scaleFactor: 2,
            width: 32,
            height: 32,
            buffer: readFileSync(assets.trayIcon2x),
          })
          image.setTemplateImage(true)
          const created = new Tray(image)
          created.setToolTip(PRODUCT.displayName)
          created.on('click', () => session.showMain())
          return created
        })()
        tray.setContextMenu(
          Menu.buildFromTemplate(toElectronTemplate(spec, (action) => session.dispatch(action))),
        )
      },
      clearTray: () => {
        tray?.destroy()
        tray = undefined
      },
    } satisfies NativeUiPort,
    {
      show: () => showMainWindow(),
      quit: () => {
        app.quit()
      },
    },
  )
  return session
}

let shell: RecoverySessionController | undefined
let recoveryWindow: RecoveryWindowHandle | undefined
let nativeUi: NativeUiSession | undefined
let windowPort: ElectronWindowPort | undefined
let shutdownComplete = false
let shutdownStarted = false

function isQuitting(): boolean {
  return shutdownStarted || shutdownComplete
}

/** Build the scripted-sequence context from the live session state. */
function sequenceContext(): SmokeSequenceContext {
  const window = windowPort?.window
  if (window === undefined) throw new Error('the scripted sequence needs a live window')
  return {
    window,
    showMain: () => nativeUi?.showMain(),
    simulateDockActivate: () => app.emit('activate', { preventDefault() {} } as never, false),
    waitForRecoveryView: () => {
      if (recoveryViewShown === undefined) {
        throw new Error('startup failed before the recovery signals existed')
      }
      return recoveryViewShown
    },
    waitForHealthy: () => {
      if (healthySession === undefined) {
        throw new Error('startup failed before the recovery signals existed')
      }
      return healthySession
    },
    enterSafeMode: () => shell?.act('safe-mode') ?? Promise.resolve(),
    report: (payload: Record<string, unknown>) => smokeReport(payload),
    quit: () => app.quit(),
  }
}

// Hoisted one-shot signals: startApplication creates them eagerly; the
// recovery sequence may start from the catch path after the recovery view is
// already up, so the promises must exist independently of who awaits first.
let recoveryViewShown: Promise<void> | undefined
let healthySession: Promise<void> | undefined
let resolveRecoveryViewSignal: (() => void) | undefined
let resolveHealthySignal: (() => void) | undefined

async function runScriptedSequence(mode: string): Promise<void> {
  if (mode === 'navigation') {
    await runNavigationSequence(sequenceContext())
    return
  }
  if (mode === 'lifecycle') {
    await runLifecycleSequence(sequenceContext())
  }
}

async function startApplication(): Promise<void> {
  // Resolve the single shared home from the entry environment before any
  // child environment is derived from it.
  const home =
    smokeMode !== undefined && userDataOverride !== undefined
      ? resolveSmokeHome({ smokeMode, userData: userDataOverride, osHome: os.homedir() })
      : resolveDesktopHome({ env: process.env, osHome: os.homedir(), cwd: process.cwd() })
  const probe = createNativeProcessProbe({
    helperPath: installedRuntime?.leaseHelper ?? resolveLeaseHelperPath(process.env),
    entryExecutables: [process.execPath],
  })
  const profileName = PRODUCT.defaultProfileName
  const bootProfileName = smokeProfileOverride ?? profileName
  const marker = createRecoveryMarkerStore(app.getPath('userData'), home)
  const stateFile = path.join(app.getPath('userData'), 'window-state.json')
  const initialState = await readWindowState(stateFile)
  // Automated runs record external handoffs instead of opening the user's
  // browser; a manual system external-link check covers the real path.
  const openExternal: OpenExternalAdapter =
    smokeMode === undefined
      ? (url) => electronShell.openExternal(url)
      : async (url) => {
          smokeReport({ kind: 'external-opened', url })
        }
  const port = new ElectronWindowPort({
    initialState,
    stateFile,
    isQuitting,
    openExternal,
    // Automated sequences assert against the official surface's load events;
    // manual launches get the loading page instead of a dead dock icon.
    ...((smokeMode === undefined || isLoadingSmoke || isStartupPerfSmoke) &&
    installedRuntime !== undefined
      ? { loadingHtml: installedRuntime.loadingHtml }
      : {}),
  })
  windowPort = port
  if (smokeMode === undefined || isLoadingSmoke || isStartupPerfSmoke) {
    const visible = await port.showLoading()
    if (isStartupPerfSmoke && visible && port.window.isVisible()) {
      startupTimeline.mark('loading-visible')
    }
    if (isLoadingSmoke) {
      smokeReport({
        kind: 'loading-view-visible',
        url: port.window.webContents.getURL(),
        visible: visible && port.window.isVisible(),
      })
    }
  }
  const showMainWindow = (): void => {
    const port = windowPort
    if (port === undefined) return
    if (!port.canReveal()) return
    const window = port.window
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  nativeUi = createNativeUi(showMainWindow)
  nativeUi.initialize('starting')
  let readyHost: HostReady | undefined
  let lastFatal: HostFatalDetail | undefined
  recoveryViewShown = new Promise<void>((resolve) => {
    resolveRecoveryViewSignal = resolve
  })
  healthySession = new Promise<void>((resolve) => {
    resolveHealthySignal = resolve
  })
  // The recovery window is created lazily on first failure: an eagerly
  // created, never-loaded hidden window stalls Electron's quit sequence.
  const ensureRecoveryWindow = (): RecoveryWindowHandle => {
    // The recovery view owns the screen now; the loading window must not
    // sit behind it claiming a boot that already failed.
    port.hideIfVisible()
    return (recoveryWindow ??= createRecoveryWindow({
      onAction: (action) => {
        if (shell === undefined) return
        shell
          .act(action)
          .then(() => {
            if (action === 'quit' || shell?.state === 'stopped') app.exit(0)
          })
          .catch((error: unknown) => {
            console.error(
              `recovery action ${action} failed:`,
              error instanceof Error ? error.message : error,
            )
          })
      },
      isInRecovery: () => shell?.state === 'recovery',
      ...(installedRuntime === undefined
        ? {}
        : {
            documentPath: installedRuntime.recoveryHtml,
            preloadPath: installedRuntime.recoveryPreload,
          }),
    }))
  }
  // A dead renderer reloads at most once on the same live Host surface;
  // anything beyond that budget goes to the launcher-owned recovery view.
  port.window.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting() || shell === undefined) return
    const hostSurfaceAlive = readyHost !== undefined && shell.state === 'healthy'
    if (
      port.reloadBudget.consumeIfAvailable({
        hostSurfaceAlive,
        quitting: isQuitting(),
      })
    ) {
      smokeReport({ kind: 'renderer-reloaded', reason: details.reason })
      void port.reloadSurface().catch((reloadError: unknown) => {
        // Electron loadURL rejections can embed the full authenticated URL;
        // stderr is not exempt from the redaction rules.
        console.error(
          'renderer reload failed:',
          redactSummaryText(
            reloadError instanceof Error ? reloadError.message : String(reloadError),
            home,
          ),
        )
        // The one reload the budget granted is gone and no further
        // render-process-gone is guaranteed to arrive: route to the recovery
        // flow now instead of leaving a blank surface forever.
        if (shell === undefined) return
        void shell
          .rendererCrashed({
            stage: 'renderer',
            code: 'RENDERER_RELOAD_FAILED',
            category: 'renderer',
            summary: `界面重载失败（${details.reason}）`,
            retryable: true,
          })
          .catch((crashError: unknown) => {
            console.error(
              'renderer crash handling failed:',
              crashError instanceof Error ? crashError.message : crashError,
            )
          })
      })
      return
    }
    smokeReport({ kind: 'renderer-crashed', reason: details.reason })
    void shell
      .rendererCrashed({
        stage: 'renderer',
        code: 'RENDERER_CRASHED',
        category: 'renderer',
        summary: `界面渲染进程退出（${details.reason}）`,
        retryable: true,
      })
      .catch((error: unknown) => {
        console.error(
          'renderer crash handling failed:',
          error instanceof Error ? error.message : error,
        )
      })
  })
  shell = new RecoverySessionController({
    acquireLease: () =>
      acquireHomeLease({
        home,
        entrypoint: 'desktop',
        profile: bootProfileName,
        appVersion: app.getVersion(),
        probe,
      }),
    profile: createDesktopProfileRecovery({
      home,
      profileName: bootProfileName,
      ownedProfileName: PRODUCT.defaultProfileName,
    }),
    // Home compatibility chain (M4): after the lease, before any
    // profile/cache/Host write, on every session (normal and Safe Mode both
    // flow through this gate). Marker parse → read-only inspection →
    // preflight → write-epoch reservation. A read failure is a fail-closed
    // refusal (thrown → HOME_MARKER_UNREADABLE in the controller).
    admitHome: (lease) => {
      const release = loadReleaseManifest({
        ...(installedRuntime !== undefined
          ? { resourcesDir: process.resourcesPath }
          : { repositoryRoot: path.resolve(import.meta.dirname, '..', '..', '..') }),
      })
      return runHomeCompatibilityChain({ home, lease, release, reserve: true }).then((verdict) => {
        startupTimeline.mark('home-admitted')
        return verdict
      })
    },
    readRecoveryMarker: () => marker.read(),
    writeRecoveryMarker: (entry) => marker.write(entry),
    // Dock and tray Quit must complete promptly; the Host is force-terminated
    // after a short grace period and the lease is released only afterward.
    shutdownDeadlineMs: 1_000,
    createAttempt: (lease, mode) => {
      const attemptSupervisor = new HostSupervisor({
        factory: createElectronHostProcessFactory({
          hostEntry: hostEntryPath,
          compileCache: {
            preloadPath:
              installedRuntime?.compileCachePreload ??
              fileURLToPath(new URL('./host-compile-cache.cjs', import.meta.url)),
            cacheDirectory: path.join(app.getPath('userData'), 'node-compile-cache'),
          },
        }),
        stabilityMs: 100,
        onEvent: (event) => {
          if (event.kind === 'starting') {
            startupTimeline.mark('host-spawned')
          }
          if (event.kind === 'failed') {
            if (event.fatal !== undefined) lastFatal = event.fatal
            smokeReport({
              kind: 'host-failed',
              code: event.error.code,
              summary: redactSummaryText(event.error.message, home),
            })
          }
          if (event.kind !== 'crashed') return
          if (shutdownStarted) return
          void shell
            ?.hostCrashed()
            .then(() => {
              smokeReport({ kind: 'host-crash-recovery', launcherPid: process.pid })
              if (smokeMode === 'host-crash') app.exit(0)
            })
            .catch((error: unknown) => {
              console.error(
                'host-crash recovery failed:',
                error instanceof Error ? error.message : error,
              )
              smokeReport({ kind: 'failed', stage: 'host-crash-recovery' })
            })
        },
      })
      return {
        start: async () => {
          try {
            const ready = await attemptSupervisor.start({
              home,
              profileName: mode === 'safe' ? SAFE_PROFILE_NAME : bootProfileName,
              mode,
              lease,
              probe,
            })
            readyHost = ready
            startupTimeline.mark('host-ready')
            return ready
          } catch (error) {
            const fatal = lastFatal
            lastFatal = undefined
            const failure: StartupFailure = toStartupFailure({
              stage: fatal?.stage ?? 'boot',
              code: fatal?.code ?? 'BOOT_FAILED',
              summary: fatal?.summary ?? (error instanceof Error ? error.message : String(error)),
              retryable: fatal?.retryable ?? true,
              home,
            })
            smokeReport({ kind: 'host-failed', code: failure.code, stage: failure.stage })
            throw new StartupFailureError(failure)
          }
        },
        stop: (reason, deadlineMs) => attemptSupervisor.stop(reason, deadlineMs),
      }
    },
    loadSurface: async (ready) => {
      await port.loadSurface(ready.surface, ready.origin)
      startupTimeline.mark('surface-loaded')
    },
    onHealthy: async () => {
      nativeUi?.setStatus('running')
      resolveHealthySignal?.()
      // A healthy session spends the relaunch marker and retires the
      // launcher-owned recovery window. Runs after the state flips, so a
      // crash inside it is still a post-ready crash. The two steps are
      // independent: a marker that cannot be cleared (it stays spent, the
      // conservative direction) must not keep the recovery window alive.
      await marker.clear().catch((error: unknown) => {
        console.error(
          'recovery marker could not be cleared after a healthy session:',
          error instanceof Error ? error.message : error,
        )
      })
      if (recoveryWindow !== undefined) {
        recoveryWindow.destroy()
        recoveryWindow = undefined
      }
    },
    window: {
      showRecoveryView: async (view) => {
        nativeUi?.setStatus('recovery')
        smokeReport({ kind: 'recovery-view', stage: view.failure.stage, code: view.failure.code })
        await ensureRecoveryWindow().showRecoveryView(view)
        resolveRecoveryViewSignal?.()
      },
      destroySurface: () => port.destroySurface(),
    },
    onSessionFailure: (failure) => {
      nativeUi?.setStatus('recovery')
      smokeReport({
        kind: 'session-failure',
        stage: failure.stage,
        code: failure.code,
        category: failure.category,
      })
    },
    onLeaseReleaseError: (error) => {
      smokeReport({ kind: 'lease-release-refused' })
      console.error('keeping the home lease:', error instanceof Error ? error.message : error)
    },
  })
  await shell.start()

  if (smokeMode !== undefined && smokeMode !== 'recovery') {
    await waitForOfficialUi(port.window)
    if (smokeMode === 'ui') {
      await verifyWorkbenchPanel(port.window)
    }
    if (isStartupPerfSmoke) {
      startupTimeline.mark('official-ui-ready')
    }
    if (isLoadingSmoke) {
      // SECURITY: the surface URL is authenticated — report the origin only;
      // the token never reaches stdout (captured logs).
      const replaced = port.window.webContents.getURL()
      smokeReport({
        kind: 'loading-view-replaced',
        url: (() => {
          try {
            return new URL(replaced).origin
          } catch {
            return 'unreadable-url'
          }
        })(),
      })
    }
  }
  if (smokeMode !== undefined) {
    const driverOwnedModes = ['shared-home', 'conversation', 'auth', 'navigation', 'lifecycle']
    // SECURITY: the authenticated surface URL (token included) never goes to
    // stdout — drivers receive it through a 0600 file in the smoke userData
    // directory, which the acceptance fixtures delete with themselves.
    let surfaceOrigin: string | undefined
    if (driverOwnedModes.includes(smokeMode) && readyHost !== undefined) {
      surfaceOrigin = new URL(readyHost.surface.url).origin
      await writeSurfaceUrlFile(app.getPath('userData'), readyHost.surface.url).catch(
        (error: unknown) => {
          console.error(
            'surface URL file could not be written:',
            error instanceof Error ? error.message : error,
          )
        },
      )
    }
    smokeReport({
      kind: 'ui-ready',
      launcherPid: process.pid,
      hostPid: readyHost?.pid,
      // The booted profile is part of the report so packaged acceptance can
      // attribute the ready surface to the profile it asked for.
      profile: bootProfileName,
      ...(surfaceOrigin === undefined ? {} : { surfaceOrigin, surfaceUrlFile: 'surface-url' }),
    })
    if (smokeMode === 'host-crash' && readyHost !== undefined) {
      process.kill(readyHost.pid, 'SIGKILL')
    } else if (isScriptedSmokeMode(smokeMode)) {
      // Scripted modes run their probe sequence and then quit themselves.
      await runScriptedSequence(smokeMode)
    } else if (!driverOwnedModes.includes(smokeMode)) {
      app.quit()
    }
    // In driver-owned modes the driver owns the shutdown moment; the app stays
    // up holding the lease until it receives SIGTERM.
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()
else {
  // Termination signals go through the normal before-quit chain so the Host
  // is stopped and the home lease is released before the process exits.
  process.on('SIGTERM', () => {
    app.quit()
  })
  app.on('second-instance', () => {
    // Duplicate launches only focus the existing window.
    nativeUi?.showMain()
    const window = windowPort?.window
    if (window !== undefined && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
    smokeReport({ kind: 'second-instance-focused' })
  })
  // Dock icon activation with no visible window brings the main window back.
  app.on('activate', () => {
    nativeUi?.showMain()
  })
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    // The final bounds write must land before app.exit(0) tears the process
    // down; the rest of the quit chain (Host stop, lease release) waits for it.
    const persisted = windowPort?.persistWindowStateNow() ?? Promise.resolve()
    nativeUi?.beginQuit()
    if (shutdownStarted) return
    shutdownStarted = true
    void persisted
      .catch(() => undefined)
      .then(() => shell?.act('quit') ?? Promise.resolve())
      .catch(() => undefined)
      .finally(() => {
        nativeUi?.destroy()
        recoveryWindow?.destroy()
        shutdownComplete = true
        // The stop chain has completed (Host stopped, lease released); a
        // prevented-then-reissued quit can be swallowed by Electron, so exit
        // explicitly from here.
        app.exit(0)
      })
  })
  app.on('window-all-closed', () => app.quit())
  void app
    .whenReady()
    .then(() => {
      startupTimeline.mark('launcher-ready')
      return startApplication()
    })
    .catch((error: unknown) => {
      if (error instanceof LeaseError) reportLeaseFailure(error)
      else {
        console.error('startup failed:', error instanceof Error ? error.message : error)
        // A normal launch that dies before any window exists would otherwise
        // sit invisible with no window-all-closed to end it; surface the
        // failure and exit like the lease refusal does.
        if (smokeMode === undefined) {
          dialog.showErrorBox(
            'Deskwork 启动失败',
            `启动过程中发生错误，应用即将退出。\n\n${error instanceof Error ? error.message : String(error)}`,
          )
          app.exit(1)
        }
      }
      smokeReport({ kind: 'failed', stage: 'startup' })
      if (smokeMode === 'recovery') {
        // The recovery chain already surfaced its view (start() rejects by
        // design once the session settles in recovery); the scripted
        // sequence takes over from here instead of tearing the view down.
        if (windowPort === undefined) {
          // The failure predates the window: nothing to drive a sequence on.
          console.error('startup failed before the window existed; exiting')
          shutdownStarted = true
          app.exit(1)
          return
        }
        void runRecoverySequence(sequenceContext()).catch((sequenceError: unknown) => {
          console.error(
            'recovery sequence failed:',
            sequenceError instanceof Error ? sequenceError.message : sequenceError,
          )
          smokeReport({ kind: 'failed', stage: 'recovery-sequence' })
          shutdownStarted = true
          recoveryWindow?.destroy()
          app.exit(1)
        })
        return
      }
      if (smokeMode !== undefined) {
        shutdownStarted = true
        recoveryWindow?.destroy()
        app.exit(1)
      }
    })
}
