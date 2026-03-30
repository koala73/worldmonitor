# Branch Integration Handoff

Date: 2026-03-29

## Purpose

This branch exists to do real selective integration of stale fork branches onto current `main` without touching the dirty working tree in `/Users/bradleybond/Developer/worldmonitor`.

## Canonical Branch State

- Integration branch: `codex/integration-main-20260329`
- Worktree path: `/Users/bradleybond/.codex/worktrees/worldmonitor/integration-main-20260329`
- Base commit: `54a788814d71e2aa2d8717bbb3ecdcf445089c9c`
- Base branch: `macos/main`
- Current HEAD after clean-install correction: `4e88fb60`

## Do Not Touch

- Dirty primary workspace: `/Users/bradleybond/Developer/worldmonitor`
- Current branch there: `codex/panels-and-vault`
- It has tracked edits plus many untracked vault/video assets and feature files. Do not reset, clean, or force-align it.

## What Was Already Settled

- `macos/main` is current at `54a78881`
- No open PRs remain in `bradleybond512/worldmonitor-macos`
- The critical advancements/watchlist/playbooks/consequence/replay work already merged through PR `#82`

## Branch Audit Summary

### Already merged or safe cleanup later

- local `main-sync-20260317`
- local `main-sync-polish-20260317`
- remote `macos/copilot/fix-md032-errors-in-docs`

### Duplicate stale branches

- `claude/vault-3d-red-locked`
- `codex/vault-intro-clean`

These are effectively the same vault-lock patch under different SHAs and are stale against current `main`.

### Divergent branches that still need selective integration

- `macos/codex/panels-and-vault`
  - `macos/main...branch = 2 / 11`
  - Mostly docs, lint/tooling, regression stabilization, and some late repair commits
- `macos/codex/final-sync-20260324`
  - `macos/main...branch = 24 / 42`
  - Large stale alternate history; do not bulk merge
- `macos/feat/audio-upgrade`
  - `macos/main...branch = 5 / 3`
  - Contains `feat(audio)` plus a major feature sprint commit
- `macos/feat/feature-sprint-2`
  - `macos/main...branch = 3 / 4`
  - Mostly large feature-sprint commits
- `macos/claude/update-web-version-6BNZ1`
  - `macos/main...branch = 7 / 5`
  - Mix of web cleanup, 9 OSINT API integration, typecheck fixes, and audio work

## Subsumed Branches / Commits

These looked promising but are already effectively present on current `main`:

- `macos/codex/notarization-env-fallback-20260324`
  - Current `build-desktop.yml` already has notarization env fallback behavior
- `macos/codex/release-manifest-name-normalization-20260324`
  - Manifest/name normalization fix is already patch-equivalent on `main`
- `0fce03ab` from `macos/claude/update-web-version-6BNZ1`
  - Attempted cherry-pick
  - Conflicts only in `api/_cors.js` and `api/rss-proxy.js`
  - Aborted because the commit is already subsumed:
    - CORS allowlist for `bradleybond512` and `worldmonitor-macos` Vercel deployments already exists
    - RSS allowlist additions already exist
    - Vite RSS proxy domain additions already exist
    - Header/settings attribution cleanup already exists

## Landed In This Integration Branch

- `4e88fb60` `Revert "Align TypeScript deprecation gate with TS6"`
  - A clean `npm ci` install in `/tmp/worldmonitor-install-c1157df1` proved the lockfile still resolves `typescript@5.9.3`
  - `ignoreDeprecations: "6.0"` was therefore incorrect for a clean environment and had to be reverted
  - The earlier `e75c2f63` result was a false positive caused by using the dirty primary repo's newer `node_modules` tree for worktree verification

## Recommended Next Targets

### 1. `15cf5710` from `macos/claude/update-web-version-6BNZ1`

Reason:

- Real product value
- Reasonably isolated compared with the sprint branches
- Adds missing OSINT/country-intel service integrations without dragging the whole stale branch

Scope from commit stat:

- new API routes: `api/newsapi-headlines.js`, `api/newsdata-feed.js`
- new services: `src/services/bgpview.ts`, `src/services/newsapi.ts`, `src/services/newsdata.ts`, `src/services/rest-countries.ts`, `src/services/virustotal.ts`, `src/services/wikipedia.ts`
- updates to sidecar/runtime-config/country brief/cyber panel

### 2. `70d411fa` or `e06e37d2` audio upgrade work

Reason:

- Self-contained enough to evaluate on its own
- Touches `src/services/sound-manager.ts` and a few UI surfaces
- Must be compared carefully against current sound-mode behavior already present on `main`

### 3. `0399a33e` from local `codex/panels-and-vault`

Reason:

- Regression-suite stabilization may still be useful
- Lower risk than the giant feature stacks

Note:

- This commit exists only in the dirty primary repo right now, not in this integration worktree
- If you want to transplant it, inspect with:
  - `git -C /Users/bradleybond/Developer/worldmonitor show --stat 0399a33e`

## Recommended Workflow From Here

1. Stay in this worktree only.
2. Run `npm ci` here before any verification-heavy integration work.
3. Cherry-pick one candidate commit at a time with `-x`.
4. If a cherry-pick conflicts only because the content is already on `main`, abort and record it here instead of creating empty commits.
5. After each landed slice, run targeted verification first, then broader verification if the slice survives.
6. Push only to `macos`, never `upstream`.

## Useful Commands

```bash
cd /Users/bradleybond/.codex/worktrees/worldmonitor/integration-main-20260329

git fetch --all --prune
git status --short --branch

git cherry -v HEAD macos/claude/update-web-version-6BNZ1
git show --stat 15cf5710f5090c55382601aabd590c15e2edb72e
git cherry-pick -x 15cf5710f5090c55382601aabd590c15e2edb72e

git show --stat 70d411faafa949b3373cb88c14acfea17ad8852f
git show --stat e06e37d2d50d271a636a1a384fe8c2667edaa98e

npm ci
npm run typecheck:all
npm run build
```

## Verification Notes

- This worktree started clean at `54a78881`
- `node_modules` had to be symlinked to `/Users/bradleybond/Developer/worldmonitor/node_modules` because sandboxed `npm ci` could not create the worktree-local directory
- `npm run typecheck:all` passed in the `.codex` worktree only when using the primary repo's dependency tree
- A clean `npm ci` in `/tmp/worldmonitor-install-c1157df1` resolved `typescript@5.9.3`
- That clean environment rejected `ignoreDeprecations: "6.0"`, so `e75c2f63` was reverted by `4e88fb60`
- `npm run build` reached Vite/Workbox and then failed with sandbox-style `EPERM` creating `/Users/bradleybond/.codex/worktrees/worldmonitor/integration-main-20260329/dist`
- Build failure appears environmental to this `.codex` worktree path, not an application compile failure
- One real cherry-pick probe was executed and aborted cleanly:
  - `0fce03ab46c9ad04dc5fd5e292bf460b4717c2f5`

## Intent

This branch should become the place where stale fork work is either:

- deliberately integrated commit-by-commit, or
- conclusively marked as already subsumed, obsolete, or not worth carrying forward

Do not turn this into another omnibus branch.
