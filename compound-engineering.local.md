---
review_agents:
  - compound-engineering:review:kieran-typescript-reviewer
  - compound-engineering:review:security-sentinel
  - compound-engineering:review:performance-oracle
  - compound-engineering:review:architecture-strategist
  - compound-engineering:review:code-simplicity-reviewer
---

# WorldMonitor Review Context

TypeScript monorepo: Vanilla TS panels (no React), sebuf proto RPCs, Redis-cached seed data,
Vercel edge functions, Railway cron seeds.

Key patterns:

- Panels extend `Panel` base class with `fetchData()` returning boolean, `setContent(html)`, `showError(msg, retry)`
- Private `_hasData` guard prevents overwriting good data with error on retry
- Seed scripts use `runSeed(domain, name, key, fetchFn, options)` with TTL ≥ 3× seed interval
- RPC handlers read from Redis via `getCachedJson(key, true)`, return typed proto response
- `cachedFetchJson` coalesces concurrent cache misses — use it for on-demand fetches
- All panels registered in `src/config/panels.ts` (FINANCE_PANELS + FULL_PANELS) and `src/app/panel-layout.ts`
