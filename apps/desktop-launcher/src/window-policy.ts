import type { HandlerDetails } from 'electron'

import { PRODUCT } from '@deskwork/product-config'

import type { OpenExternalAdapter } from './external-links.js'

export const DESKTOP_RENDERER_PARTITION = PRODUCT.rendererPartition

export const DESKTOP_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  partition: DESKTOP_RENDERER_PARTITION,
  sandbox: true,
  webSecurity: true,
})

export function denyWindowOpen(): { action: 'deny' } {
  return { action: 'deny' }
}

export type ExternalUrlPolicyFn = (input: {
  target: string
  currentOrigin: string
}) => 'external' | 'deny'

/**
 * New windows are always denied. Allowed external targets are additionally
 * handed to the system browser by the launcher — never with renderer-supplied
 * native arguments, only through the policy decision made here in the main
 * process.
 */
export function createWindowOpenGuard(input: {
  policy: ExternalUrlPolicyFn
  currentOrigin: () => string | undefined
  openExternal: OpenExternalAdapter
}): (details: HandlerDetails) => { action: 'deny' } {
  return (details: HandlerDetails): { action: 'deny' } => {
    const currentOrigin = input.currentOrigin()
    if (
      currentOrigin !== undefined &&
      input.policy({ target: details.url, currentOrigin }) === 'external'
    ) {
      void input.openExternal(details.url).catch(() => undefined)
    }
    return { action: 'deny' }
  }
}
