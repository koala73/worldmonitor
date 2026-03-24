# World Monitor Agent Rules

## Delivery Path

- `main` is the only merge target.
- Agent branches (`claude/*`, `codex/*`, `copilot/*`) must go through PRs and GitHub auto-merge after required checks pass.
- Do not merge agent PRs directly with the REST merge endpoint or local `git merge` unless explicitly told.

## Release And Main Sync

- Official desktop releases are tag-driven.
- Continuous install to Bradley's Mac is handled locally by `npm run main-sync:setup`, which installs a macOS LaunchAgent that polls `macos/main`.
- The sync clone lives at `~/.worldmonitor-main-sync/repo`. Never develop there; it is disposable and owned by the sync agent.
- The local Mac sync path must:
  - run `npm run lockfile:check`
  - run `npm ci`
  - run `npm run typecheck:all`
  - run `npm run build`
  - run `npm run desktop:build:app:full`
  - install via `node scripts/install-built-app.mjs --relaunch`
  - refuse to install unless GitHub required checks for `main` are green

## Local Sync Agent

- Bootstrap or repair the sync agent with `npm run main-sync:setup`.
- Trigger a one-off sync manually with `npm run main-sync:run`.
- The agent state lives under `~/.worldmonitor-main-sync/`:
  - `repo/` clean clone
  - `state.json` last installed commit
  - `status.json` last sync result
  - `logs/` LaunchAgent stdout/stderr
- If `/scripts/sync-main-to-mac.mjs` or `/scripts/setup-main-sync-agent.mjs` changes, rerun `npm run main-sync:setup`.
- Do not add any `self-hosted` jobs to PR-triggered workflows in this public repo.

## Safety

- Prefer fail-closed behavior. If signing, verification, packaging, or install checks fail, stop the sync instead of falling back to a weaker path.
- Keep `~/Applications/World Monitor.app` as the canonical install target.
- This is a user-owned repo on GitHub, so non-provider patterns and validity checks are unavailable. The compensating control is mandatory repo secret scan coverage in local hooks and CI; keep `npm run secrets:scan:staged` and `npm run secrets:scan` enabled and passing.
