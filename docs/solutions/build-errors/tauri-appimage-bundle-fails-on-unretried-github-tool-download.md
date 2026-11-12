---
title: "Tauri AppImage bundle fails on one GitHub 504: the bundler downloads its tools without retry"
date: 2026-11-09
category: build-errors
module: desktop-canary-linux
problem_type: build_error
component: tooling
symptoms:
  - "Build Tauri app step ends with failed to bundle project `http status: 504` right after Downloading .../apprun-old/AppRun-x86_64"
  - "The Rust release build has already printed Finished release, so only the AppImage bundle step fails"
  - "tauri-action retryAttempts: 1 reruns tauri build and hits the same 504 about two minutes later"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: medium
tags: [tauri, appimage, linuxdeploy, github-actions, desktop-canary, retry, actions-cache, transient-5xx]
---

# Tauri AppImage bundle fails on one GitHub 504: the bundler downloads its tools without retry

## Problem

Desktop Canary (Linux) run 42567226797 failed in the Tauri bundle step. The bundler downloads five AppImage tools from GitHub on each fresh runner, and a GitHub-side 504 on the first download failed the build. The URLs returned 200 shortly afterwards, so the code was fine and the network was the single point of failure. The release Linux legs in `build-desktop.yml` had the same exposure.

## Symptoms

```
Downloading https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64
failed to bundle project `http status: 504`
##[error]Command "npm ["run","tauri","build"]" failed with exit code 1
```

The screenshot and log upload steps then warn "No files were found". That follows from the failed build and is not a second problem.

## What Didn't Work

- **tauri-action `retryAttempts: 1`** was already set. It reruns the whole `tauri build`, and the rerun failed on the same URL at 05:33:35, two minutes after the first attempt at 05:31:20. The outage lasted longer than one immediate retry.
- **Treating it as a one-off and rerunning the job.** That clears one red run but leaves every Linux build, including release builds, depending on GitHub release downloads succeeding at build time.

## Solution

The bundler skips every tool that already exists in its tool directory. See `prepare_tools` in the upstream tauri-apps/tauri repo, `crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs` at tag `tauri-cli-v2.10.1`: each tool is guarded by `if !path.exists() { download(...)? }`, with no retry. The tool directory is `dirs::cache_dir()/tauri`, which is `~/.cache/tauri` on the runner. Fill that directory before tauri-action runs (PR #10344):

1. `scripts/fetch-with-retry.sh <url> <dest>` downloads with backoff of 10/20/40/60/90/120 s, about six minutes in total. It retries no response (`000`), 408, 429, 5xx, and a transfer cut off after a 200. Any other 4xx fails at once. It writes to a `mktemp` file in the destination directory and `mv`s it into place only on success, so a partial file never sits at the path the bundler checks with `exists()`.
2. `scripts/prefetch-appimage-tools.sh <x86_64|aarch64>` fills `${XDG_CACHE_HOME:-~/.cache}/tauri` with the same five file names and URLs the bundler uses. A tool it can't fetch gets a warning and is left for the bundler to download itself, so prefetching is never worse than not prefetching (PR #10346; the first version in #10344 failed the build on a required tool).
3. Both workflows restore that directory with `actions/cache` and then run the prefetch, before tauri-action:

```yaml
- name: AppImage tool cache month
  id: appimage-tools-month
  run: echo "month=$(date -u +%Y-%m)" >> "$GITHUB_OUTPUT"

- name: Restore Tauri AppImage tools
  uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6
  with:
    path: ~/.cache/tauri
    key: tauri-appimage-tools-x86_64-${{ steps.appimage-tools-month.outputs.month }}-${{ hashFiles('scripts/prefetch-appimage-tools.sh') }}

- name: Prefetch Tauri AppImage tools
  run: bash scripts/prefetch-appimage-tools.sh x86_64
```

This is the x86_64 canary. The release workflow uses the same steps, but its Linux-ARM64 leg passes `aarch64` both in the cache key and to the prefetch script (`${{ matrix.label == 'Linux-ARM64' && 'aarch64' || 'x86_64' }}`). Hardcoding `x86_64` there would leave the ARM64 tools missing, and the bundler would download them itself, unretried.

The monthly key refreshes the tools served from moving `master`/`continuous` URLs instead of freezing them for as long as the twice-weekly canary keeps the cache alive.

The appimagetool download in `scripts/repack-linux-appimage.sh` was a bare `wget` with the same exposure. It now goes through `fetch-with-retry.sh`, ahead of its unchanged SHA-256 check.

## Why This Works

The failure was a missing retry inside a third-party tool, not an outage too long to survive. The bundler exposes exactly one seam, "skip if the file exists". Pre-filling the directory takes the bundler's unretried download off the critical path. The cache makes most runs need no network at all, and the retrying prefetch covers the cache-miss runs. Verified on a real runner: canary run 42577697084 on the PR branch fetched all five tools in the prefetch step, the bundle step printed no `Downloading` lines, and the post step saved the cache key.

## Prevention

- When a build tool downloads at build time, look for a "skip if present" seam (a cache directory, a `--tools-dir` flag, an env var) and fill it yourself with retries, rather than relying on retrying the whole command.
- A whole-step retry like `retryAttempts` that fires immediately does not survive an outage of more than a minute or two. Retries need backoff measured in minutes.
- Retry only failures that can change: no response, 408, 429, 5xx, cut-off transfers. Fail at once on other 4xx, or a removed asset costs minutes of pointless backoff.
- When `@tauri-apps/cli` is upgraded, recheck `prepare_tools` for renamed tools or changed URLs and update the prefetch script to match. A drifted tool does not fail the build: the prefetch warns that it was not prefetched (a 404 on a removed asset fails fast without backoff), and the bundler downloads the new name itself, unretried. That warning on a green run is the signal that the script needs updating. `tests/appimage-tool-prefetch.test.mjs` pins the expected file names, and `tests/ci-workflow-coverage.test.mts` pins the restore → prefetch → build order in both workflows.

## Related

- [Linux desktop canary exited 1 after every check passed](../test-failures/linux-canary-identify-verbose-colors-missing-above-1024.md): another Desktop Canary failure unrelated to the app itself.
- [curl failure sentinel doubled by echo fallback](../logic-errors/curl-failure-sentinel-doubled-by-echo-fallback.md): curl `-w '%{http_code}'` pitfalls in the same canary.
