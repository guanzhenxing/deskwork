export const DESKTOP_BUNDLE_PREFIX = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deskwork/desktop-plugin',
] as const

export const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
[]
`

export const PROFILE_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

export function desktopManifestTemplate(profileDirBasename: string): Record<string, unknown> {
  return {
    name: `dsh-profile-${profileDirBasename}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: DESKTOP_BUNDLE_PREFIX, patchReload: 'live' } },
  }
}
