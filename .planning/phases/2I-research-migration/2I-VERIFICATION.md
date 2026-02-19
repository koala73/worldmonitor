---
phase: 2I-research-migration
verified: 2026-02-19T12:45:00Z
status: passed
score: 9/9 must-haves verified
re_verification: false
---

# Phase 2I: Research Migration Verification Report

**Phase Goal:** Migrate research domain (arXiv papers, GitHub trending repos, Hacker News items) to sebuf -- implement handler with 3 RPCs proxying upstream APIs, create service module with port/adapter pattern, rewire all consumers, delete legacy endpoints
**Verified:** 2026-02-19T12:45:00Z
**Status:** PASSED
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | POST /api/research/v1/list-arxiv-papers returns JSON with papers array (id, title, summary, authors, categories, publishedAt, url) | VERIFIED | handler.ts lines 71-97 map all 7 fields; route mounted in gateway line 39 |
| 2 | POST /api/research/v1/list-trending-repos returns JSON with repos array (fullName, description, language, stars, starsToday, forks, url) | VERIFIED | handler.ts lines 137-145 map all 7 fields; route mounted in gateway line 39 |
| 3 | POST /api/research/v1/list-hackernews-items returns JSON with items array (id, title, url, score, commentCount, by, submittedAt) | VERIFIED | handler.ts lines 181-190 map all 7 fields; route mounted in gateway line 39 |
| 4 | All three RPCs return empty arrays (not errors) when upstream APIs fail | VERIFIED | Each RPC wrapped in try/catch returning `{ papers/repos/items: [], pagination: undefined }`; early returns on !response.ok also return [] |
| 5 | Service module exports fetchArxivPapers, fetchTrendingRepos, fetchHackernewsItems backed by ResearchServiceClient | VERIFIED | src/services/research/index.ts lines 18-59; ResearchServiceClient imported line 2, used line 12 |
| 6 | Proto types ArxivPaper, GithubRepo, HackernewsItem re-exported from service module | VERIFIED | src/services/research/index.ts line 10: `export type { ArxivPaper, GithubRepo, HackernewsItem }` |
| 7 | All three legacy API endpoints deleted (api/arxiv.js, api/github-trending.js, api/hackernews.js) | VERIFIED | All three files return "No such file or directory"; git commit 9e45c9c confirms deletion |
| 8 | All three legacy service files deleted (src/services/arxiv.ts, src/services/github-trending.ts, src/services/hackernews.ts) | VERIFIED | All three files return "No such file or directory"; git commit 9e45c9c confirms deletion |
| 9 | Config entries for arxiv, githubTrending, hackernews removed from API_URLS and REFRESH_INTERVALS | VERIFIED | grep on src/config/variants/base.ts for those keys returns zero results |

**Score:** 9/9 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `api/server/worldmonitor/research/v1/handler.ts` | ResearchServiceHandler with 3 RPC implementations, exports researchHandler | VERIFIED | 241 lines, substantive. Implements ResearchServiceHandler interface (line 205). All 3 RPCs: listArxivPapers (lines 206-215), listTrendingRepos (lines 218-228), listHackernewsItems (lines 230-240). Exports `researchHandler` const. |
| `api/[[...path]].ts` | Research routes mounted in catch-all gateway, contains createResearchServiceRoutes | VERIFIED | Lines 25-26 import both `createResearchServiceRoutes` and `researchHandler`. Line 39 spreads research routes into `allRoutes` array after aviation. |
| `src/services/research/index.ts` | Port/adapter service module, exports fetchArxivPapers, fetchTrendingRepos, fetchHackernewsItems, ArxivPaper, GithubRepo, HackernewsItem | VERIFIED | 59 lines. All 3 fetch functions exported (lines 18, 33, 48). All 3 proto types re-exported (line 10). Circuit breakers per-RPC (lines 14-16). |
| `src/generated/server/worldmonitor/research/v1/service_server.ts` | Generated ResearchServiceHandler interface with 3 RPCs | VERIFIED | Exists. Interface at line 120, all 3 RPCs declared (lines 121-123). createResearchServiceRoutes function at line 127. |
| `src/generated/client/worldmonitor/research/v1/service_client.ts` | Generated ResearchServiceClient with 3 RPC methods | VERIFIED | Exists. ResearchServiceClient class at line 113, all 3 methods declared (lines 124, 148, 172). |
| `api/[[...path]].js` (sidecar bundle) | Sidecar rebuilt including research routes | VERIFIED | File exists at 119,404 bytes (119 KB), dated 2026-02-19 12:24. Contains 16 references to research-related symbols. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `api/[[...path]].ts` | `api/server/worldmonitor/research/v1/handler.ts` | `import researchHandler` | WIRED | Line 26: `import { researchHandler } from './server/worldmonitor/research/v1/handler'` |
| `api/[[...path]].ts` | `src/generated/server/worldmonitor/research/v1/service_server.ts` | `import createResearchServiceRoutes` | WIRED | Line 25: `import { createResearchServiceRoutes } from '../src/generated/server/worldmonitor/research/v1/service_server'` |
| `api/[[...path]].ts` | `researchHandler` (via route mounting) | `createResearchServiceRoutes(researchHandler, serverOptions)` | WIRED | Line 39: `...createResearchServiceRoutes(researchHandler, serverOptions)` in allRoutes |
| `api/server/worldmonitor/research/v1/handler.ts` | `src/generated/server/worldmonitor/research/v1/service_server.ts` | implements ResearchServiceHandler | WIRED | Line 15: `ResearchServiceHandler` imported as type; line 205: `export const researchHandler: ResearchServiceHandler = { ... }` |
| `src/services/research/index.ts` | `src/generated/client/worldmonitor/research/v1/service_client.ts` | `import ResearchServiceClient` | WIRED | Line 2: `import { ResearchServiceClient, type ArxivPaper, type GithubRepo, type HackernewsItem }` |
| `src/services/research/index.ts` | `@/utils` | `import createCircuitBreaker` | WIRED | Line 7: `import { createCircuitBreaker } from '@/utils'`; confirmed exported from src/utils/index.ts line 148 |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| DOMAIN-05 | 2I-01, 2I-02 | Research domain proto (arXiv papers, GitHub trending, Hacker News) with service RPCs and HTTP annotations | SATISFIED | Handler implements all 3 RPCs typed against generated proto server interface. Service module wraps generated client. All proto types (ArxivPaper, GithubRepo, HackernewsItem) used throughout. |
| SERVER-02 | 2I-01, 2I-02 | Handler implementations for each domain that proxy requests to upstream external APIs and return proto-typed responses | SATISFIED | handler.ts proxies 3 distinct upstream APIs (arXiv Atom XML, GitHub trending JSON, HN Firebase JSON) and returns proto-typed responses. Routes mounted in catch-all gateway. |

No orphaned requirements found: REQUIREMENTS.md maps `DOMAIN-05` and `SERVER-02` to Phase 2I; both are claimed and satisfied by plans 2I-01 and 2I-02.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `api/server/worldmonitor/research/v1/handler.ts` | 62, 67, 128, 131, 135, 160, 163 | `return []` | Info | These are intentional graceful-degradation returns on upstream API failure, not stubs. All are in error paths explicitly designed to return empty arrays. Not a concern. |

No TODO/FIXME/PLACEHOLDER/stub patterns found in research files. No empty handler bodies. No `console.log`-only implementations.

**Pre-existing TypeScript errors** (not caused by Phase 2I):
- `api/server/worldmonitor/wildfire/v1/handler.ts`: 8 type errors (pre-existing, flagged in 2I-01 SUMMARY)
- `src/config/feeds.ts`, `src/config/variant.ts`, `src/services/*.ts`: `import.meta.env` errors (Vite-only, pre-existing, out of scope for API tsconfig)

The research handler itself compiles with zero TypeScript errors.

---

### Human Verification Required

The following items require runtime testing and cannot be verified statically:

#### 1. arXiv XML Parsing Correctness

**Test:** POST to `/api/research/v1/list-arxiv-papers` with `{ "category": "cs.AI", "pagination": { "pageSize": 5, "cursor": "" } }`
**Expected:** Response contains `papers` array with 5 entries each having non-empty `id`, `title`, `summary`, `authors` array, `categories` array, numeric `publishedAt`, and `url` starting with `https://`
**Why human:** XML attribute parsing with `ignoreAttributes: false` and `@_term`/`@_href` extraction cannot be validated statically -- requires live arXiv API response

#### 2. GitHub Trending Primary/Fallback Behaviour

**Test:** POST to `/api/research/v1/list-trending-repos` with `{ "language": "python", "period": "daily", "pagination": { "pageSize": 10, "cursor": "" } }`
**Expected:** Response contains `repos` array with entries each having `fullName` in `author/name` format, numeric `stars`, `starsToday`, `forks`
**Why human:** Requires live gitterapp.com API call; fallback logic to herokuapp only triggers if primary fails (can't force this statically)

#### 3. Hacker News 2-Step Fetch and Bounded Concurrency

**Test:** POST to `/api/research/v1/list-hackernews-items` with `{ "feedType": "top", "pagination": { "pageSize": 10, "cursor": "" } }`
**Expected:** Response contains `items` array with 10 entries each having `title`, numeric `id`, numeric `score`, `by`, `submittedAt` in milliseconds (not seconds)
**Why human:** Requires live Firebase API; 2-step fetch (IDs then items) and millisecond conversion (`raw.time * 1000`) can only be validated at runtime

---

### Gaps Summary

No gaps found. All 9 observable truths are verified. All key artifacts exist and are substantive. All key links are wired. Both requirements (DOMAIN-05, SERVER-02) are satisfied. All 6 legacy files deleted. Config is clean.

The phase achieved its stated goal: the research domain is fully migrated to sebuf with a handler implementing 3 RPCs, a service module with port/adapter pattern, legacy endpoints deleted, and the sidecar rebuilt.

---

_Verified: 2026-02-19T12:45:00Z_
_Verifier: Claude (gsd-verifier)_
