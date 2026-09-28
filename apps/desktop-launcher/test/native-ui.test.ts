import { describe, expect, it } from 'vitest'

import {
  buildAboutPanelOptions,
  buildApplicationMenuSpec,
  buildTrayMenuSpec,
  NativeUiSession,
  type MenuItemSpec,
  type NativeUiPort,
} from '../src/native-ui.js'

function items(spec: readonly MenuItemSpec[]): MenuItemSpec[] {
  return spec.flatMap((item) => (item.kind === 'submenu' ? [item, ...items(item.items)] : [item]))
}

function roles(spec: readonly MenuItemSpec[]): string[] {
  return items(spec).flatMap((item) => (item.kind === 'role' ? [item.role] : []))
}

function actionLabels(spec: readonly MenuItemSpec[]): string[] {
  return items(spec).flatMap((item) => (item.kind === 'action' ? [item.label] : []))
}

describe('application menu spec', () => {
  const menu = buildApplicationMenuSpec({ displayName: 'Deskwork' })

  it('keeps the standard macOS About/Services/Hide, Edit, View and Window roles', () => {
    expect(roles(menu)).toEqual([
      'about',
      'services',
      'hide',
      'hideOthers',
      'unhide',
      'editMenu',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'togglefullscreen',
      'minimize',
      'zoom',
      'close',
      'front',
    ])
  })

  it('exposes exactly one show and one quit action, named after the product', () => {
    expect(actionLabels(menu).sort()).toEqual(['显示 Deskwork', '退出 Deskwork'])
  })

  it('registers no accelerators on product actions (system Cmd+Q flows through before-quit)', () => {
    for (const item of items(menu)) {
      if (item.kind === 'action') expect('accelerator' in item).toBe(false)
    }
  })
})

describe('tray menu spec', () => {
  it('shows the running status and recovery status differently', () => {
    const running = items(buildTrayMenuSpec('running'))
    const recovery = items(buildTrayMenuSpec('recovery'))
    expect(running.find((item) => item.kind === 'status')?.label).toBe('运行中')
    expect(recovery.find((item) => item.kind === 'status')?.label).toBe('恢复模式可用')
  })

  it('always offers show and quit', () => {
    for (const spec of [buildTrayMenuSpec('running'), buildTrayMenuSpec('recovery')]) {
      expect(actionLabels(spec)).toEqual(['显示主窗口', '退出'])
    }
  })
})

describe('buildAboutPanelOptions', () => {
  it('reads versions from the compatibility chain, not hand-written strings', () => {
    const options = buildAboutPanelOptions({
      displayName: 'Deskwork',
      desktopVersion: '1.2.3',
      electronVersion: '44.1.0',
    })
    expect(options).toEqual({
      applicationName: 'Deskwork',
      applicationVersion: '1.2.3',
      version: 'Electron 44.1.0',
    })
  })

  it('surfaces the embedded release manifest facts as credits when present', () => {
    const options = buildAboutPanelOptions({
      displayName: 'Deskwork',
      desktopVersion: '1.2.3',
      electronVersion: '44.1.0',
      dshLine: 'DSH dsh-v0.1.2-alpha.3 (npm 0.1.2-alpha.3) · m4-1.2.3-darwin-arm64-98af342',
    })
    expect(options.credits).toContain('dsh-v0.1.2-alpha.3')
    expect(options.credits).toContain('m4-1.2.3-darwin-arm64-98af342')
  })
})

describe('NativeUiSession', () => {
  function fixture() {
    const events: string[] = []
    const applicationMenus: (readonly MenuItemSpec[])[] = []
    const trayMenus: (readonly MenuItemSpec[])[] = []
    const port: NativeUiPort = {
      setApplicationMenu: (spec) => {
        applicationMenus.push(spec)
        events.push('app-menu')
      },
      setTrayMenu: (spec) => {
        trayMenus.push(spec)
        events.push('tray-menu')
      },
      clearTray: () => events.push('clear-tray'),
    }
    const actions: string[] = []
    const session = new NativeUiSession(port, {
      show: () => actions.push('show'),
      quit: () => actions.push('quit'),
    })
    return { events, applicationMenus, trayMenus, actions, session }
  }

  it('applies the application menu once and rebuilds the tray on status change', () => {
    const { events, applicationMenus, trayMenus, session } = fixture()
    session.initialize('starting')
    session.setStatus('running')
    session.setStatus('recovery')
    session.setStatus('recovery')
    expect(applicationMenus.length).toBe(1)
    expect(events.filter((event) => event === 'tray-menu').length).toBe(3)
    expect(trayMenus.length).toBe(3)
  })

  it('ignores show once quitting began', () => {
    const { actions, session } = fixture()
    session.initialize('running')
    session.beginQuit()
    session.showMain()
    expect(actions).toEqual([])
  })

  it('forwards show and quit before quitting, dispatching through the session', () => {
    const { actions, session } = fixture()
    session.initialize('running')
    session.dispatch('show')
    session.dispatch('quit')
    expect(actions).toEqual(['show', 'quit'])
  })

  it('stops dispatching after destroy and clears the tray exactly once', () => {
    const { events, actions, session } = fixture()
    session.initialize('running')
    session.destroy()
    session.destroy()
    session.dispatch('show')
    expect(events.filter((event) => event === 'clear-tray').length).toBe(1)
    expect(actions).toEqual([])
  })
})
