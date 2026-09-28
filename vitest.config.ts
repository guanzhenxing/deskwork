import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deskwork/desktop-contracts/host-control': path.join(
        root,
        'packages/desktop-contracts/src/host-control.ts',
      ),
      '@deskwork/desktop-contracts/profile-name': path.join(
        root,
        'packages/desktop-contracts/src/profile-name.ts',
      ),
      '@deskwork/profile-manager': path.join(root, 'packages/profile-manager/src/index.ts'),
      '@deskwork/desktop-plugin': path.join(root, 'packages/desktop-plugin/src/index.ts'),
      '@deskwork/desktop-recovery-bridge': path.join(
        root,
        'packages/desktop-recovery-bridge/src/index.ts',
      ),
      '@deskwork/home-lease': path.join(root, 'packages/home-lease/src/index.ts'),
      '@deskwork/host-supervisor': path.join(root, 'packages/host-supervisor/src/index.ts'),
      '@deskwork/product-config': path.join(root, 'packages/product-config/src/index.ts'),
      '@deskwork/release-compatibility': path.join(
        root,
        'packages/release-compatibility/src/index.ts',
      ),
      '@deskwork/shell-core': path.join(root, 'packages/shell-core/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'tests/helpers/*.test.mjs',
    ],
    exclude: ['**/*.integration.test.ts'],
    passWithNoTests: true,
    testTimeout: 10_000,
  },
})
