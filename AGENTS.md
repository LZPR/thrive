# Repository Guidelines

## Project Structure & Module Organization

Thrive is a client-side SillyTavern extension. `index.js` is the entry point; `manifest.json` and `style.css` define metadata and styling. Feature logic lives in `src/`, with state and orchestration in `store.js`, `learning.js`, `prompt.js`, `targets.js`, and `session*.js`. UI code is under `src/ui/`. Design decisions live in `docs/spec.md`, `docs/adr.md`, and `docs/user_stories.md`. `.workbuddy/` is read-only verification history; keep it out of product logic.

## Build, Test, and Development Commands

There is no package manager or bundler. Develop against a local SillyTavern installation by linking this directory into its extension folder:

```bat
mklink /J "<SillyTavern>\public\scripts\extensions\third-party\thrive" "<repository path>"
```

After editing, refresh SillyTavern to reload the extension. Run a syntax check across JavaScript files before committing:

```powershell
Get-ChildItem -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```

## Coding Style & Naming Conventions

Use four spaces, semicolons, single quotes, trailing commas in multiline structures, and ES modules (`import`/`export`). Follow the existing naming patterns: `camelCase` for functions and locals, `UPPER_SNAKE_CASE` for constants, and descriptive module names such as `session-provider.js` or `prompt-window.js`. Keep SillyTavern integration at the edges and preserve the module responsibilities described in file headers.

## Architecture & Documentation Invariants

Keep the chat path free of Thrive prompts, tools, and logs; learning output goes through isolated session tools. `isLearningActive()` means a session is running, not that per-chat mode is enabled. Only one session runs at a time; stop and chat changes clear the in-memory queue. A session fixes its connection profile when opened. Professor runs must not advance chat-learning baselines. Preserve prompt order during normalization, delete migrated keys in `ensureSettings`, and update relevant docs plus the manifest version for behavior changes.

## Testing Guidelines

No automated test suite is committed. Treat `node --check` as the minimum, then manually exercise affected flows in SillyTavern 1.19.0. For import, session, prompt, or migration changes, also run a root-level ESM smoke script that stubs SillyTavern-only modules and imports `index.js` plus every `src/**/*.js`; this catches missing exports and link-time errors. Remove it afterward and include reproducible UI or integration steps.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit prefixes with optional scopes, for example `feat(prompt): ...` or `fix(patch): ...`. Use an imperative, focused subject and keep unrelated refactors separate. Pull requests should explain user-visible behavior, identify affected modules, link an issue or ADR when applicable, and include screenshots or manual verification for UI changes. Confirm root assets in `manifest.json`.
