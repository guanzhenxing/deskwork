# Repository Guidelines

## Project Structure & Module Organization

This pnpm workspace contains **Deskwork**, a local-first AI workbench built on the DeepSeek Harness (DSH) engine. `apps/desktop-launcher` owns Electron startup and recovery UI; `apps/bundled-cli` provides `dsh-native`. Shared product boundaries live in `packages/`: contracts, home leasing, profiles, host supervision, plugins, recovery bridge, shell core, and the `@deskwork/workbench` product bundle. Put package-local tests in `<package>/test/`; cross-process smoke drivers and fixtures are under `tests/smoke`, `tests/helpers`, and `tests/fixtures`. Architecture, protocols, and operating guidance belong in `docs/`.

## Build, Test, and Development Commands

Use Node 24.11.1 and pnpm 11.7.0 through Corepack:

```bash
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 build
corepack pnpm@11.7.0 test:integration
```

`check` runs formatting, lint and dependency-boundary checks, TypeScript checks, unit tests, and documentation validation. Run `pnpm build:native` before shared-home tests; it requires macOS Xcode Command Line Tools. Target focused desktop behavior with `pnpm smoke:dsh-ui`, `pnpm smoke:host-crash`, `pnpm smoke:profile-recovery`, or `pnpm smoke:safe-mode`.

## Coding Style & Naming Conventions

Write TypeScript as ES modules and preserve package boundaries. Prettier (two-space indentation) is authoritative; run `pnpm format:check` rather than manually reformatting unrelated files. ESLint and `scripts/verify-boundaries.mjs` prohibit invalid Electron, DSH runtime, and cross-package imports. Name source files in kebab-case when adding files; use `*.test.ts` for unit tests and `*.integration.test.ts` for integration tests.

## Testing Guidelines

Vitest is the main test runner, with Node's built-in test runner for boundary-script tests. Add tests beside the package behavior they cover and write contract/state-machine tests before implementation when changing protocols, leases, profiles, host lifecycle, or privileged IPC. Integration and smoke tests must use an explicit isolated `<testHome>` (the fixture refuses to run while `DESKWORK_HOME` is set); never use or delete the real `~/.dsh` (the official app's home) or `~/.deskwork` (Deskwork's own home). Run `pnpm check` for every change and the relevant integration or smoke command for process, recovery, or shared-home work.

## Commits, Pull Requests, and Safety

Follow trunk-based development on short `feat/<name>`, `fix/<name>`, `docs/<name>`, or `chore/<name>` branches. Keep commits small and complete, using prefixes such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, and `chore:`. PRs should state scope, acceptance evidence, affected process/data/trust boundaries, and linked issue or spec; include screenshots for UI changes. Write a reviewed design note for new process or trust boundaries, persistent schemas, privileged capabilities, or public-protocol major changes. Never commit DSH homes, credentials, authenticated URLs, signing keys, or unredacted logs.
