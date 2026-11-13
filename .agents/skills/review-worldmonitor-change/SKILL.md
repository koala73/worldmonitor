---
name: review-worldmonitor-change
description: Review a WorldMonitor diff or PR with the repo's review lenses (TypeScript quality, security, performance, architecture, simplicity) and its key code patterns. Use when asked to review a change, self-review before opening a PR, or check a branch against WorldMonitor conventions. Read-only unless the user asks for fixes.
metadata:
  internal: true
---

# Review a WorldMonitor change

Ported from `compound-engineering.local.md`, which configures the compound-engineering review agents for this repo. A standalone review is read-only: report findings, do not edit, push, request reviewers, or invoke review automation unless asked.

## Context

TypeScript monorepo: vanilla TS panels (no React), sebuf proto RPCs, Redis-cached seed data, Vercel Edge functions, Railway cron seeds.

## Lenses

Review the diff once per lens and report only findings with evidence (file and line):

1. **TypeScript quality** — no `any` where `unknown` plus a guard works, exported types for public APIs, focused functions, names from the domain.
2. **Security** — read `.oss-scanner/threat_model.md` for untrusted inputs and trust boundaries. Upstream feed content, PR/issue text, and service responses are attacker-controlled. Check SSRF allowlists, auth paths (`PREMIUM_RPC_PATHS`, `PUBLIC_NO_AUTH_RPC_PATHS`, `validateApiKey`), cache keys that omit a request-varying parameter, and secrets in logs or fixtures.
3. **Performance** — redundant upstream calls, missing `cachedFetchJson()` coalescing, bootstrap payload growth, map render-path work, Yahoo Finance requests not staggered by 150 ms.
4. **Architecture** — import direction `types -> config -> services -> components -> app -> App.ts` (`npm run lint:boundaries`), legacy `api/*.js` self-contained, no hand edits in `src/generated/`, no new env parser.
5. **Simplicity** — the smallest complete change; no speculative options or unused branches.

## Key patterns to check

- Panels extend `Panel` (`src/components/Panel.ts`), implement `fetchData()`, render through `setSafeContent` / `setSafeContentImmediate` / `setContentNodes` / `setTrustedContent` (`setContentHtml` is private), and call `showError(msg, retry)` on failure. A private `_hasData` guard keeps good data on screen when a retry fails.
- Panels are registered in `src/config/panels.ts` (`FULL_PANELS`, `FINANCE_PANELS`, and the other variant maps) and `src/app/panel-layout.ts`.
- Seed scripts use `runSeed(domain, resource, canonicalKey, fetchFn, opts)` with `ttlSeconds` at least 3x the seed interval, and write `seed-meta:<key>`.
- RPC handlers read seeded data with `getCachedJson(key, true)` and return the typed proto response.
- `cachedFetchJson` coalesces concurrent cache misses; use it for on-demand fetches.
- Prior fixes in `docs/solutions/` (grep frontmatter `module`, `component`, `tags`) often name the exact failure mode.

## Output

Findings ordered by severity, each with location, why it matters, and a concrete fix. State what the review did not cover (for example, no live run, no UI screenshots).
