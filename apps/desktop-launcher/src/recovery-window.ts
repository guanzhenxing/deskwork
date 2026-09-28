import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BrowserWindow, ipcMain } from 'electron'

import { PRODUCT } from '@deskwork/product-config'
import type { RecoveryView } from '@deskwork/shell-core'

import { RECOVERY_DOCUMENT_PATH, toIpcView, validateRecoveryIpc } from './recovery-ipc.js'

// This module runs from lib/ (package main is lib/main.js); in development
// the document and its script stay in src/ (not emitted by tsc) and the
// sandboxed preload is the compiled lib/recovery-preload.cjs. A packaged
// build receives explicit paths from Contents/Resources/recovery instead.
const documentRoot = fileURLToPath(new URL('../src/', import.meta.url))

export interface RecoveryWindowHandle {
  readonly senderIds: ReadonlySet<number>
  showRecoveryView(view: RecoveryView): Promise<void>
  destroy(): void
}

/**
 * Launcher-owned recovery surface: its own non-persistent partition, full
 * isolation flags, only local HTML/JS, and a single guarded IPC action
 * channel whose senders are validated per message.
 */
export function createRecoveryWindow(options: {
  onAction(action: 'retry' | 'safe-mode' | 'quit'): void
  isInRecovery(): boolean
  documentPath?: string | undefined
  preloadPath?: string | undefined
}): RecoveryWindowHandle {
  const window = new BrowserWindow({
    width: 720,
    height: 480,
    show: false,
    title: `${PRODUCT.displayName} — 恢复`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: 'recovery-window',
      preload:
        options.preloadPath ?? fileURLToPath(new URL('./recovery-preload.cjs', import.meta.url)),
    },
  })
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const guardNavigation = (event: Electron.Event): void => {
    event.preventDefault()
  }
  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)

  // The one document URL senders may speak from; compared exactly, so any
  // navigation, query, or fragment retires the window's IPC privileges.
  const documentPath = options.documentPath ?? path.join(documentRoot, RECOVERY_DOCUMENT_PATH)
  const expectedFrameUrl = pathToFileURL(documentPath).href

  // Capture the webContents id once: after destroy() the 'closed' handler
  // must never touch the torn-down webContents object.
  const contentsId = window.webContents.id
  const senderIds = new Set<number>()
  window.webContents.once('did-finish-load', () => {
    senderIds.add(contentsId)
  })
  window.on('closed', () => {
    senderIds.delete(contentsId)
  })

  const listener = (event: Electron.IpcMainEvent, payload: unknown): void => {
    const verdict = validateRecoveryIpc({
      senderId: event.sender.id,
      frameUrl: event.senderFrame?.url,
      frameIsMainFrame: event.senderFrame != null && event.senderFrame.parent == null,
      expectedFrameUrl,
      expectedSenderIds: senderIds,
      inRecovery: options.isInRecovery(),
      channel: 'recovery:action',
      payload,
    })
    if (!verdict.ok) {
      console.error(`recovery-ipc: rejected (${verdict.reason})`)
      return
    }
    options.onAction(verdict.action)
  }
  ipcMain.on('recovery:action', listener)

  return {
    senderIds,
    async showRecoveryView(view) {
      if (window.isDestroyed()) return
      await window.loadFile(documentPath)
      if (window.isDestroyed()) return
      window.webContents.send('recovery:view', toIpcView(view))
      window.show()
    },
    destroy() {
      ipcMain.removeListener('recovery:action', listener)
      if (!window.isDestroyed()) window.destroy()
      senderIds.clear()
    },
  }
}
