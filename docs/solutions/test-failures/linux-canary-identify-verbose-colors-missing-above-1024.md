---
title: "Linux desktop canary exited 1 after every check passed: identify -verbose omits Colors: above 1024 colors"
date: 2026-11-02
category: test-failures
module: desktop-canary-linux
problem_type: test_failure
component: tooling
symptoms:
  - "Desktop Canary (Linux) Smoke-test AppImage step ends with 'Process completed with exit code 1' right after the sidecar ✅ lines"
  - "No ❌ message and no 'Screenshot unique colors' line is printed before the exit"
  - "The uploaded linux-smoke-test-screenshot artifact shows a fully rendered dashboard"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags: [desktop-canary, imagemagick, identify, pipefail, github-actions, appimage, screenshot-gate]
---

# Linux desktop canary exited 1 after every check passed: identify -verbose omits Colors: above 1024 colors

## Problem

The scheduled Desktop Canary (Linux) (`.github/workflows/test-linux-app.yml`) failed on 2026-10-29 and 2026-11-02. The app was healthy. The blank-render gate's color count crashed the step before the gate ran.

## Symptoms

- The step printed `✅ AppImage launched successfully`, `✅ Sidecar became ready`, and `✅ Sidecar remained alive`, then `##[error]Process completed with exit code 1.`
- None of the gate's own messages (`❌ No screenshot captured`, `Screenshot unique colors: …`, `❌ Screenshot appears blank`) were printed.
- The screenshot artifact showed the full dashboard: header, tabs, and globe.

## What Didn't Work

- Reading the failed log for an error line. The only error is the generic exit-code line, because the failing command prints nothing.
- Comparing runner images. Both the green run (2026-10-26) and the red runs used `ubuntu-24.04` with the same ImageMagick package (`8:6.9.12.98+dfsg1-5.2build2`), so the tooling had not changed.

## Solution

Before:
```bash
COLORS=$(identify -verbose screenshot.png 2>/dev/null | grep "Colors:" | awk '{print $2}')
```
After (PR #10008):
```bash
COLORS=$(identify -format '%k' screenshot.png 2>/dev/null || echo 0)
```
`%k` always returns the unique-color count. If `identify` fails, `COLORS` becomes `0` and the existing `-le 5` check fails loudly, so the gate cannot pass silently.

## Why This Works

`identify -verbose` prints `Colors:` (and the histogram) only when the image passes ImageMagick's histogram check. In ImageMagick 6 that check passes only at 1024 unique colors or fewer. The threshold comes from the ImageMagick 6 source as recalled during this session. The data fits it: the green run reported 953 colors and printed the line, while the failing screenshot has 2600 colors and does not. The dashboard render grew past that limit. Then:

1. `grep "Colors:"` matched nothing and exited 1.
2. The step shell is `bash -e -o pipefail`, so the command substitution's pipeline failed and `-e` ended the script on the assignment line, with no output.

Diagnostic route that worked: download the screenshot artifact (`gh run download <id> -n linux-smoke-test-screenshot`) and look at it. A rendered dashboard puts the fault in the gate, not the app. To confirm, run `identify` in an `ubuntu:24.04` container on that file: `identify -verbose … | grep -c Colors` gives 0, and `identify -format %k` gives 2600. A `workflow_dispatch` run of the canary on the fix branch (run 41395676273, 2026-11-02) then passed with `Screenshot unique colors: 1923`.

## Prevention

- Under `set -eo pipefail`, `VAR=$(tool | grep pattern | …)` exits the script with no message when the pattern is absent. Gates that parse tool output must not depend on fields the tool prints conditionally. Ask the tool for the value directly (`-format`, `--json`, `--porcelain`), and give the substitution an explicit fallback that fails the gate, for example `|| echo 0`.
- When a step's last output is a ✅ line followed by a bare exit code, suspect the next command substitution before suspecting the product.

## Related Issues

- PR #10008: the fix, plus the `test-linux-app.yml` row in `ARCHITECTURE.md`.
- Issue #5902: the original installed-app canary.
