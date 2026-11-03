---
title: "apt-get install with cached .deb paths downloads them again from the mirror"
date: 2026-10-23
category: performance-issues
module: CI tests
problem_type: performance_issue
component: testing_framework
symptoms:
  - "Install browser fonts took 94-252s in at least one variant-smoke shard in each of 12 consecutive Test runs, against 10-20s in the others"
  - "The font cache restore reported a hit, then apt logged Get:1..3 from azure.archive.ubuntu.com and Fetched 7659 kB in 3min 4s (41.5 kB/s)"
root_cause: config_error
resolution_type: workflow_improvement
severity: medium
tags: [ci-performance, github-actions, apt, dpkg, actions-cache, browser-fonts]
---

# apt-get install with cached .deb paths downloads them again from the mirror

## Problem

The `install-browser-fonts` composite action caches three font `.deb` files
with `actions/cache` and installed them with
`sudo apt-get install -y --no-install-recommends ~/.cache/wm-browser-fonts/*.deb`.
The cache hit on every run, but apt still downloaded all three packages from
the Ubuntu mirror. The Azure mirror is sometimes slow, so one or more
`variant-smoke` shards waited minutes on it, and that shard set the Test
workflow's wall time.

## Symptoms

- In run 39839159870, `variant-smoke (1)` restored the 7 MB cache in about 1s,
  then logged `Need to get 7659 kB of archives`, three `Get:` lines from
  `azure.archive.ubuntu.com`, and `Fetched 7659 kB in 3min 4s (41.5 kB/s)`.
- Across the last 12 successful PR runs of Test, every run had at least one
  shard at 94-252s for this step, while the other shards took 10-20s.

## What Didn't Work

- The cache itself. A cache hit says only that the files were restored, not
  that the install step used them.

## Solution

Install the cached files with `dpkg`, which never contacts a mirror
(`.github/actions/install-browser-fonts/action.yml`, PR #9554):

```bash
debs=(~/.cache/wm-browser-fonts/*.deb)
if ! sudo dpkg -i "${debs[@]}"; then
  sudo apt-get install -y -f --no-install-recommends
  for deb in "${debs[@]}"; do
    pkg=$(dpkg-deb -f "$deb" Package)
    if [ "$(dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null)" != 'install ok installed' ]; then
      echo "::error::$pkg is not installed after apt-get -f"
      exit 1
    fi
  done
fi
```

The fallback handles an image change that drops a dependency: `apt-get -f`
fetches only the missing dependency. The `dpkg-query` loop exists because
`apt-get install -f` can also repair the broken state by removing the packages
`dpkg` just unpacked, and it still exits 0.

The PR's own Test runs took 3-14s for the step in every shard and 252-255s of
wall time, against a 6-minute median and 10-minute p90 over the previous 30 PR
runs.

## Why This Works

Reproduced in an `ubuntu:24.04` amd64 container:

- `apt-get install /root/.cache/wm-browser-fonts/*.deb` printed `Get:1..3`
  from `archive.ubuntu.com` for all three packages. When a configured
  repository has the same version as the local file, apt fetched it from the
  repository.
- With `--network none`, `dpkg -i` on the same files installed all three, and
  `fc-list :lang=zh|ja|ko|th|hi` then resolved WenQuanYi Zen Hei, Loma and
  Lohit Devanagari.
- In an image without `fontconfig` and no package lists, `apt-get install -f`
  printed `Removing fonts-wqy-zenhei` and exited 0. The `dpkg-query` loop
  turned that into `exit 1`.

## Prevention

- When caching `.deb` files in CI, install them with `dpkg -i`, not
  `apt-get install <paths>`. Check the job log for `Get:` lines on a cache-hit
  run before counting the cache as working.
- After any `apt-get install -f`, check the packages you meant to install are
  still `install ok installed`.
- `tests/ci-workflow-coverage.test.mts` asserts the action uses `dpkg -i` on
  the cached paths, never passes `.deb` paths to `apt-get install`, and checks
  `dpkg-query` status after the fallback.
- To find steps like this, list per-step durations for every shard across
  recent runs (`gh run view <id> --json jobs`, then `.steps[]` with
  `startedAt`/`completedAt`). A step that is fast in most shards and slow in
  one is waiting on something outside the runner, usually the network.

## Related Issues

- [ci-runners-are-cpu-bound-shard-before-parallel-steps.md](ci-runners-are-cpu-bound-shard-before-parallel-steps.md):
  introduced the font cache and the narrowed font list.
- PR #9554
