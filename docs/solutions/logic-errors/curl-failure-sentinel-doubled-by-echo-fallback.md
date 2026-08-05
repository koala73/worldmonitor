---
title: "A curl -w failure sentinel got doubled by an || echo fallback, masking a dead sidecar as ready"
date: 2026-07-31
category: logic-errors
module: Desktop Canary sidecar readiness probe
problem_type: logic_error
component: testing_framework
symptoms:
  - "CODE evaluated to `000000` instead of `000` when curl failed to connect, because curl's `-w '%{http_code}'` already prints `000` on connection failure before `|| echo 000` appended a second sentinel"
  - "The `[ \"$CODE\" != \"000\" ]` readiness check passed on the doubled `000000` value, so the gate reported a dead/unreachable sidecar as ready"
  - "The Desktop Canary's sidecar-liveness gate could never fail, even when the bundled local API server never came up on 127.0.0.1:46123"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [curl, shell-fallback, readiness-probe, ci-canary, silent-pass-guard, vacuous-guard, mutation-testing, sentinel-duplication]
---

# A curl -w failure sentinel got doubled by an || echo fallback, masking a dead sidecar as ready

## Problem

`.github/workflows/test-linux-app.yml` runs a scheduled "Desktop Canary
(Linux)" job (PR #5915, part of epic #5902) that builds the packaged Tauri
desktop app and asserts, against a real launched instance, that its local
sidecar (the bundled Node API server on `127.0.0.1:46123`) answers HTTP
requests and that the rendered window is non-blank. The sidecar check polls
the endpoint in a loop and captures the HTTP status via
`curl -s -o /dev/null -w '%{http_code}'`. As originally written on the PR
branch, the capture line was:

```bash
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
  "http://127.0.0.1:46123/api/local-traffic-log" || echo 000)
if [ "$CODE" != "000" ]; then
  SIDECAR_STATUS=ready
fi
```

The intent was standard defensive shell: "if curl fails outright, fall back
to a `000` sentinel so the readiness check has something to compare
against." That intent is exactly backwards for this particular curl
invocation: the fallback made the gate permanently unable to fire — a dead
sidecar would have been reported as ready on every scheduled run. The probe
was introduced and caught within the same PR (#5915), so the defect never
reached a live CI run.

## Symptoms

- The sidecar readiness gate (`SIDECAR_STATUS=ready` vs `unreachable`)
  could not distinguish a live sidecar from a completely dead one — a
  closed port on 46123 still drove the loop into the `ready` branch.
- Invisible from a healthy run: with a live sidecar the comparison takes
  the `ready` branch for a real 3-digit status code, so nothing looks
  wrong. The defect only surfaces when probed against a dead port, or when
  the shell semantics are traced closely.
- The failure mode is the specific one this canary was built to catch — a
  rendered shell with a dead sidecar (see the hard-gate comment in
  `.github/workflows/test-linux-app.yml`). A canary that cannot fail on its
  own target defect provides zero signal while looking fully instrumented.

## What Didn't Work

Reading the line in isolation looks correct: `curl ... || echo 000` reads
as "produce `000` if curl fails," and `[ "$CODE" != "000" ]` reads as "not
`000` means it responded." Nothing about `|| echo 000` is malformed shell —
each half is individually idiomatic. The defect is only visible by tracing
what `curl -w '%{http_code}'` actually writes to stdout on a connection
failure, not by reading the conditional.

The bug was **not** caught by:

- Running the workflow (the probe never ran in CI before review; and in any
  environment with a live sidecar the buggy comparison still looks right).
- A syntax or lint pass over the shell block (the script is syntactically
  fine; the defect is semantic, in what two commands print in combination).

It **was** caught by review — by three independent reviewers converging on
the identical line before merge: a correctness-focused pass, an in-process
adversarial pass, and a separately-trained cross-model (Codex) adversarial
pass. The cross-model agreement, with no shared context between reviewers,
was the strongest signal the finding was real.

## Solution

Fixed on PR #5915 by dropping the `|| echo 000` fallback entirely, since
`curl -w '%{http_code}'` already emits `000` on its own when the connection
fails — the fallback was concatenating a second, redundant sentinel onto
output curl had already produced:

```bash
# NOTE: no `|| echo 000` fallback on the curl — curl already prints
# 000 via -w on connection failure, and appending a second sentinel
# would make CODE "000000", which passes the != "000" check and
# reports a dead sidecar as ready.
SIDECAR_STATUS=unreachable
for i in $(seq 1 12); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
    "http://127.0.0.1:46123/api/local-traffic-log")
  if [ "$CODE" != "000" ]; then
    SIDECAR_STATUS=ready
    echo "sidecar responded with HTTP $CODE on attempt $i"
    break
  fi
  sleep 5
done
```

The `NOTE` comment sits directly above the probe
(`.github/workflows/test-linux-app.yml:125-128` as of PR #5915) so a future
edit doesn't reintroduce the same "defensive" fallback for the same reason
it was added the first time.

Empirical repro, runnable standalone against any closed local port:

```bash
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:1/x" || echo 000); echo "[$CODE]"
# buggy form -> [000000]  (the [ "$CODE" != "000" ] gate would report "ready")
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:1/x"); echo "[$CODE]"
# fixed form  -> [000]    (correctly compares equal to "000", gate reports "unreachable")
```

Both forms were run during the session: the buggy form printed `[000000]`
("WOULD REPORT READY"), the fixed form printed `[000]` and was correctly
classified unreachable.

## Why This Works

`curl -w '%{http_code}'` is not silent on connection failure — it still
writes the format string to stdout, substituting `000` for the status code,
and it also exits non-zero. Both halves of `$(cmd || fallback)` therefore
fire on that failure path: curl prints `000` to the command-substitution's
stdout, *and* its non-zero exit trips the `||`, which prints a second `000`
right after it. Command substitution captures everything written to stdout
in the subshell, so the captured value is the literal string `000000` — and
`[ "000000" != "000" ]` is true, taking the branch reserved for a real
status code even though nothing answered.

Removing the fallback fixes it because curl's own `000` sentinel is already
the complete, correct signal for "no response" on this invocation. The
general shape: `$(cmd ... || echo <sentinel>)` is safe only when `cmd` is
silent on that failure path. The moment the command's own failure path
already writes to stdout, an `||`-appended echo doesn't replace that
output — it concatenates onto it, and every subsequent string comparison
against the bare sentinel silently stops working, without a syntax error or
visible failure anywhere in the diff.

## Prevention

1. **Never add `|| echo <sentinel>` inside a command substitution without
   first checking what the command already prints on that exact failure
   path.** If the command emits its own sentinel on failure — `curl -w` is
   the canonical case, but any tool with an "always print a status/format
   string" flag has the same shape — the fallback concatenates with it
   instead of replacing it. The two safe alternatives: rely on the
   command's own sentinel and drop the fallback (what was done here), or
   branch on the exit code directly (`if CODE=$(curl ...); then`). Never
   combine an output-sentinel approach with an appended-fallback approach
   on the same call.

2. **Mutation-test every detection layer before trusting it — reading a
   guard only tells you what it intends, not what it catches.** This is a
   fifth mechanism for the repo's *Vacuous Guard* concept: the guard's
   comparison value itself gets corrupted (two failure sentinels
   concatenating), rather than its input shrinking to nothing. The
   discipline in
   `docs/solutions/conventions/verify-the-verifier-mutation-test-every-detection-layer.md`
   is what proves such a guard: deliberately break the exact thing it
   exists to catch and watch it turn red. In this session that was applied
   to the fixed probe (dead port → red) and to the sibling detection layers
   in the same PR — corrupt capability JSON → config-parse gate red,
   deleted handler bundle → bundle assertion red, fixture logs through each
   canary check branch → each red.

3. **Weight cross-model / cross-persona review convergence.** Three
   independent reviewers landing on one line, with no shared context, is
   evidence the finding is real that is distinct from any single reviewer's
   confidence — use that convergence to prioritize which findings to act on
   first.

## Related Issues

- PR #5915 — introduced the canary hardening and the fix (epic #5902 §4,
  drift prevention)
- `docs/solutions/conventions/verify-the-verifier-mutation-test-every-detection-layer.md`
  — the mutation-proof convention this doc's Prevention #2 applies (same
  meta-rule, different mechanism; cross-referenced, not merged)
- `docs/solutions/best-practices/checks-must-fail-closed-when-they-lose-their-target.md`
  — the fail-loud direction the canary's warn→hard-fail conversion follows
- `CONCEPTS.md` — Vacuous Guard, Mutation Proof, Surviving Mutant
