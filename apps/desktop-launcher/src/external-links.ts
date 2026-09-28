import { isAllowedMainFrameNavigation, isLoopbackHost } from '@deskwork/shell-core'

/**
 * The single decision point for user-driven links leaving the app: only
 * well-formed `https:`, `http:` and `mailto:` targets without userinfo or
 * control characters may reach the system browser, and never a loopback
 * surface URL (that would leak the local authentication token to the default
 * browser) or a link back into the current surface origin (popups stay in-app
 * or are denied). Everything else is denied without side effects.
 */
export function externalUrlPolicy(input: {
  target: string
  currentOrigin: string
}): 'external' | 'deny' {
  const target = input.target
  if (typeof target !== 'string' || target === '') return 'deny'
  // C0, DEL and C1 controls anywhere — including places a URL parser would
  // tolerate — are rejected before parsing.
  // eslint-disable-next-line no-control-regex -- rejecting control characters is this guard's whole purpose
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(target)) return 'deny'
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return 'deny'
  }
  if (url.username !== '' || url.password !== '') return 'deny'
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'mailto:') {
    return 'deny'
  }
  if (url.protocol === 'mailto:') return 'external'
  // The local authenticated surface (and anything else on loopback) never
  // goes to the system browser.
  if (isLoopbackHost(url.hostname)) return 'deny'
  if (url.origin === input.currentOrigin) return 'deny'
  return 'external'
}

/**
 * Main-frame navigations (user clicks without target, scripts, HTTP
 * redirects) may only stay on the authenticated surface origin. Everything
 * else — including allowed browser protocols — is simply blocked: an
 * in-frame navigation cannot be reliably attributed to a user gesture, so it
 * must never hand a URL to the system browser. External handoff happens only
 * through the window-open guard (target=_blank links).
 *
 * The one addition before a surface exists is the launcher's own bundled
 * loading page, matched by its exact file URL: the window opens with it
 * while the Host runtime boots, and once a surface has loaded nothing but
 * that surface's origin may ever navigate the main frame again.
 */
export function decideMainFrameNavigation(input: {
  allowedOrigin: string | undefined
  target: string
  loadingPageUrl?: string | undefined
  surfaceLoaded?: boolean
}): 'allow' | 'deny' {
  if (
    input.allowedOrigin !== undefined &&
    isAllowedMainFrameNavigation(input.allowedOrigin, input.target)
  ) {
    return 'allow'
  }
  if (
    input.surfaceLoaded !== true &&
    input.loadingPageUrl !== undefined &&
    input.target === input.loadingPageUrl
  ) {
    return 'allow'
  }
  return 'deny'
}

/** Adapter that ultimately calls `shell.openExternal`; injectable for tests. */
export type OpenExternalAdapter = (url: string) => Promise<void>
