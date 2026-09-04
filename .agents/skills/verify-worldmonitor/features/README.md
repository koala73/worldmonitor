# WorldMonitor verification map

This directory is the maintained source for verifying the user-facing behavior of the WorldMonitor browser dashboard. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch one instance with `.agents/skills/verify-worldmonitor/scripts/wm-verify.sh launch`. It picks a free port in 4480-4487, starts `VITE_E2E=1 VITE_VARIANT=full vite`, and records the pid, port, and base URL in `.claude/verify-evidence/instance.json`.
- Run `wm-verify.sh doctor` before the first drive and again after any drive that failed. It refuses an instance whose port is held by someone else's process.
- Never drive an instance this run did not start. Other worktrees and the user's own `npm run dev` are also vite processes on nearby ports.
- Every drive gets a fresh browser context and a seeded localStorage profile (`steps/_profile.mjs`), so drives do not inherit each other's state.
- The dev server serves the app only. `/api/*` is NOT the Vercel Edge runtime here — see "Local API reality" below.

## Driving conventions

- Drive through `wm-verify.sh drive <step.mjs> --name <label>`. Each drive writes its own evidence directory under `.claude/verify-evidence/`.
- One step file per feature, in `../steps/`. A step default-exports `async ({ page, base, shot, log, expectVisible }) => {…}`.
- Wait on the app's own readiness markers, never on a fixed sleep: `waitForBoot(page)` for `data-wm-event-handlers-ready`, `waitForBoot(page, { data: true })` for `data-wm-initial-data-ready`, and `waitForMap(page)` for a mounted map renderer.
- Prefer the stable handles this map names (`#unifiedSettingsBtn`, `#panelsGrid .panel[data-panel="…"]`, `.layer-toggle[data-layer="…"]`) over coordinates or tab order.
- URL state (`?layers=`, `?country=`) is written through a 250 ms debounce. Poll for it with `page.waitForFunction`; a single read right after the action is a race.
- Use `steps/_inspect.mjs` when a handle in this map no longer matches the app — it dumps the live panel keys, layer handles, header ids, and map renderer.

## Local API reality

`npm run dev` is a Vite server, not `vercel dev`. Only a few `/api/*` routes have dev middleware (`/api/polymarket`, `/api/rss-proxy`, `/api/youtube/live`, `/api/gpsjam`, and the sebuf version alias). Every other `/api/*` path returns its own **JavaScript source** with `content-type: text/javascript`, so the client's `JSON.parse` throws.

Consequences for verification:

- A local run always shows a baseline of console errors and 4xx/5xx responses (`/api/wm-session` 404, `/api/gpsjam` 503, `SyntaxError: Unexpected token 'i', "import __v"…`). These are the dev server, not product regressions. Compare against a previous run's `console-errors.json`, do not expect zero.
- UI behavior, routing, persistence, panel/layer/settings state, and bundled-data panels are fully verifiable locally.
- Anything whose proof is the *content* of an Edge endpoint (bootstrap hydration payloads, premium gating, entitlements, auth sessions) is NOT verifiable here. Verify it against a deployed preview instead, and say so rather than reporting a local pass.
- Setting `VITE_WS_API_URL` to redirect `/api/*` at production was tried and did **not** take effect through the shell environment — do not document it as a working lever without re-proving it.

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
