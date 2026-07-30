---
title: "fix(brief): persist category on story:track:v1 so threads card stops showing 8/8 General"
type: fix
status: active
date: 2026-05-17
---

# fix(brief): persist category on story:track:v1 so threads card stops showing 8/8 General

**Target repo:** `worldmonitor` (`/Users/eliehabib/Documents/GitHub/worldmonitor`). All paths in this plan are relative to that repo.

**Depends on:** PR #3748 (`feelgood-classifier`, merged 2026-05-17 as `2a5bf8436`) and PR #3750 (`opinion-classifier` pathname backport, merged 2026-05-17 as `8dc087bb1`). Both are on `origin/main`. The line numbers and patterns this plan cites are anchored to that post-#3748+#3750 tree.

## Overview

The May 17 0802 brief shipped a threads card where **all 8 entries were tagged `General`** — `[ 0] General — WHO Ebola declaration… [ 1] General — Kabuga dies… [ 2] General — Israeli airstrikes…` etc. The categories are not actually general; they're conflict, health, diplomatic, crime. The display is wrong because the value the display reads is missing from persistence.

`parseRssXml` at `server/worldmonitor/news/v1/list-feed-digest.ts` (the line in `parseRssXml` that does `category: threat.category` inside the `items.push`) already stamps `item.category` from `classifyByKeyword` (whose return type `EventCategory` enumerates 14 meaningful values: `conflict | protest | disaster | diplomatic | economic | terrorism | cyber | health | environmental | military | crime | infrastructure | tech | general`). But `buildStoryTrackHsetFields` writes only 9 fields to `story:track:v1` (`title | link | severity | lang | description | publishedAt | isOpinion | lastSeen | currentScore`) — **category is computed at ingest, used briefly, and then discarded** before the row hits Redis. PR #3748 just added `isFeelGood` to that list, confirming the persistence pattern is the right surface to extend.

By the time `buildDigest` reads the row back and `filterTopStories` (`shared/brief-filter.js:365`) does `asTrimmedString(raw.category) || 'General'`, there's nothing to read — `'General'` is what survives, every time.

The fix is pure plumbing: persist the field already being computed, propagate it through `buildDigest`, and **capitalize once in `shared/brief-filter.js`** at the envelope-build site so the threads card AND story pages AND public-thread stubs all show `Conflict` / `Health` / `Diplomatic` instead of `conflict` / `health` / `diplomatic` (the enum is canonical lowercase). The single normalization site is load-bearing because `category` flows from the envelope to three downstream consumers: the brief composer's threads card (`scripts/lib/brief-compose.mjs:812`), every magazine story page (`server/_shared/brief-render.js:653`), and the public-thread fallback stub (`server/_shared/brief-render.js:1296-1302`). Fixing only one site would create case-inconsistency across surfaces. PR #3697 made this latent gap visible — pre-PR-#3697, the LLM categorized threads independently inside the composer, so the missing `category` field was invisible. This plan closes the gap PR #3697 exposed.

---

## Problem Frame

The brief's threads card consumes the upstream `category` value as its display tag. PR #3697 was correct to plumb `digest.threads[].category` from the envelope's per-story `category`. The failure mode is upstream: every story arrives at the composer without a category, so the consumer (PR #3697's display) sees the `'General'` default for everything.

This is editorially visible: a reader scanning the threads card learns nothing about the brief's coverage shape ("8 General stories" = no signal), versus the intended "3 conflict, 1 health, 1 diplomatic, 1 crime, 2 general" mix that would communicate the brief's actual mix at a glance.

The classifier (`server/worldmonitor/news/v1/_classifier.ts`) is already producing meaningful categories — `classifyByKeyword` returns one of 14 `EventCategory` values for every story. The bug is strictly the missing HSET field. No new classifier, no taxonomy decision, no model change.

---

## Requirements Trace

- **R1.** `buildStoryTrackHsetFields` (`server/worldmonitor/news/v1/list-feed-digest.ts`, function declaration around `:893`; the existing field-write block is the site to extend) MUST persist `'category', <stringified category>` on every `story:track:v1` HSET write. New rows written from now on carry the field.
- **R2.** `category` MUST be written as a defensively-stringified value: `typeof item.category === 'string' ? item.category : ''`. Missing/non-string upstream values produce `''`, never the literal `'undefined'`, mirroring how `publishedAt` and `description` already defend their HSET writes.
- **R3.** `buildDigest` (`scripts/seed-digest-notifications.mjs`) MUST read `track.category` (defensively typed: `typeof track.category === 'string' ? track.category : ''`) and pass it onto the `stories.push({...})` object alongside `title`, `link`, `severity`, `currentScore`, etc. — so the value reaches `filterTopStories` and the composer's tag-derivation site.
- **R4.** `shared/brief-filter.js` MUST capitalize the category value **once** in `filterTopStories`'s `out.push({...})` site so every downstream consumer (threads card, story pages, public-thread stubs) sees the same Title-Case form. The source/category cap inside `filterTopStories` MUST continue to operate on the canonical lowercase value for grouping correctness (`'conflict' === 'conflict'`); only the emitted envelope value is capitalized. The `'General'` fallback from line 365 is already capitalized; the classifier output is canonically lowercase; this single boundary normalizes display while keeping storage and cap-keying canonical.
- **R5.** Pre-PR `story:track:v1` rows that have no `category` field MUST gracefully degrade to the existing `'General'` default via `filterTopStories:365`'s existing `|| 'General'` fallback. No read-time re-classifier needed because (a) the default behavior is identical to today's (everything → General — no regression from current state), and (b) ingest-time `category` can be AI-adjusted via `enrichWithAiCache` (`server/worldmonitor/news/v1/list-feed-digest.ts:678,725`); a read-time fallback running `classifyByKeyword(track.title, variant)` would lose those AI-side adjustments. Persistence captures the AI-adjusted verdict; residue catch would silently downgrade it back to a keyword-only verdict. **Rollout-window honesty:** `buildDigest` reads `ZRANGEBYSCORE(accKey, windowStartMs, now)` (`scripts/seed-digest-notifications.mjs:463`) where `windowStartMs` is per-rule — daily users have a 24h window, weekly users have a 7d window (`tests/digest-orchestration-helpers.test.mjs:302,485,546`). The accumulator only has a whole-key `EXPIRE` at `DIGEST_ACCUMULATOR_TTL = 48h` (`server/_shared/cache-keys.ts:44`), no member-level pruning, so the residue window is bounded by the per-rule window AND the row's own `STORY_TTL = 604800s = 7d` (`:43`). Concretely: daily users see residue for up to ~24-48h; weekly users see residue for up to ~7 days (whichever is smaller of their weekly window and `STORY_TTL`). Fresh ingests overwrite the same `story:track:v1` hash key (collapsed by normalised-title), so the practical residue duration trends down as fresh mentions arrive. The ~7d weekly-user bleed is acceptable because (a) it's transient, (b) the user experience is identical to today's (8/8 General threads tags), and (c) a one-off backfill script or read-time residue catch would cost operational complexity disproportionate to a cosmetic gap that resolves itself within a week of deploy.

---

## Scope Boundaries

- **Out of scope: changing `EventCategory`.** The 14 canonical values produced by `classifyByKeyword` are the taxonomy. This plan does not add, remove, rename, or merge categories. If the threads-card display proves visually noisy with too many distinct tags, that's a future product decision — fix the rendering, don't re-cut the enum.
- **Out of scope: a read-time re-classifier in `buildDigest`.** Unlike `isOpinion` / `isFeelGood` (where missing = potential silent shipping of editorially-unfit content), missing `category` = `'General'` display = identical to today's behavior. Residue duration is bounded by the per-rule digest window (daily ~24-48h, weekly up to 7d) AND `STORY_TTL = 7d` on the row itself (`server/_shared/cache-keys.ts:43`); see R5 for the full mechanics. More importantly, a read-time `classifyByKeyword(track.title, variant)` would lose ingest-time AI adjustments (`enrichWithAiCache` at `list-feed-digest.ts:678,725` can override the keyword verdict), silently downgrading rows to keyword-only categorization. The temporary residue gap (up to ~7d for weekly users) is acceptable; the silent AI-verdict loss would not be.
- **Out of scope: a one-off backfill script** that scans existing `story:track:v1` keys and writes `category: 'general'` to those missing it. Would shorten the rollout window to instant but adds operational complexity (script authorship + run + verify) disproportionate to closing a transient cosmetic gap that already resolves itself within 7d of natural overwrites. Considered + rejected on cost-benefit.
- **Out of scope: rss:feed cache prefix bump.** `parseRssXml` has been stamping `item.category` for a long time — pre-PR cached `ParseResult` objects already carry the field. The only sites that change are the HSET write and the composer read; neither caches structurally on category. (Contrast with #3748's v3→v4 bump, which was needed because the cached items themselves lacked the new `isFeelGood` field.)
- **Out of scope: ranker / scoring changes.** Category is consumed only by display (`brief-compose.mjs:812` tag) and `filterTopStories`' per-source/category cap (which already runs against whatever value is present, defaulting to 'General'). No score field or ordering logic changes.
- **Out of scope: editorial decisions about how the threads card lays out** (e.g., grouping by category, showing category counts in a header). Plan ships the per-thread tag fix only. Future product decisions about threads-card composition build on top of this.
- **Out of scope: backporting the `safePathname` injection-vector fix to opinion-classifier.** Already shipped as PR #3750.

---

## Context & Research

### Relevant Code and Patterns

This is a direct sibling fix to PR #3748's `isFeelGood` persistence pattern. All four sites mirror PR #3748 + PR #3690 exactly:

- `server/worldmonitor/news/v1/list-feed-digest.ts` (the line in `parseRssXml` that does `category: threat.category` inside the `items.push`) — `parseRssXml` already does `category: threat.category` from `classifyByKeyword`. No change needed; the value is being computed correctly.
- `server/worldmonitor/news/v1/list-feed-digest.ts` `ParsedItem` type (around `:145`) — already declares `category: string`. No change needed.
- `server/worldmonitor/news/v1/list-feed-digest.ts:~911` (`buildStoryTrackHsetFields`) — currently persists 9 fields (post-#3748: 10 with `isFeelGood`). Add `'category', <stringified value>` as a sibling.
- `scripts/seed-digest-notifications.mjs` (`buildDigest`, around the `stories.push` site post-`isOpinion`/`isFeelGood` filter blocks) — currently passes `title | link | severity | currentScore | mentionCount | phase | sources | description`. Add `category` to that object.
- `shared/brief-filter.js:365-416` — the envelope-build site. Line 365 already reads `raw.category` with the `|| 'General'` fallback (allows graceful degradation for pre-PR rows per R5). The source/category cap (~lines 376, 415) keys on this canonical lowercase value — leave it untouched. The `out.push({...})` site (~line 415) is where the emitted envelope `category` value should be Title-Cased so every downstream consumer sees one normalized form.
- `scripts/lib/brief-compose.mjs:812` — the threads-card tag-derivation site. Will receive the already-capitalized envelope value once R4 lands. **Three stale comment sites in the same file** that document the digest shape as not carrying category become wrong post-U2 — update or remove all three: `:543` (the `digestStoryToSynthesisShape` JSDoc says `'category' / 'country' default to 'General' / 'Global' ... because story:track:v1 carries neither field` — half of that becomes obsolete), `:585-586`, and `:625-627`.
- `server/_shared/brief-render.js:653` — magazine story-page render of `story.category`. Already HTML-escaped (`:565,653`); no security concern. Becomes consistent with threads card once R4 lands (currently would display lowercase 'conflict' if data flowed; today it always shows 'General' default).
- `server/_shared/brief-render.js:1296-1302` — public-thread fallback stub. Same data source; same one-place-fix benefit.
- `server/_shared/cache-keys.ts:21` — comment block documenting `story:track:v1` HSET fields. Omits `category` today; add it as part of U1's documentation fidelity.

### Institutional Learnings

- **PR #3748 (`feelgood-classifier`, merged 2026-05-17 as `2a5bf8436`).** Exact sibling pattern. Demonstrated that the `buildStoryTrackHsetFields` + buildDigest read + composer pass-through plumbing is well-trodden — no architectural risk in this PR.
- **PR #3690 (`opinion-classifier`).** Original precedent for adding a new field to `story:track:v1`. Same shape.
- **PR #3697 (threads-from-walk, merged 2026-05-15).** The PR that exposed the latent gap by reading `digest.threads[].category` for display. This plan does not change PR #3697's logic; it makes the value PR #3697 was trying to read actually exist.
- **My own May 17 brief analysis** (in-session, pasted by user 2026-05-17): named both fixes — (a) "fix the ingest classifier so story:track:v1 rows carry meaningful category values (proper fix; biggest win)" and (b) cosmetic country-name fallback. User picked (a). This plan implements (a).
- **Why no residue catch / cache bump (contrast with #3748):** documented in Scope Boundaries above. The asymmetry is intentional and recorded so a future reader doesn't pattern-match-and-add unnecessary defensive plumbing.

### External References

- None. Pattern is fully internal — PR #3748 is the template.

---

## Key Technical Decisions

- **Mirror PR #3748's sibling-field pattern exactly.** One HSET field added to `buildStoryTrackHsetFields`, one passthrough in `buildDigest`, one capitalization at the display boundary. No new shared module, no new classifier.
- **Storage is canonical lowercase.** `EventCategory` outputs lowercase (`conflict`, `health`, …). Persistence stores those values verbatim. Display capitalizes. This keeps storage canonical and avoids ambiguity in any future consumer that filters/groups by category (`'conflict' === 'conflict'` is unambiguous; `'Conflict' vs 'conflict'` is a footgun).
- **Defensive stringification on write AND read.** Mirror how `description` and `publishedAt` defend themselves: `typeof item.category === 'string' ? item.category : ''` on write; `typeof track.category === 'string' ? track.category : ''` on read. The empty-string falls through `filterTopStories:365`'s `|| 'General'` and matches today's behavior — no consumer break.
- **No read-time re-classifier in `buildDigest`.** Unlike `isOpinion` / `isFeelGood`, missing category = today's default behavior (`'General'`), not silent shipping of unfit content. Residue duration: daily users ~24-48h, weekly users up to ~7d (buildDigest reads `ZRANGEBYSCORE(accKey, windowStartMs, now)` with `windowStartMs` per-rule, not per-accumulator; the accumulator only does whole-key `EXPIRE` at 48h). Re-running `classifyByKeyword(track.title, variant)` at read time is technically feasible (it only needs `(title, variant)` per `_classifier.ts:346`) but would lose ingest-time AI-adjusted categories from `enrichWithAiCache` (`list-feed-digest.ts:678,725`). Choosing persistence + accept-up-to-7d-cosmetic-degradation captures the AI verdict; residue catch would silently overwrite it with keyword-only output.
- **No rss:feed cache prefix bump.** `parseRssXml` has been stamping `item.category` for a long time — pre-PR cached `ParseResult` objects already carry the field. Only the HSET write site is new; cached items flow through unchanged. (Contrast: #3748 needed v3→v4 because the cached items themselves lacked `isFeelGood`.)
- **Capitalize once at the envelope build site, NOT at any display surface.** Helper: word-wise title-case (`s.replace(/\b[a-z]/g, c => c.toUpperCase())`) applied once inside `filterTopStories`' `out.push({...})` (`shared/brief-filter.js:~415`). All three downstream consumers (threads card, story pages, public-thread stubs) see the same Title-Case value; case consistency is structurally guaranteed by the single normalization site. **Word-wise (not first-letter-only):** `filterTopStories` is shared with `composeBriefForRule` callers that pass multi-word categories like `'world politics'` (documented at `:294-300`); first-letter-only would corrupt those. The source/category cap inside `filterTopStories` (~line 376) keys on the canonical raw value — leave it untouched so the cap continues to group correctly.
- **Stamp name `category` (camelCase string → string on Redis).** Matches existing convention (`description`, `lang`, `severity`, `lastSeen`). No schema bump; HSET fields are open.

---

## Open Questions

### Resolved During Planning

- **New classifier needed?** No. `classifyByKeyword` already produces all 14 `EventCategory` values; the bug is strictly persistence.
- **Residue catch needed?** No (see KTD + R5). Daily users see residue for ~24-48h; weekly users for up to ~7d (per-rule digest window, bounded by `STORY_TTL = 7d`). Missing = `'General'` display = today's behavior; the bleed is transient + cosmetic; alternatives (read-time re-classifier loses AI-verdict adjustments, one-off backfill adds operational complexity) cost more than the gap.
- **Cache prefix bump needed?** No (see KTD). Pre-PR cached `ParseResult` items already carry `category`.
- **Capitalize at storage or display?** Display. Keeps storage canonical; one normalization site.
- **Should category-cap behavior in `filterTopStories` change?** No. That cap already runs against whatever value is present; defaulting to 'General' continues to work for residue rows. Once the persistence is fixed, the cap operates against meaningful values (which is more useful for source/category diversity), but the cap logic itself is unchanged.

### Deferred to Implementation

- **Exact helper name for the display capitalization.** Word-wise title-case via inline expression (`s.replace(/\b[a-z]/g, c => c.toUpperCase())`) vs a tiny `titleCase()` helper — implementer's call. Either is fine **as long as the helper is word-wise** (first-letter-only would corrupt multi-word categories — see U3 Approach for rationale).
- **Whether the threads-card tag needs additional cosmetic treatment** (e.g., font case, badge color per category). Out of this PR; layout is in the rendering layer.

---

## Implementation Units

- [ ] U1. **Persist `category` on `story:track:v1` via `buildStoryTrackHsetFields`**

**Goal:** Every `story:track:v1` HSET write carries a `category` field stringified defensively from `item.category`. Pre-existing rows without the field remain valid; the consumer (composer + filterTopStories) gracefully degrades to `'General'`.

**Requirements:** R1, R2.

**Dependencies:** None — leaf change.

**Files:**
- Modify: `server/worldmonitor/news/v1/list-feed-digest.ts` — add `'category', <defensive expression>` to `buildStoryTrackHsetFields`'s returned array.
- Modify: `server/_shared/cache-keys.ts` — three fixes in the same block (`:14-26`) + one constant removal:
  1. Add `category` to the documented HSET field list for `story:track:v1` (sibling to `description` / `isOpinion` / `isFeelGood`).
  2. **Correct the stale TTL claim** at `:14` ("TTL for all story tracking keys (48 hours)") and `:26` ("TTL for all: 172800s (48h)"). The actual story:track:v1 row uses `STORY_TTL = 604800` (7d) at `:43`; only the accumulator (`DIGEST_ACCUMULATOR_TTL = 172800` at `:44`) is 48h.
  3. **Remove the dead export `STORY_TRACKING_TTL_S = 172800`** at `:15`. Repo-wide grep confirms it has zero call sites — leaving it in keeps advertising "48h story tracking TTL" right above the actual split TTLs and is exactly what drove the round-1 misreading. Since the whole point of this scope expansion is to stop future readers from repeating the same mistake, remove the dead constant rather than just patching the prose around it.
- Test: `tests/news-story-track-description-persistence.test.mts` — the same file that already covers `isOpinion` / `isFeelGood` HSET persistence. Add a `category` assertion block mirroring those. **NB:** the `baseItem` fixture already has `category: 'world'` at `:29` — that value is NOT in the `EventCategory` enum (`conflict | protest | … | tech | general`); change it to `'general'` to make the fixture type-honest and to align with U1's T2 expectation.

**Approach:**
- Sibling to the `isOpinion` / `isFeelGood` lines at the bottom of `buildStoryTrackHsetFields`. Use a defensive expression: `typeof item.category === 'string' ? item.category : ''`. Add an inline comment matching the style of the existing `isOpinion` block: explains the empty-string fallback's interaction with `filterTopStories:365`'s `'General'` default.
- Change the existing `category: 'world'` in the `baseItem(overrides)` fixture to `category: 'general'` (mirroring the canonical EventCategory enum). This corrects an existing type-honesty issue while keeping neighboring tests valid.
- Update the `cache-keys.ts:14-26` HSET-fields comment block: (a) list `category` alongside `description`/`isOpinion`/`isFeelGood`, (b) correct the "TTL for all: 48h" lines to reflect the actual split (`STORY_TTL = 7d` for the story:track row, `DIGEST_ACCUMULATOR_TTL = 48h` for the accumulator only), (c) remove the dead `STORY_TRACKING_TTL_S = 172800` export at `:15` (zero call sites). Pure doc + dead-code removal; no behavior change.

**Patterns to follow:**
- The `isFeelGood` HSET line added by PR #3748 — same shape, same defensive intent, same inline-comment style.
- The existing `description` HSET line — same defensive `typeof` shape (since description is also a string field that may be missing).

**Test scenarios:**

*Happy path — value persists:*
- T1. *Happy path:* `buildStoryTrackHsetFields(baseItem({ category: 'conflict' }), ...)` includes `'category', 'conflict'` in the returned array. Sibling: `'health'` → `'health'`, `'tech'` → `'tech'`.

*Defensive — missing / non-string upstream value:*
- T2. *Edge case:* `baseItem()` with no override (relies on fixture default `'general'`) → output includes `'category', 'general'`.
- T3. *Edge case:* `baseItem({ category: undefined })` (explicit) → output includes `'category', ''`. (Defensive default; downstream `filterTopStories` will treat empty as `'General'`.)
- T4. *Edge case:* `baseItem({ category: 42 })` (non-string) → output includes `'category', ''`. Defensive guard; no literal `'42'` or `'undefined'` reaches Redis.

*Backward-compat — existing test fixture update:*
- T5. *No-regression:* `baseItem` fixture default of `category: 'general'` does not change any other assertion's expected output. The intent is to keep the fixture valid post-schema-addition; neighboring `description` / `isOpinion` / `isFeelGood` tests should still pass unchanged.

**Verification:**
- `npx tsx --test tests/news-story-track-description-persistence.test.mts` — all green.
- `grep -nE "'category'" server/worldmonitor/news/v1/list-feed-digest.ts` returns exactly one new occurrence in `buildStoryTrackHsetFields` (in addition to any pre-existing comment mentions).

---

- [ ] U2. **Pass `track.category` through `buildDigest`'s `stories.push`**

**Goal:** The category value persisted by U1 reaches `filterTopStories` and the composer. `buildDigest` reads `track.category` defensively, passes it onto the per-story object alongside the existing fields.

**Requirements:** R3.

**Dependencies:** U1 (without persistence there's nothing to read; but U2 is harmless to land before U1 ships since `track.category` would just be `undefined` → defensive expression → `''` → `'General'` default, which is exactly today's behavior).

**Files:**
- Modify: `scripts/seed-digest-notifications.mjs` — extend the `stories.push({...})` object inside `buildDigest` with `category: typeof track.category === 'string' ? track.category : ''`.
- Modify: `scripts/lib/brief-compose.mjs` — update three stale doc comments that document the digest shape as not carrying category. Sites: `:543` (the `digestStoryToSynthesisShape` JSDoc that says `category` defaults because `story:track:v1 carries neither field`), `:585-586`, `:625-627`. After U2, those statements are wrong — either reword to reflect the new behavior or strike the obsolete reason clause.
- Test: `tests/digest-buildDigest-feelgood-filter.test.mjs` (greenfield from PR #3748) OR a sibling source-textual test asserting the field is written to the per-story object. Since `buildDigest` is not exported, source-textual is the codebase's established pattern here.

**Approach:**
- Locate the `stories.push({...})` site (currently around the post-`isOpinion`/`isFeelGood`-filter section, ~line 540 area post-#3748). Add `category` as a sibling key in the object literal. Position alphabetically or next to a semantically-related field (e.g., next to `severity`) — either is fine; the existing object has no strict ordering convention.
- The defensive `typeof === 'string'` shape mirrors how `description` is currently read in the same site (`description: typeof track.description === 'string' ? track.description : ''`).

**Patterns to follow:**
- The `description: typeof track.description === 'string' ? ... : ''` line in the same `stories.push` block — exact same defensive shape.
- The U3 buildDigest filter block PR #3748 added — same pattern of reading `track.<field>` defensively.

**Test scenarios:**

*Source-textual — wiring is present:*
- T6. *Happy path:* `tests/digest-buildDigest-feelgood-filter.test.mjs` (or a new sibling test file) asserts the buildDigest source contains the `category: typeof track.category === 'string'` shape inside the `stories.push` block. Mirrors how the existing source-textual tests assert the feel-good filter shape.
- T7. *Negative-space:* the same source-textual test asserts the pattern is NOT inadvertently added inside the `isOpinion` or `isFeelGood` filter blocks (which use `continue` and never reach `stories.push`).

*Integration (if a live `buildDigest` test surface becomes available — currently not exported):*
- T8. *Deferred:* if a future refactor exports `buildDigest` for unit testing, add a fixture-driven test: feed a `track` row with `category: 'conflict'` → the returned story has `category: 'conflict'`. Sibling: track with no category → story has `category: ''`. Out of scope for this PR; flagged as a follow-up.

**Verification:**
- `npx tsx --test tests/digest-buildDigest-feelgood-filter.test.mjs tests/digest-no-reclassify.test.mjs tests/digest-orchestration-helpers.test.mjs` — green.
- Broader brief sweep `npx tsx --test tests/brief-from-digest-stories.test.mjs tests/brief-llm.test.mjs tests/seed-envelope-parity.test.mjs` — no regressions.
- Manual `grep -nE 'category:\s*typeof\s+track\.category' scripts/seed-digest-notifications.mjs` returns the new line.

---

- [ ] U3. **Capitalize category once at the envelope-build site (`shared/brief-filter.js`)**

**Goal:** Every envelope-emitted story has a Title-Case `category` value. Downstream consumers (threads card, story pages, public-thread stubs) all read from the envelope and therefore all see the same normalized form. Single normalization site = single source of truth = no case drift between surfaces.

**Why here, not at any display site:** `category` is rendered in at least three places: `scripts/lib/brief-compose.mjs:812` (threads card), `server/_shared/brief-render.js:653` (magazine story-page), `server/_shared/brief-render.js:1296-1302` (public-thread fallback). Normalizing at one display site (e.g., brief-compose only) would create inconsistency — threads card would show `Conflict` while story pages would show `conflict`. Normalizing at the envelope build site fixes all three with one change.

**Requirements:** R4.

**Dependencies:** U1, U2 (without persistence + passthrough, there's nothing meaningful to capitalize — `category` is always `'General'` today).

**Files:**
- Modify: `shared/brief-filter.js` — at the `out.push({...})` site inside `filterTopStories` (~line 415), Title-Case the emitted `category` value. Do NOT change the source/category cap (~line 376) — it must keep grouping on the canonical lowercase value so `'conflict'` stories from different sources continue to count as the same category for cap purposes.
- Test: `tests/brief-filter.test.mjs` — the existing test surface for `filterTopStories` (the shared function being modified). **Primary load-bearing test surface.** Add the new contract assertions here so the contract is locked at the shared-function boundary, not only at downstream consumers.
- Test: `tests/brief-from-digest-stories.test.mjs` — secondary; covers the digest-path round-trip (track row → envelope → composer). Add an end-to-end assertion that an input story with `category: 'conflict'` produces an envelope story with `category: 'Conflict'`.
- Test: `tests/brief-magazine-render.test.mjs` — if it exists and exercises a story-page render path, add an assertion that the rendered category text matches the Title-Case form. If it doesn't exist or doesn't cover this, the `tests/brief-filter.test.mjs` envelope-level coverage is sufficient.

**Approach:**
- Locate `filterTopStories`' `out.push({...})` site (the final emission point of the envelope-bound story). Add inline: `category: titleCase(category)` where `titleCase` is a **word-wise** helper: `s => typeof s === 'string' && s.length > 0 ? s.replace(/\b[a-z]/g, c => c.toUpperCase()) : s`.
- **Why word-wise, not first-letter-only:** `filterTopStories` is shared by digest AND `composeBriefForRule()` callers (`scripts/lib/brief-compose.mjs:205-215`). The function's own comment block (`:294-300`) explicitly documents that category values may contain spaces (e.g. `'World Politics'`). A first-letter-only helper (`'world politics' → 'World politics'`) would corrupt those. Word-wise `\b[a-z]` matches every word-boundary lowercase letter, so single-word EventCategory values (`'conflict' → 'Conflict'`) and multi-word legacy values (`'world politics' → 'World Politics'`) both normalize correctly. Already-capitalized values (`'General'`, `'World Politics'`) are idempotent — `\b[a-z]` doesn't match uppercase letters.
- The cap-keying call earlier in the function (`const pairKey = source + KEY_DELIM + category;` at ~line 376) MUST continue to use the canonical raw value. If `category` is reassigned to the Title-Case form, the cap groups by `'Conflict'` (per-source) instead of the union of `'conflict'` from all sources. Easiest: introduce a local `const displayCategory = titleCase(category)` and use that only in `out.push`.

**Patterns to follow:**
- Check if `shared/brief-filter.js` already imports / defines a word-wise title-case helper; if so, use it. Otherwise inline the `titleCase` arrow function shown above — it's a one-liner. Do NOT use a first-letter-only variant.

**Test scenarios:**

*Happy path — capitalization applied to envelope:*
- T9. *Happy path:* `filterTopStories` over a fixture with one story `category: 'conflict'` → envelope story has `category: 'Conflict'`. (Test surface: `tests/brief-filter.test.mjs` — primary contract assertion.)
- T10. *Sibling values (parameterized):* all 14 EventCategory enum values → Title-Case form: `'health' → 'Health'`, `'diplomatic' → 'Diplomatic'`, `'tech' → 'Tech'`, `'environmental' → 'Environmental'`, `'terrorism' → 'Terrorism'`, `'protest' → 'Protest'`, `'disaster' → 'Disaster'`, `'economic' → 'Economic'`, `'cyber' → 'Cyber'`, `'military' → 'Military'`, `'crime' → 'Crime'`, `'infrastructure' → 'Infrastructure'`, `'general' → 'General'`.

*Critical regression — multi-word category preserved end-to-end (non-digest caller protection):*
- T10b. *Critical regression:* `filterTopStories` over a fixture with `category: 'world politics'` (multi-word legacy value used by `composeBriefForRule`) → envelope story has `category: 'World Politics'`. Without word-wise title-case, the value would corrupt to `'World politics'` and silently degrade UX on the non-digest callers (`scripts/lib/brief-compose.mjs:205-215`). This test asserts the word-wise rule documented in `:294-300` is honored.

*Critical regression — source/category cap groups on canonical raw value, BEFORE titleCase normalization:*
- T11. *Critical regression — case mix proves cap key uses raw value:* feed `filterTopStories` two stories from the SAME source — one with `category: 'conflict'`, one with `category: 'Conflict'` (mixed case, simulating a publisher that already capitalizes). Capped at 1 per (source, category). Both should be capped as the SAME pair (assert only one survives). If `pairKey` is built from the Title-Cased display value instead of the raw value, the two stories would key to `'Conflict' === 'Conflict'` and still cap correctly — so to genuinely lock that the cap uses RAW (not display): supplement with T11b. *(The lowercase-only fixture from earlier rounds passed regardless of which value pairKey used, which is exactly what Codex round-5 flagged. Mixed-case is the load-bearing assertion shape.)*
- T11b. *Source-textual assertion (belt-and-suspenders):* assert `shared/brief-filter.js` source contains `const pairKey = source + KEY_DELIM + category` (or equivalent) BEFORE the `out.push({...})` site where `titleCase` is applied. Source-textual locks the structural ordering ("cap-key computation precedes display normalization") that the behavior test alone could miss if both code paths happened to converge.

*Edge case — fallback idempotency:*
- T12. *Edge case:* a story whose `category` field is missing → hits `filterTopStories`' `'General'` default → emitted envelope `category` is `'General'` (word-wise title-case is idempotent on already-capitalized input; `\b[a-z]` doesn't match `'G'`).

*Edge case — empty / unusual inputs:*
- T13. *Defensive:* empty-string `category` (after `asTrimmedString`) falls through to `|| 'General'` → envelope receives `'General'`. The `titleCase` helper's truthy + type guards (`typeof s === 'string' && s.length > 0`) prevent throws on `null`/`undefined`/`''`.

**Verification:**
- `npx tsx --test tests/brief-filter.test.mjs tests/brief-from-digest-stories.test.mjs tests/brief-llm.test.mjs tests/brief-composer-rule-dedup.test.mjs` — no regressions; new T9-T13 assertions green. (Note the addition of `brief-filter.test.mjs` to the list — that's the primary contract test surface for U3.)
- Visual / snapshot smoke: render a sample brief locally (or look at the next production brief) and confirm the threads card tags AND any story-page category tags AND public-thread fallback stubs all read `Conflict` / `Health` / etc. consistently. (Manual; not blocking on this PR but worth a 30-second eyeball.)

---

## System-Wide Impact

- **Interaction graph:** Three sites touched (HSET write, buildDigest pass-through, display capitalization). No callbacks, no async, no new dependencies. Linear data flow: `parseRssXml` → `buildStoryTrackHsetFields` → Redis HSET → `buildDigest` HGETALL → `filterTopStories` → composer → threads card.
- **Error propagation:** Defensive `typeof` guards at write AND read sites; empty-string fallback at every layer falls through `filterTopStories`' existing `'General'` default. No new throw paths.
- **State lifecycle risks:** Pre-existing `story:track:v1` rows have NO `category` field. They gracefully degrade to `'General'` via the existing `filterTopStories:365` default. Residue duration depends on the user's digest window: daily users see residue for ~24-48h (their window pulls a narrow accumulator slice); weekly users see residue for up to ~7d (their window pulls a wider slice, bounded by `STORY_TTL = 7d` on the row). `DIGEST_ACCUMULATOR_TTL = 48h` is a whole-key EXPIRE that does NOT prune per-member; it only refreshes the key's lifetime. Fresh ingests overwrite the same `story:track:v1` hash key as new mentions arrive, so the practical residue trends down faster than the theoretical max. No read-time re-classifier needed (intentional asymmetry vs #3748 + AI-verdict-preservation reason — see KTD).
- **API surface parity:** No external API change. The Redis row schema gains a field but HSET is open — no schema migration needed, no consumer break. `filterTopStories`, `orderBriefCandidates`, the synthesis prompt, and the carousel are unchanged.
- **Integration coverage:** U2's source-textual test (T6) asserts the buildDigest wiring is present. U3's display test (T9-T11) covers the round-trip from persisted lowercase to displayed capitalized form. The cross-layer chain (ingest → persist → read → display) is covered by the combination.
- **Unchanged invariants:** `EventCategory` enum (taxonomy), `classifyByKeyword` behavior, `filterTopStories`' source/category cap, the brief envelope contract, the carousel rendering, opinion + feel-good filters all unchanged. No ranker or scoring logic changes.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Pre-PR `story:track:v1` rows show `'General'` during the rollout window. Daily users: ~24-48h. **Weekly users: up to ~7d** (their digest window pulls a 7d accumulator slice; `STORY_TTL = 7d` is the upper bound; `DIGEST_ACCUMULATOR_TTL = 48h` is a whole-key EXPIRE that does NOT prune individual members from the accumulator). | Intentional + documented (R5). The behavior during the rollout window is identical to today's (everything is `'General'`), so this is graceful degradation, not a regression. The ~7d weekly-user bleed is acceptable because it's transient + cosmetic + the alternatives (one-off backfill script OR read-time residue catch that loses AI-verdict adjustments from `enrichWithAiCache`) cost more than the gap is worth. |
| `classifyByKeyword` returns a value not in the `EventCategory` enum (e.g., taxonomy drift, future addition) | The word-wise title-case (`replace(/\b[a-z]/g, c => c.toUpperCase())`) works on any non-empty string, single-word or multi-word. No coupling to the enum's specific values. If a new category is added in `_classifier.ts`, the threads card displays it correctly with no code change. |
| `brief-compose.mjs:812` already has a more elaborate tag-rendering helper that this capitalization conflicts with | Implementer to read the surrounding context (10-15 lines around line 812) before applying the change. If a tag helper already exists, integrate the capitalization there rather than adding a sibling site. |
| The category cap in `filterTopStories` starts biting differently post-fix (today it operates against `'General'` for everything; post-fix it operates against meaningful values) | Behaviorally desirable — the cap exists exactly to enforce source/category diversity, and operating against meaningful categories is what it was designed for. If the cap's defaults turn out too aggressive in production, that's a config tune in `filterTopStories`, not a rollback of this fix. |

---

## Documentation / Operational Notes

- No user-facing documentation impact.
- **Operational rollout:** ship in U1→U2→U3 order. U1 alone is safe for the live digest path (writes a field nothing consumes yet). U2 alone is safe for the digest path (reads a field that defaults to empty → existing `'General'` default fires). U3 alone is **NOT a no-op**: `filterTopStories` is shared with `composeBriefForRule` callers (`scripts/lib/brief-compose.mjs:205-215`) that already feed lowercase categories like `'weather'` / `'politics'`; shipping U3 alone immediately changes the envelope output for those callers (`'weather' → 'Weather'`). That's almost certainly desired (consistent Title-Case everywhere), but it's not idempotent and shouldn't be characterized as "safe in isolation." Recommend landing U1→U2→U3 as one PR; if split, ship U3 last so the digest path's category value is meaningful before normalization fires.
- **Post-deploy verification:** spot-check the next 1-2 daily production briefs for (a) the threads card showing a mix of Title-Case tags (`Conflict`, `Health`, `Diplomatic`, …) instead of 8/8 `General`, (b) the magazine story-page category text and public-thread fallback stubs displaying the same Title-Case form (consistency across the three rendering sites — one of the load-bearing properties of the envelope-build normalization), (c) no consumers crashing on the new field, (d) `filterTopStories`' source/category cap continuing to allow the right number of stories per category (verifies the cap stayed on canonical raw values). Expect a mix of Title-Case + residual `'General'` for the first 24-48h; daily users heal first. **Weekly users:** also spot-check the next weekly brief — residual `'General'` can persist for up to ~7 days because their digest window pulls a wider accumulator slice. The healing curve is asymmetric by rule; that's expected and called out in R5 / Risks.
- **First-week telemetry watch:** spot-check the category distribution across 5-7 briefs. If `'general'` (lowercase, post-PR) dominates → `classifyByKeyword` may be defaulting to `'general'` for most stories (broader signal of a classifier-output issue, not a persistence one). Out of this PR's scope; would be a follow-up to the classifier's keyword maps.

---

## Sources & References

- Origin: this session's May 17 brief Definition-of-Done verification, item #1 (8/8 General threads tags). User picked option (a) "Fix the ingest classifier so story:track:v1 rows carry meaningful category values".
- PR #3697 — threads-from-walk — the PR that exposed the latent gap by reading `digest.threads[].category` for display. Not changed by this PR; this PR makes the value it tries to read actually exist.
- PR #3748 — feelgood-classifier — sibling pattern for adding a new field to `story:track:v1`. The most recent precedent; mechanical mirror.
- PR #3690 — opinion-classifier — original precedent.
- `server/worldmonitor/news/v1/_classifier.ts` — the `EventCategory` enum and `classifyByKeyword` already producing meaningful values.
- `server/worldmonitor/news/v1/list-feed-digest.ts` — `parseRssXml` stamps `category: threat.category` inside its `items.push`; `buildStoryTrackHsetFields` is declared around `:893`; `ParsedItem.category: string` is around `:145`.
- `scripts/seed-digest-notifications.mjs` — `buildDigest`'s `stories.push` site.
- `shared/brief-filter.js:365-416` — envelope-build site (R4 normalization happens at `out.push`, ~`:415`; cap-keying stays on canonical lowercase at `:376`).
- `scripts/lib/brief-compose.mjs:812` — threads-card tag consumer (post-fix: receives Title-Case from envelope).
- `server/_shared/brief-render.js:653` — magazine story-page category render (already HTML-escaped at `:565,653`; post-fix: shows Title-Case).
- `server/_shared/brief-render.js:1296-1302` — public-thread fallback stub (post-fix: same Title-Case form).
- `server/_shared/cache-keys.ts:43-44` — `STORY_TTL = 604800` (7d) + `DIGEST_ACCUMULATOR_TTL = 172800` (48h) constants that bound the rollout window.
- `server/worldmonitor/news/v1/_classifier.ts:346` — `classifyByKeyword(title, variant)` signature (relevant to the rejected read-time-residue alternative).
- `server/worldmonitor/news/v1/list-feed-digest.ts:678,725` — `enrichWithAiCache` overrides of `item.category` (the AI-verdict preservation reason for choosing persistence over residue catch).
- Codex review round 1 (gpt-5.4): identified the single-display-site problem and the TTL / residue-rationale errors. This plan revision addresses all 4 findings.
