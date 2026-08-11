# Phase 8 — command and gate record

Commands were run from
`D:\global-intelligence-earth\worldmonitor-upstream-integration-lf` on
2026-08-11. Raw production-build stdout/stderr and its exit marker are retained
locally in this evidence directory and ignored by Git due to host ANSI control
sequences; this Markdown preserves the command/result summary.

| Command | Exit/result | Notes |
|---|---:|---|
| `node --import tsx --test tests/phase8-dashboard-priority.test.mts tests/panel-variant-config.test.mts` | 0; 21/21 | Default order, user-layout preservation condition, free-cap accessibility and no false observation badge. |
| `npm run typecheck:all` | 0 | Complete TypeScript/API type gate and Convex string-call audit. |
| Scoped `biome lint` for Phase 8 files | 0 | 11 files checked, no new lint error. |
| `npm run lint:api-contract` | 0 | 149 API files, 114 manifest entries, 96 query parameters. |
| `npm run sources:check` | 0 | 533 active hosts. |
| `npm run test:dom` | 0; 293/293 | 31 DOM test files passed. |
| `npm run lint` | 0 after environment correction | First run reached only the pre-existing 33 warnings/9 infos but its nested safe-HTML command could not find `npm` on PATH. Rerun with bundled Node and npm directories completed Safe HTML guard 0. |
| `npm run build:full` | 0 | Background production build completed in 28.77 seconds; PWA generated 252 precache entries. Existing Vite dynamic-import/chunk-size warnings were retained, with no build error. |

No Provider key, OAuth token, account login, paid entitlement, client-side
secret, actual flight response or military observation was used by the gates.
