---
title: Per-worktree node_modules duplication - measuring bun as the fix (spike)
date: 2026-09-01
category: performance-issues
module: package-management-worktree-tooling
problem_type: performance_issue
component: development_workflow
symptoms:
  - "125 worktrees hold 181.8 GB, of which 135.5 GB is node_modules across 70 worktrees, on a volume with 47 GB free"
  - "a 7-day dormancy filter reclaims only 2.0 GB - the pile is generated faster than cleanup can sweep it"
  - "npm ci writes fresh blocks per worktree; installed files report links=1, so nothing is shared with the cache"
root_cause: design_limitation
resolution_type: investigation
severity: medium
related_components:
  - tooling
  - development_workflow
tags: [package-manager, bun, pnpm, npm, worktree, node-modules, disk-space, clonefile, apfs, spike]
---

# Spike: bun as the package manager, to stop per-worktree node_modules duplication

Status: **spike / draft — not a recommendation to merge.** Nothing here changes
how the repo installs today. `package-lock.json` remains the single source of
truth and `npm ci` remains the install path.

## The problem this is a candidate answer to

One local machine currently carries **125 worktrees / 181.8 GB**, of which
**135.5 GB is `node_modules` across 70 worktrees** — on a volume with 47 GB
free. Every bootstrapped worktree pays a fresh ~2.0 GB because `npm ci` writes
new blocks for every file.

That is not an old-junk problem that cleanup fixes. Measured with a 7-day
dormancy filter, only **one** of those 70 worktrees is untouched — the pile is
generated faster than it can be swept.

## Why npm cannot fix it

Verified, not assumed:

- `npm --install-strategy=linked` exists (npm 11.12.1 supports it) but its store
  is `node_modules/.store` **inside each project**. It is an isolation feature
  for catching phantom dependencies; it shares nothing between checkouts.
- npm's cache is content-addressable but stores **gzipped tarballs**
  (`~/.npm/_cacache/content-v2`), so extraction must write new bytes. Confirmed
  on a real install: every file in `node_modules` reports `links=1`.
- The two upstream paths that would change this are not moving:
  [nodejs/node#26489](https://github.com/nodejs/node/issues/26489) (reflink
  support) is **closed**, and [npm/rfcs#912](https://github.com/npm/rfcs/discussions/912)
  ("RFC: Content-Addressable Store") was opened 2026-07-11 with zero comments.

## Why bun rather than pnpm

Both solve the duplication. bun is proposed here for two repo-specific reasons:

1. **bun's default install backend on macOS is `clonefile`** (`--backend` accepts
   `clonefile` (default), `hardlink`, `symlink`, `copyfile`). It produces real
   files. pnpm's global virtual store is **symlink**-based, and `.husky/pre-push`
   hard-fails on `node_modules` being a symlink — the guard exists because a
   later cleanup can delete the symlink *target*.
2. bun needs no configuration to get the win; pnpm needs `virtualStoreType: global`
   plus a store on the same filesystem.

Ecosystem context (measured 2026-09-01 by classifying the root lockfile of the
top 100 TypeScript repos by stars, via the GitHub API):

| package manager | >15k stars, pushed since 2026-08-01 | created in 2026, >2k stars |
|---|---|---|
| pnpm | 48 | 33 |
| npm | 21 | 31 |
| bun | 8 | **24** |
| yarn | 18 | 2 |
| unknown | 5 | 10 |

pnpm leads the established cohort (`vitejs/vite` itself, angular, supabase,
tailwindcss, shadcn-ui, n8n, immich). bun is the fastest riser among new
projects. WorldMonitor appears in the npm column of the first cohort.

## What was measured on this repo

Two throwaway worktrees off `origin/main`, since removed.

| check | result |
|---|---|
| `bun install` (1517 packages resolved) | exit 0, **28s** cold / **9s** warm |
| `npm run typecheck` (`tsc --noEmit`) | exit 0 |
| `npx vite build --mode production` | exit 0, 30.7s — maplibre 1.05 MB, GlobeMap 1.83 MB, deck-stack 765 kB, PWA SW generated |
| `npm run test:sidecar` | **447 pass / 0 fail** |
| `npm run test:data` (387 files) | **29,142 pass / 0 fail / 35 skipped**, 7m8s |
| `blog-site` nested install (postinstall chain) | ran, 263 entries |

Disk, measured as real free-space delta rather than `du`:

```
worktree #1 (cold cache):  2274 MB real
worktree #2 (warm cache):   341 MB real   <- du reports 2.1 GB
   of which blog-site:      142 MB  (npm installs it; no sharing)
   bun's own tree:         ~199 MB  -> ~10x sharing
shared ~/.bun/install/cache: 2.1 GB, paid ONCE
```

Extrapolated to the current 70 bootstrapped worktrees: roughly **135 GB -> ~25 GB**.

## What this spike changes

Three things, each inert on a checkout with no `bun.lock`:

1. **`trustedDependencies` in `package.json`.** bun blocks dependency lifecycle
   scripts by default; it blocked 4 here (`browser-tabs-lock`, `core-js`,
   `es5-ext`, `protobufjs`). The build and 447 sidecar tests passed anyway, but
   `protobufjs` is listed explicitly because of the generated sebuf clients.
   npm ignores the field.
2. **A completed-install marker for bun.** This is the load-bearing fix. bun
   leaves **no** marker inside `node_modules` — only `.bin`, which an interrupted
   install also creates — so `.husky/pre-push` would see no
   `node_modules/.package-lock.json` and run a full `npm ci` **on every push**,
   silently undoing the win. `bun install --frozen-lockfile` on an installed
   tree is not a workaround: it costs **~11s** (measured twice), against a
   cached-green re-push of ~0.5s.

   So `scripts/bun-install.mjs` stamps `node_modules/.wm-bun-install` with the
   sha256 of the `bun.lock` it installed from, and both the gate and
   `shouldInstallDependencies()` check it. That is **stronger** than npm's
   marker, which proves completion but not freshness — a stale tree after a
   dependency bump is invisible to `.package-lock.json` and caught here.
3. **Lockfile policy.** `bun.lock` is gitignored. `package-lock.json` stays
   authoritative for the life of the spike; deleting those `.gitignore` lines is
   the deliberate act that flips it.

## What is still unproven

- CI. Every workflow still runs `npm ci`; nothing here touches them.
- `pro-test/node_modules` is not installed by the postinstall chain (it belongs
  to `build:pro`), so the built-output tests were not exercised under bun.
- Linux/CI filesystems have no APFS `clonefile`. bun falls back to `hardlink`
  there, which shares blocks differently; unmeasured.
- Desktop/Tauri and the Railway seeder images were not exercised.

## How to reproduce

```bash
git worktree add --detach /tmp/wm-bun origin/main
cd /tmp/wm-bun
node scripts/bun-install.mjs      # bun install + stamp the marker
npm run typecheck && npx vite build --mode production && npm run test:sidecar
```

Measure the sharing with a second worktree, comparing `df` free-space delta
against what `du` reports — `du` counts cloned blocks that cost nothing.
