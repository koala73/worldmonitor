---
status: complete
priority: p2
issue_id: 177
tags: [code-review, phase-0, regional-intelligence, security, xss]
dependencies: []
---

# Snapshot string fields interpolate upstream Redis data without sanitization (Phase 1 stored XSS risk)

## Problem Statement

`scripts/regional-snapshot/evidence-collector.mjs:31, 51, 70, 90` and `balance-vector.mjs:150` build free-form description strings by interpolating upstream Redis fields directly:

- `String(s?.summary ?? s?.type)` from cross-source signals.
- `` `${c.region} CII ... (trend ${c.trend})` `` from CII scores.
- `` `${cp?.name ?? cp?.id}: ${threat}` `` from chokepoints.
- `String(f?.title)` from forecasts.
- `` `${top.iso} CII ${...}` `` from balance drivers.

These strings are `JSON.stringify`'d into the snapshot, persisted to Redis, then read back in Phase 1 by a new UI consumer. If any upstream seeder has a validation gap (or accepts a hostile third-party feed), a string like `<img src=x onerror=alert(1)>` propagates through to stored XSS at render time.

Existing panels (SignalModal, StrategicRiskPanel, CrossSourceSignalsPanel) DO escape via `escapeHtml` when rendering. So if Phase 1 follows convention, this is fine. But the writer provides no guard rail.

## Findings

- `scripts/regional-snapshot/evidence-collector.mjs:27-97` — interpolates upstream strings without sanitization.
- `scripts/regional-snapshot/balance-vector.mjs:96-109, 144-155, 195-203, 232-243, 261-276, 310-319, 334-343` — builds driver description strings from upstream fields.

## Proposed Solutions

### Option 1: sanitizeEvidenceString helper at writer boundary

Add a `sanitizeEvidenceString()` helper. Strip `<>`, collapse whitespace, cap length to ~200 chars. Apply to every interpolated upstream field.

**Pros:** Defense in depth; doesn't rely on Phase 1 convention; handles future Phase 2 consumers; bounded payload size.
**Cons:** May clip legitimate punctuation edge cases (unlikely given the field shapes).
**Effort:** Small.
**Risk:** Low.

### Option 2: Document Phase 1 requirement

Add a spec checklist item: every renderer of snapshot string fields MUST use `escapeHtml`.

**Pros:** Zero code change.
**Cons:** Relies entirely on convention; every new Phase 1/2 consumer is an opportunity to forget.
**Effort:** Small.
**Risk:** Medium.

## Recommended Action

Both. Option 1 is cheap and gives defense in depth at the writer boundary. Option 2 ensures the rendering convention holds so double-sanitization doesn't create escape artifacts.

## Technical Details

Writer-side sanitization complements render-side escaping. The goal at the writer is:
1. Strip structural HTML markers (`<`, `>`) that serve no legitimate purpose in these description fields.
2. Collapse runs of whitespace to prevent layout-breaking inputs.
3. Cap length to a reasonable bound (~200 chars) to contain payload-size attacks.

Render-side `escapeHtml` remains the primary defense. The writer guard is the backstop for any panel that forgets.

Existing convention: `SignalModal`, `StrategicRiskPanel`, `CrossSourceSignalsPanel` all use `escapeHtml` from `src/utils/escape.ts`.

## Acceptance Criteria

- [ ] `sanitizeEvidenceString` helper exists and is applied to every upstream string field in the snapshot.
- [ ] Phase 1 checklist in the spec explicitly requires `escapeHtml` on snapshot string fields.
- [ ] Test: snapshot containing `<script>alert(1)</script>` in a CII region name produces a stripped/escaped string.
- [ ] Test: 10KB input is truncated to ≤200 chars.

## Work Log

- 2026-05-18: Closed via PR for issue #3730. Implemented defense-in-depth:
  - **Writer side:** Added `scripts/regional-snapshot/_sanitize.mjs` exporting
    `sanitizeEvidenceString(value, opts?)` that strips `<>`, NUL bytes,
    zero-width characters, collapses whitespace, trims, and caps length
    (default 500). Applied to every upstream-string interpolation in
    `scripts/regional-snapshot/evidence-collector.mjs` (xss summary/id/theater,
    chokepoint name/threat, cii region/trend, forecast title/id) and
    `scripts/regional-snapshot/balance-vector.mjs` (xss evidence ids, cii top
    iso, macro verdict, stress label, maritime threat level).
  - **Render side:** Added `tests/regional-snapshot-render-escape-guard.test.mjs`
    — a text-scanning test that parses
    `src/components/regional-intelligence-board-utils.ts` and asserts every
    `${...}` interpolation referencing a suspect upstream field is wrapped in
    `escapeHtml(...)`. Also forbids direct `innerHTML`/`outerHTML` assignment.
  - **Tests:** `tests/regional-snapshot-sanitize.test.mjs` covers the
    sanitizer; `tests/regional-snapshot.test.mjs` now has a "writer-side XSS
    hardening (issue #3730)" suite that runs hostile inputs end-to-end
    through `collectEvidence` + `computeBalanceVector`;
    `tests/regional-intelligence-board.test.mts` got an additional case that
    feeds `<script>` payloads through narrative + transmission + trigger
    fields and asserts the rendered HTML escapes them.
  - **Why strip-not-escape on write:** the renderer already HTML-escapes
    every snapshot string interpolation, so writing escaped entities at the
    seam would cause double-escaping (`&amp;lt;`). Stripping the structural
    markers `<>` instead is null-safe with the render layer and also bounds
    persisted payload size.

## Resources

- PR #2940
- Spec: `docs/internal/pro-regional-intelligence-upgrade.md`
