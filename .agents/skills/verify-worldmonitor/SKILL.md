---
name: verify-worldmonitor
description: Verify WorldMonitor dashboard behavior with existing browser tests or a scoped manual drive. Use for panels, map layers, settings, search, country briefs, boot, or dashboard screenshots.
---

# Verify WorldMonitor

WorldMonitor's primary surface is a browser dashboard: a Vite/TypeScript SPA served at `/dashboard`, with a map, a panel grid, a settings overlay, and a command palette. This skill launches one isolated instance of it, drives a feature the way a user does, and leaves evidence behind.

This skill proves browser behavior. Use the [code and check map](../../../AGENTS.md#find-the-code-and-its-checks) for backend, desktop, worker, or documentation changes.

Run everything from the repo root of the worktree under test.

## Choose the proof

1. Name the user action and expected result. Load the matching [feature recipe](features/README.md), including its data path and proof limits.
2. Follow [worktree preparation](../../../CONTRIBUTING.md#worktrees-and-preflight). Run an existing strict test first when it covers the outcome. Country Brief uses `npm run test:e2e:country-brief`. Playwright owns that test's server; do not also run `launch` for it.
3. For an interaction the test does not cover, use the manual steps below. Extend an existing test when a lasting regression check is needed.
4. Report the exercised path, controlled responses, evidence, and unmet criteria. Apply the [local API proof limits](../../../CONTRIBUTING.md#verify-the-changed-path). A successful drive proves only its assertions.

## Launch

One long-lived dev server per run; every drive gets a fresh browser context against it.

```bash
.agents/skills/verify-worldmonitor/scripts/wm-verify.sh launch
```

It picks the first free port in 4480-4487, starts `VITE_E2E=1 VITE_VARIANT=full npm run dev`, waits until `/tests/map-harness.html` answers 200 (the same readiness probe `playwright.config.ts` uses — it forces a real module transform, so 200 means "can serve the app", not just "socket open"), and writes `.claude/verify-evidence/instance.json` with the pid, port and base URL.

- `VITE_E2E=1` is not optional. It is what stamps `data-wm-event-handlers-ready` and `data-wm-initial-data-ready` on `<html>`; every drive waits on those markers.
- Pick a variant with `WM_VERIFY_VARIANT=tech|finance|commodity|energy|happy`.
- Force a port with `launch <port>`. Launch refuses a port someone else holds rather than fighting for it.
- Prepare dependencies through preflight before launch. If Chromium is missing, run `npx playwright install chromium`.

**Isolation.** Two instances can run side by side on different ports, but they share `.claude/verify-evidence/instance.json`, so this skill supports **one instance per worktree**. If `launch` reports an instance already running, either reuse it (`doctor` first) or `cleanup`. Never adopt a dev server this run did not start — the user's own `npm run dev` and other worktrees are also vite processes.

## Doctor

```bash
.agents/skills/verify-worldmonitor/scripts/wm-verify.sh doctor
```

Read-only. Answers "is this instance worth driving?": the recorded pid is alive, the port is held by **our** process tree (walking parents, so vite-under-npm counts), `/dashboard` returns 200 with the app shell, the process is still vite/npm, and the launch recorded `VITE_E2E=1`. It also prints the dev-server log's error-line count and path.

Run it before the first drive, after any drive that failed, and any time behavior looks wrong. Exit code 0 = OK.

If doctor cannot see the problem — a wedged page on a healthy server — relaunch rather than hoping: `cleanup` then `launch`.

## Drive

```bash
.agents/skills/verify-worldmonitor/scripts/wm-verify.sh drive <step.mjs> --name <label>
```

A step file default-exports an async function and lives in `steps/`:

```js
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

export default async function ({ page, base, shot, log, expectVisible }) {
  await seedProfile(page);                       // clear storage, dismiss first-run overlays
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });       // data-wm-* readiness markers
  const renderer = await waitForMap(page);       // 'deckgl' | 'globe' | 'svg'
  await expectVisible('#panelsGrid .panel');
  await shot('booted');
  log('renderer', renderer);
}
```

The harness gives each step `page`, `context`, `base`, `shot(name)`, `log(...)`, and `expectVisible(selector)`. It records console errors and warnings, every response ≥400, a transcript, and a failure screenshot if the step throws. Recorded errors alone do not fail the drive. Assert the requested result and inspect relevant failures before calling the feature verified.

Ready-made steps, one per mapped feature:

| Step | Feature |
|---|---|
| `steps/dashboard-boot.mjs` | [Dashboard boot](features/dashboard-boot.md) |
| `steps/panel-settings.mjs` | [Panel settings](features/panel-settings.md) |
| `steps/country-brief.mjs` | [Country brief](features/country-brief.md) |
| `steps/global-search.mjs` | [Global search](features/global-search.md) |
| `steps/map-layers.mjs` | [Map layers](features/map-layers.md) |
| `steps/_inspect.mjs` | not a feature — dumps live panel keys, layer handles, header ids, and the map renderer when a handle in the map has drifted |

Environment switches: `WM_VERIFY_HEADED=1` (real window, real GPU — the only way to get the deck.gl map), `WM_VERIFY_SOFTWARE_GL=1` (reproduce the repo's playwright GL flags), `WM_VERIFY_PANEL`, `WM_VERIFY_LAYER`, `WM_VERIFY_COUNTRY`, `WM_VERIFY_SEARCH`.

Stable handles worth knowing: `#panelsGrid .panel[data-panel="<key>"]`, `#unifiedSettingsBtn`, `#us-tab-panels`, `#usPanelToggles .panel-toggle-item[data-panel="<key>"]`, `.panels-save-layout`, `#searchBtn`, `.search-modal .search-input`, `.search-result-item[data-index]`, `.layer-toggle[data-layer="<key>"]`, `#country-deep-dive-panel`, `#deep-dive-close`, `#mapDimensionToggle`.

## Evidence

Every drive writes `.claude/verify-evidence/<timestamp>-<label>/` containing numbered screenshots, `transcript.txt`, `console-errors.json`, `console-warnings.json`, `failed-requests.json`, and `result.json`. **Cleanup never touches these** — they are the proof and they outlive the run. `.claude/` is gitignored, so nothing here is ever committed.

Proof standards for this app:

- Drive the real user path — the gear button, the chip, the deep link — not an internal setter or a test-only endpoint.
- Capture the action and its result, not just the final screen: a screenshot before the change and one after.
- Check the side effect next to the pixel: the persisted `localStorage` key, the `?layers=` / `?country=` URL, the re-read DOM state. A panel that appears but is not persisted is a bug the screenshot cannot see.
- Wait on the app's own readiness markers. A fixed sleep either flakes or hides a regression.
- Use the [local API proof limits](../../../CONTRIBUTING.md#verify-the-changed-path). Inspect the response and the handler path before classifying an API failure. Do not dismiss an error merely because the run is local.

## Cleanup

```bash
.agents/skills/verify-worldmonitor/scripts/wm-verify.sh cleanup
```

Terminates the recorded pid and its children (SIGTERM, then SIGKILL after 10 s) and removes `instance.json`. It kills **only what launch started** — never `pkill vite`, which would take out the user's own dev server and every other worktree's.

Run it after the last drive of the run, and after any failed iteration, so a broken attempt does not strand a port.

## Helpers

- `scripts/wm-verify.sh` — `launch [port] | doctor | drive <step.mjs> [--name label] | cleanup`. Executable; invocations above.
- `scripts/drive.mjs` — the Playwright driver `drive` delegates to. Runnable directly: `node .agents/skills/verify-worldmonitor/scripts/drive.mjs <step.mjs> --name <label>`.
- `steps/_profile.mjs` — `seedProfile(page, overrides)`, `waitForBoot(page, {data})`, `waitForMap(page)`.

## Feature map

[`features/README.md`](features/README.md) indexes user entry points, recipes, and gotchas. Exercise the entry points affected by the change and name those left unverified. Update the relevant recipe when behavior or stable handles change.

## Registration

The canonical copy is `.agents/skills/verify-worldmonitor/`. Edit that copy. An agent
can read this file directly even when automatic discovery is unavailable.

For Claude Code discovery, run the following only when
`.claude/skills/verify-worldmonitor` does not exist. Preserve an existing destination
and inspect it before making changes. Do not maintain a second copy.

```bash
mkdir -p .claude/skills
ln -s ../../.agents/skills/verify-worldmonitor .claude/skills/verify-worldmonitor
```

If Git ignores a new skill file, inspect `git check-ignore -v <path>` before staging
that specific file. Ignore rules can differ between clones.
