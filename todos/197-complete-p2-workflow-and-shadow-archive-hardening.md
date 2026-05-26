---
status: complete
priority: p2
issue_id: 197
tags: [code-review, digest-dedup, phase-a, security, ci]
dependencies: []
---

# Nightly workflow + shadow-archive hardening

## Problem Statement

Security-sentinel flagged two hardening items in the new CI workflow + shadow-mode archive — both are defence-in-depth, not exploitable today, but should land before the Phase C flip that actually writes archives.

### 1. `.github/workflows/dedup-golden-pairs.yml:59` — unquoted heredoc
```yaml
BODY=$(cat <<EOF
...
$(tail -n 80 /tmp/golden-pair-output.txt ...)
...
EOF
)
```
The `EOF` delimiter is unquoted, so shell command substitutions inside the heredoc are expanded before `gh issue create` receives them. Today the fixture is repo-controlled, but the plan explicitly says "append real-wire examples" at calibration time — a crafted headline containing `$(...)` / backticks could run as the runner. Easy fix: quote the delimiter as `<<'EOF'`.

### 2. Shadow archive stores `normalizedTitles` alongside `storyIds` under a predictable key
`brief-dedup.mjs:170-180` writes `brief:dedup:shadow:v1:<ISO>:<8-char contentHash>`. ISO timestamps + cadence make the prefix enumerable; story IDs are safe hashes but `normalizedTitles` is plaintext wire. Per data classification titles are public, so there's no secret leak — but two hardening moves would make the archive more defensible:
- Drop `normalizedTitles` from the archive; have `shadow-sample.mjs` re-read from `story:track:v1:<hash>` at draw time.
- Document the `brief:dedup:shadow:v1:*` prefix in the Upstash access-controls runbook so future changes know it holds wire titles.

### 3. `shadow-sample.mjs:53` — no command allowlist on the Upstash helper
The helper accepts `(command, ...params)` with `encodeURIComponent` on each segment. Safe today because only the tool calls it with `SCAN`/`GET`. If a future caller passes user input into `params`, the percent-encoding still protects path structure — but a dangerous command (`FLUSHDB`, `DEL`) could land. Hard-allowlist the `command` to `['SCAN', 'GET', 'EXISTS']`.

## Findings
All three are reviewer-flagged defensive hardening. None affect the Phase A no-op ship path.

## Proposed Solutions

### Option 1 — minimum fix (recommended)
- Quote the heredoc delimiter in the workflow (1 char).
- Add command allowlist in `shadow-sample.mjs` (6 lines).
- Leave `normalizedTitles` in the archive; add a comment documenting the wire-text classification.

**Pros:** small, focused, safe; defers the bigger archive-shape change.
**Cons:** doesn't eliminate the wire-text enumeration concern, only documents it.
**Effort:** Small
**Risk:** Low

### Option 2 — full hardening
All three items above.

**Pros:** maximal defence.
**Cons:** archive-shape change touches `shadow-sample.mjs` (title lookup) and the orchestrator (drop field); slightly bigger diff.
**Effort:** Small-Medium
**Risk:** Low

### Option 3 — defer to Phase C
Ship Phase A as-is; harden before flipping to `shadow` mode.

**Pros:** zero Phase A churn.
**Cons:** the heredoc is a weak-positive attack surface; the workflow could run before Phase C if the manual `workflow_dispatch` is triggered.
**Effort:** zero now
**Risk:** Low-Medium

## Recommended Action
_To be filled during triage._

## Technical Details
- `.github/workflows/dedup-golden-pairs.yml:59`
- `scripts/lib/brief-dedup.mjs:170-180` (archive shape)
- `scripts/tools/shadow-sample.mjs:53` (command allowlist)

## Acceptance Criteria
- [ ] Heredoc delimiter is `<<'EOF'` (quoted).
- [ ] `shadow-sample.mjs`'s Upstash helper rejects any command not in a hardcoded allowlist.
- [ ] (Optional) Shadow archive no longer stores plaintext titles; sampler rehydrates from `story:track:v1:*`.

## Work Log
_Empty — awaiting triage._

## Resources
- Review commit: `cdd7a124c`
- Reviewer: security-sentinel
