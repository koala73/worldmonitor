# Phase 1 — WorldMonitor mother baseline evidence

**Recorded:** 2026-08-11 (Asia/Shanghai)

## Scope actually completed

- Fetched the formal fork and upstream references locally, verified ancestry,
  and created the independent integration branch from the official upstream SHA.
- Preserved existing worktrees and the legacy project; no `main` ref was moved.
- Applied the user-confirmed primary identity **全球实时热点追踪·探长版** in visible
  desktop/web shell surfaces, browser title and map attribution.
- Added the exact visible AGPL upstream statement and a link to World Monitor.
- Recorded PokieTicker only as a MIT-licensed source trace. No PokieTicker
  source or SQLite database was imported, and the legacy database remains a
  historical snapshot rather than a live-market fallback.
- Replaced the upstream Unix-only blog copy command with a path-guarded Node
  script so the Windows build can complete.

## Local Git gate

| Command / check | Exit | Result |
|---|---:|---|
| `git -c http.version=HTTP/1.1 fetch --no-tags --deepen=100 origin main` | 0 | Fork history refreshed locally. |
| `git -c http.version=HTTP/1.1 fetch --no-tags --depth=100 upstream +refs/heads/main:refs/remotes/upstream/main` | 0 | Upstream `main` available locally. |
| `git merge-base origin/main upstream/main` | 0 | `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`. |
| `git rev-list --left-right --count origin/main...upstream/main` | 0 | `0 43`: fork is pure-behind upstream. |
| New integration branch | 0 | `integration/pokieticker-maritime-china-factory` created from `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`; linked LF worktree is `D:\global-intelligence-earth\worldmonitor-upstream-integration-lf`. |

`main` remains at `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`. The old project,
the original worktree and all earlier diagnostic worktrees were left in place.

## Build and test gate

| Command | Exit | Result |
|---|---:|---|
| Root `npm ci --ignore-scripts --prefer-offline` | 0 | Root dependency graph installed under Node `v24.14.0`; lifecycle scripts were skipped because upstream `sharp@0.32.6` has no Node 24 prebuilt and the host lacks the C++ build toolchain. |
| `blog-site`: `npm ci --prefer-offline` with Node directory on `PATH` | 0 | Installed 297 packages. First attempt failed only because nested `esbuild` could not find `node`; retry passed. |
| `npm run typecheck:all` | 0 | TypeScript and Convex string-call audit passed. |
| Branding, metadata, relative-route and Windows-copy contracts | 0 | 29 invoked targeted tests passed. |
| `npm run test:dom` | 0 | 31 files and 293 tests passed. |
| `tsx --test tests/ucdp-seed-resilience.test.mjs` | 0 | 12 tests passed; this was the last child observed during the full-suite timeout. |
| `npm run test:data` | tool timeout 124 | All-suite process exceeded the 64-second noninteractive limit; normal final exit was not captured. This is **not** a pass. No test process remained afterward. |
| `npm run build:full` | 0 | Final rerun generated product facts, OpenAPI, agent skills, blog, crawlable corpus, sitemap and Vite/PWA output. Vite emitted existing warnings only. |

The first ordinary root `npm ci` is not counted as a pass: it attempted to
build `sharp` against Node 24 and failed due to the missing Visual Studio C++
toolchain. The successful `--ignore-scripts` install above does not certify any
native capability.

## Visual acceptance

- URL tested: `http://127.0.0.1:4173/dashboard`, served from final `dist`.
- DOM check: browser title `全球实时热点追踪·探长版 - Global Intelligence Earth`;
  visible header brand `全球实时热点追踪·探长版`; footer contains the exact AGPL
  statement and a link to `https://github.com/koala73/worldmonitor`.
- Screenshot: [`phase1-production-preview.png`](phase1-production-preview.png)
  (157,657 bytes).
- No Provider credentials were configured. The preview displayed unavailable or
  waiting states rather than synthetic bars or fabricated live content.

## Implementation commit

`c889fcfbdab4bf2bcd7a28f85ed32114f288d6aa`
(`chore(integration): establish WorldMonitor mother baseline`) is the real,
locally created Phase 1 implementation commit. This documentation receipt is
the immediately following backfill commit, so the implementation SHA was never
predicted or presented before it existed.
