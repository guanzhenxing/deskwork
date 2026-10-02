// M3 auth smoke, driven over the real Host webserver with fresh cookie jars:
// requests without the surface token are refused at the API boundary, the
// authenticated handoff establishes a usable cookie, and after a full Desktop
// restart the fresh Host authentication no longer honors the old credentials.
import { createDesktopSmokeRoot } from '../helpers/desktop-smoke-root.mjs'
import { ensureLauncherBuilt, withDesktop } from '../helpers/desktop-driver.mjs'

await ensureLauncherBuilt()
const root = await createDesktopSmokeRoot()

async function apiStatus(url, cookie) {
  const origin = new URL(url).origin
  const response = await globalThis.fetch(`${origin}/api/session/list`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'auth-smoke',
      method: 'session/list',
      payload: { args: [{ _request: {} }] },
    }),
  })
  // Drain the body so the socket is reusable.
  await response.arrayBuffer()
  return response.status
}

function cookieOf(response) {
  return response.headers.getSetCookie()[0]?.split(';')[0]
}

async function unauthorized(status, label) {
  // The Host refuses unauthenticated API calls; 401/403 both count as a
  // refusal, anything else means the boundary leaked.
  if (status !== 401 && status !== 403) {
    throw new Error(`${label}: expected 401/403 without credentials, got ${status}`)
  }
}

try {
  let firstSurfaceUrl
  let firstCookie
  await withDesktop(
    root.home,
    root.userData,
    async ({ surfaceUrl }) => {
      firstSurfaceUrl = surfaceUrl
      // 1. No token, no cookie: the API boundary refuses.
      await unauthorized(await apiStatus(surfaceUrl), 'API without credentials')
      // 2. Authenticated handoff: the tokenized surface URL establishes a
      // session cookie that authorizes the same API.
      const login = await globalThis.fetch(surfaceUrl, { redirect: 'manual' })
      firstCookie = cookieOf(login)
      if (firstCookie === undefined) {
        throw new Error('authenticated handoff did not establish a session cookie')
      }
      const authorized = await apiStatus(surfaceUrl, firstCookie)
      if (authorized !== 200) {
        throw new Error(`API with session cookie failed: ${authorized}`)
      }
      console.log('M3 auth: unauthenticated refused, handoff cookie authorized')
    },
    'auth',
  )

  // 3. Full restart: a fresh Host mints fresh authentication; the old
  // credentials no longer grant access.
  await withDesktop(
    root.home,
    root.userData,
    async ({ surfaceUrl }) => {
      if (surfaceUrl === firstSurfaceUrl) {
        throw new Error('restarted Host reused the previous authenticated URL')
      }
      // The old session cookie must not authorize the new Host.
      await unauthorized(await apiStatus(surfaceUrl, firstCookie), 'old cookie after restart')
      // The old tokenized URL belongs to the retired Host: either nothing
      // listens there anymore (connection refused = no access at all), or any
      // credential it could still mint must not authorize the new Host.
      let staleCookie
      try {
        const stale = await globalThis.fetch(firstSurfaceUrl, { redirect: 'manual' })
        staleCookie = cookieOf(stale)
      } catch {
        // The old surface is gone with the old Host; that is a refusal.
        staleCookie = undefined
      }
      if (staleCookie !== undefined) {
        await unauthorized(
          await apiStatus(surfaceUrl, staleCookie),
          'cookie minted from the stale token',
        )
      }
      // The fresh handoff still works.
      const login = await globalThis.fetch(surfaceUrl, { redirect: 'manual' })
      const fresh = cookieOf(login)
      if (fresh === undefined) throw new Error('fresh handoff did not establish a cookie')
      const ok = await apiStatus(surfaceUrl, fresh)
      if (ok !== 200) throw new Error(`fresh cookie failed to authorize: ${ok}`)
      console.log('M3 auth: restart rotated authentication; stale credentials refused')
    },
    'auth',
  )
  console.log('M3 auth smoke passed')
} finally {
  await root.dispose()
}
