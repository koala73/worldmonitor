# Phase 7 — command and gate record

Commands were run from
`D:\global-intelligence-earth\worldmonitor-upstream-integration-lf` on
2026-08-11. Raw full-build stdout/stderr and its exit marker are retained
locally in this evidence directory but ignored by Git because the host emits
ANSI control sequences; this committed record preserves the exact command,
result and material warnings.

| Command | Exit/result | Notes |
|---|---:|---|
| `node --import tsx --test tests/china-factory-route.test.mts` | 0; 3/3 | Registry source/HS boundary, URL normalization and selected-filter validation. |
| `npm run typecheck:all` | 0 | Entire TypeScript gate. |
| `node --import tsx --test tests/china-factory-route.test.mts tests/china-corridor-config.test.mts tests/comtrade-period-and-coverage.test.mjs` | 0; 23/23 | Phase 7 route plus existing corridor/Comtrade boundary contracts. |
| `npm run test:dom` | 0; 293/293 | Existing DOM suite stayed green. |
| `npm run lint:api-contract` | 0; 149/114/96 | API contract gate. |
| `npm run sources:generate` then `npm run sources:check` | 0; 533 active hosts | Source attribution gate. |
| Scoped `biome lint` over Phase 7 files | 0 | No new scoped lint issue. The first `npm exec` attempt could not find `node` in its child PATH; rerun with the bundled Node directory succeeded and did not report a code diagnostic. |
| `npm run lint` | 0 | Existing baseline: 33 warnings and 9 infos; Safe HTML guard passed. |
| `npm run build:full` | 0 | Final production build completed in 26.14 seconds; PWA generated 251 precache entries. Existing Vite dynamic-import/chunk-size warnings were retained, with no build error. |

No Provider key, returned Comtrade/customs response, paid B/L entitlement,
provider licence confirmation or client-side secret was used by these gates.
