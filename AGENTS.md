# Repository Guidelines

## Project Structure & Module Organization

Thrive is a client-side SillyTavern extension using browser-native ESM. `index.js` loads `src/app/bootstrap.js`; root `manifest.json`, `settings.html`, and `style.css` remain the installed assets. Business modules live in `src/features/{learning,session,prompts,settings,memory,tools}/`; pure algorithms in `src/core/`, shared utilities/events in `src/shared/`, and host adapters in `src/platform/sillytavern/`. UI modules are grouped by surface under `src/ui/`; panel and prompt-editor renderers are separate from their controllers.

Read `docs/development.md` when changing tooling, imports, module layout, tests, or host adapters; it explains dependency direction, test doubles, legacy-test migration, and real-host acceptance steps. Read `docs/spec.md`, `docs/adr.md`, and `docs/user_stories.md` before changing behavior. `.workbuddy/` is read-only, ignored verification history; maintained tests and product code stay independent of it.

## Build, Test, and Development Commands

Use Node 24 LTS (24.15.0+) and npm. Install development dependencies with `npm ci`; package scripts are the source of truth for commands. There is no production build step. Link this directory into a local SillyTavern installation:

```bat
mklink /J "<SillyTavern>\public\scripts\extensions\third-party\thrive" "<repository path>"
```

Refresh SillyTavern after editing. Before committing:

```sh
npm run check
npm test
npm run test:e2e
```

The browser gate requires `npx playwright install chromium`, or `PLAYWRIGHT_CHANNEL=chrome` with installed Chrome. On Windows, use `npm.cmd` if PowerShell's npm shim fails. Commit `package-lock.json` when dependencies change.

## Coding Style & Naming Conventions

Use four spaces, semicolons, single quotes, trailing commas in multiline structures, LF text, and ES modules (`import`/`export`). Use `camelCase` for functions and locals, `UPPER_SNAKE_CASE` for constants, and descriptive filenames. Keep SillyTavern imports in its platform adapter; ESLint checks dependency direction and browser-relative imports. `src/store.js`, `src/targets.js`, and `src/tools.js` are compatibility exports; new internal imports use the feature modules. Within a feature, import concrete modules instead of its own aggregate entry. Add JSDoc when expanding the selective `checkJs` scope in `jsconfig.json`.

## Architecture & Documentation Invariants

Keep the chat path free of Thrive prompts, tools, and logs; learning output goes through isolated session tools. `isLearningActive()` means a learning run is in progress, not that per-chat mode is enabled. The single session slot includes asynchronous connection setup; stop and chat changes clear the in-memory queue and cancel setup before a request is sent. A session fixes its connection profile when opened. Professor runs must not advance chat-learning baselines. Preserve prompt order during normalization and delete migrated keys in `migrations.js` (called by `ensureSettings`). Behavior changes update relevant docs and keep `manifest.json`, package metadata, startup log, and settings version consistent.

## Testing Guidelines

Vitest owns `tests/unit/` and `tests/integration/`; use per-file jsdom only for DOM behavior. Playwright owns `tests/e2e/` and loads the real extension against the offline host in `tests/fixtures/`. Test externally observable behavior and architecture invariants, using independent in-memory chat/worldbook state. Keep regressions for migrations, session cancellation/queueing, read-before-write, draft/disk separation, and chat isolation.

`npm run check` includes syntax, ESLint, selective JavaScript type checking, and the permanent root-level `smoke-import.mjs`; retain that smoke script. It links/evaluates `index.js` and every source module with explicit in-memory host exports and verifies manifest assets. `npm run test:coverage` reports gaps without a global percentage target.

After host adapter, import, or UI changes, follow the SillyTavern 1.19.0 acceptance steps in `docs/development.md`. Offline browser tests cannot certify real-host compatibility. Report which checks ran and explicitly identify unavailable host/remote-CI verification.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit prefixes with optional scopes, for example `feat(prompt): ...` or `fix(patch): ...`. Use an imperative, focused subject and keep unrelated refactors separate. Pull requests should explain user-visible behavior, identify affected modules, link an issue or ADR when applicable, and include screenshots or manual verification for UI changes. Confirm root assets in `manifest.json`.
