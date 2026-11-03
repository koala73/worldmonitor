# WorldMonitor verification map

This directory indexes browser verification recipes. Start with the matching
feature and use its strict test when available. Read the
[skill entry](../SKILL.md#choose-the-proof) for preparation and manual server ownership.

## Baseline preconditions

- Launch one instance with `.agents/skills/verify-worldmonitor/scripts/wm-verify.sh launch`. It picks a free port in 4480-4487, starts `VITE_E2E=1 VITE_VARIANT=full vite`, and records the pid, port, and base URL in `.claude/verify-evidence/instance.json`.
- Run `wm-verify.sh doctor` before the first drive and again after any drive that failed. It refuses an instance whose port is held by someone else's process.
- Never drive an instance this run did not start. Other worktrees and the user's own `npm run dev` are also vite processes on nearby ports.
- Every drive gets a fresh browser context and a seeded localStorage profile (`steps/_profile.mjs`), so drives do not inherit each other's state.
- For an existing Playwright test, let its configuration manage the server. The launch and doctor steps apply only to manual drives.

## Driving conventions

- Drive through `wm-verify.sh drive <step.mjs> --name <label>`. Each drive writes its own evidence directory under `.claude/verify-evidence/`.
- One step file per feature, in `../steps/`. A step default-exports `async ({ page, base, shot, log, expectVisible }) => {…}`.
- Wait on the app's own readiness markers, never on a fixed sleep: `waitForBoot(page)` for `data-wm-event-handlers-ready`, `waitForBoot(page, { data: true })` for `data-wm-initial-data-ready`, and `waitForMap(page)` for a mounted map renderer.
- Prefer the stable handles this map names (`#unifiedSettingsBtn`, `#panelsGrid .panel[data-panel="…"]`, `.layer-toggle[data-layer="…"]`) over coordinates or tab order.
- URL state (`?layers=`, `?country=`) is written through a 250 ms debounce. Poll for it with `page.waitForFunction`; a single read right after the action is a race.
- Use `steps/_inspect.mjs` when a handle in this map no longer matches the app — it dumps the live panel keys, layer handles, header ids, and map renderer.

## Local API reality

The [contributor verification guide](../../../../CONTRIBUTING.md#verify-the-changed-path)
owns the local API contract and proof limits. Vite executes registered versioned
RPC handlers. Inspect whether a test stubs the response before claiming backend
coverage. Classify errors from the actual response and handler path.

## Proof and skip reporting

- Capture the action and the resulting state, not only the final screen: screenshot before the change and after it.
- Verify the side effect alongside what is visible — the persisted `localStorage` key, the URL, the re-read DOM state — not just the pixel.
- Every drive already records `transcript.txt`, `console-errors.json`, `console-warnings.json`, `failed-requests.json`, and `result.json`. Cite the evidence directory in any claim.
- Report an unreachable feature with the concrete prerequisite (credential, entitlement, GPU, deployed API) and the route attempted. Do not report it as verified through a different path.

## Features

- [Dashboard boot](./dashboard-boot.md) — a cold visit hydrates into a real dashboard: header, mounted map renderer, populated panel grid.
- [Panel settings](./panel-settings.md) — the Settings overlay applies a panel toggle to the live dashboard and persists it.
- [Country brief](./country-brief.md) — the `?country=` deep link opens the country intelligence panel and round-trips through the URL.
- [Global search](./global-search.md) — the command palette opens from the header and ⌘K, returns ranked matches, and closes.
- [Map layers](./map-layers.md) — a layer toggle changes the map, the shareable URL, and the persisted preference, in both renderers.
