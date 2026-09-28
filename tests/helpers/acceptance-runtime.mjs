import process from 'node:process'

/** The only Node runtime acceptance evidence may be produced under. */
export const ACCEPTANCE_NODE_VERSION = '24.11.1'

/**
 * Acceptance-evidence commands (smoke:package, verify:plugin-intake) must
 * run under the pinned Node runtime. Acceptance driven by a different Node
 * (a machine whose default node moved on to another
 * major) is not comparable evidence: its failures cannot be attributed to
 * the candidate, and the run cannot be recorded. Fail fast before any
 * expensive step executes.
 */
export function assertAcceptanceRuntime(entry, actual = process.versions.node) {
  if (actual !== ACCEPTANCE_NODE_VERSION) {
    console.error(
      `${entry}: refusing to run under Node ${actual} — acceptance evidence requires Node ${ACCEPTANCE_NODE_VERSION} (AGENTS.md: corepack pnpm@11.7.0 on Node ${ACCEPTANCE_NODE_VERSION}).`,
    )
    process.exit(2)
  }
}
