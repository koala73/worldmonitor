---
title: "fix(brief): exclude feel-good / lifestyle pieces from the digest pool"
type: fix
status: active
date: 2026-05-17
---

# fix(brief): exclude feel-good / lifestyle pieces from the digest pool

**Target repo:** `worldmonitor` (`/Users/eliehabib/Documents/GitHub/worldmonitor`). All paths in this plan are relative to that repo.

## Overview

The May 17 0802 brief shipped "Veterans reunite with their vintage war planes" — a feel-good local human-interest piece from Peru, Illinois (population 9,800) — at card **#4 (HIGH severity)**, sitting in a brief otherwise covering WHO's Ebola declaration, a Rwandan genocide-suspect death, Israeli airstrikes in Lebanon, US-Cuba escalation, and Iran's war-readiness warnings. Editorially out of place in a "WorldMonitor Intelligence Brief."

This is the same *class* of problem PR #3690 closed for opinion/analysis pieces — editorially-unfit content the upstream importance/severity classifier wrongly tagged as High-severity. Different signals, identical pipeline shape: ingest-time stamp on `story:track:v1` + buildDigest read-time filter for residue + drop telemetry.

The fix introduces a `classifyFeelGood({title, link, description})` shared classifier mirroring PR #3690's `classifyOpinion` — tiered STRONG (sufficient alone) and CORROBORATING (need ≥2) signals, conservative-by-design (false negatives ship one piece; false positives silently drop a real event). Wired identically: ingest stamps `isFeelGood` on the row, `buildDigest` drops `isFeelGood === '1'` rows and re-classifies residue.

---

## Problem Frame

The Veterans story exposes a gap PR #3690 doesn't cover: the upstream importance/severity classifier rates a vintage-warplane-reunion piece as HIGH because the words "veterans," "war," and "planes" register as conflict-relevant. The story IS conflict-adjacent in vocabulary but not in editorial substance — it's a community human-interest feature, not an event.

This recurs structurally across publishers:
- Local lifestyle features (`Reuters Pictures`, `AP Photos`, regional papers' feature sections)
- "Nostalgia" / decades-later anniversary pieces
- "Local hero" / community-feel-good
- Travel and photo essays from major outlets (`The Guardian`'s `/travel/`, `BBC`'s `/in-pictures/`)

The upstream importance classifier (which is what assigns severity) is the *correct* long-term fix surface — but rebuilding that model is well out of this plan's scope. The pragmatic short-term fix mirrors PR #3690: a dedicated feel-good classifier whose only job is to recognise this content class and exclude it from the brief pool, regardless of severity.

The signals available at ingest (RSS `<title>`, `<link>`, `<description>`) and at the read path (the same fields persisted on `story:track:v1`) are identical to what `classifyOpinion` works from. No new schema is required — `isFeelGood` is a sibling stamp to `isOpinion`.

---

## Requirements Trace

- **R1.** A trailing-URL **pathname segment** of `/lifestyle/`, `/lifestyles/`, `/feature/`, `/features/`, `/gallery/`, `/in-pictures/`, `/oddities/`, `/human-interest/`, or `/community/` MUST cause the story to be classified as feel-good (STRONG signal — sufficient alone, subject to R3a hard-news veto in R3a/U1-step-1). Matching is on `new URL(link).pathname.toLowerCase()`, NOT `.includes()` on the raw URL — query strings (`?utm=/local/promo`) and fragments (`#/community/footer`) MUST NOT trigger STRONG (adv-002 injection vector). Every entry is slash-delimited on both sides (a path segment, not a substring). `/travel/`, `/style/`, `/local/`, and `/photos/`+`/photo/` are NOT in this STRONG list — they are filed under by major outlets for legitimate hard news (BBC travel advisories; FT/Bloomberg business-of-style; regional newspapers' `/local/` for breaking-local-news; Reuters/AP `/photos/` wire-photo desks for breaking-news photo essays of strikes/disasters/conflicts). They appear in CORROBORATING below instead (adv-R2-001 follows the M5 precedent for `/travel/` + `/style/`).
- **R2.** An explicit headline prefix `Photos:`, `Photo:`, `Gallery:`, or `In Pictures:` MUST cause the story to be classified as feel-good (STRONG — sufficient alone, subject to the hard-news veto). `Watch:` and `See:` are deliberately NOT in this set — they're shared with legitimate news-video coverage (the CBS "Watch tornadoes swirl through Oklahoma" pattern from a prior brief), so including them as STRONG would false-positive on hard news.
- **R3.** A combination of CORROBORATING signals MUST reach a **3-distinct-token threshold** (the same token appearing in BOTH title and description counts ONCE; distinct-token identity is the **regex alternation-group label**, NOT the raw matched substring — `reunite` and `reunited` both belong to group `reunite_group` and count as ONE distinct token) to classify as feel-good when no STRONG signal fires. Signals: headline tokens (`reunite_group`: `reunite|reunited|reunites|reuniting|reunion|reunions|reuniters?`, `vintage`, `nostalgia`, `memories_group`: `memory|memories|memorial`, `tribute_group`: `tribute|tributes`, `heartwarming`, `inspirational`, `feel-good`, `local hero`, `unsung`, `decades_later`: `\bdecades\s+later\b`, `years_later`: `\byears\s+later\b`), description framing (same token set + `evoking_memories`: `\bevoking\s+(?:powerful\s+)?memories\b`, `powerful_connections`: `\bpowerful\s+connections\b`, `feel_good_story`: `\bfeel[-\s]good\s+story\b`, `human_interest`: `\bhuman\s+interest\b`, `lifestyle_feature`: `\blifestyle\s+feature\b`, `gathered_to_remember`: `\bgathered\s+to\s+remember\b`), URL pathname segments `/travel/`, `/style/`, `/local/`, `/photos/`+`/photo/` (the demoted-from-STRONG entries — each pathname segment counts as 1 distinct corroborating signal, with `/photos/` and `/photo/` collapsing into one group `photos_pathname`). The 3-distinct-token threshold (raised from 2 per adv-R2-003) plus the alternation-group dedup (per adv-R2-002) are the load-bearing FP defenses: a ceasefire-reunion story echoing `reunite`/`reunited` between title and description counts as 1 distinct token, not 2; a hard-news headline that picks up two adjacent corroborating signals by chance (very common in narrative news prose) no longer trips. `restored` and `meet the` are excluded from the token list — `restored` false-positives on restitution / artwork-return ("Restored Klimt painting returned to family"); `meet the` is a function-word bigram that false-positives on diplomacy headlines ("US officials meet the Russian delegation in Geneva"). Multi-word tokens are encoded as `\bword1\s+word2\b` (whitespace-tolerant, boundary on the outer edges only). The Veterans anchor case still classifies under the raised threshold (T9: 3 distinct = `reunite_group`, `vintage`, `memories_group`).
- **R3a (hard-news veto).** When the title OR description contains a hard-news veto token, the story MUST NOT classify as feel-good — **regardless of which classification path would otherwise return true (STRONG URL, STRONG headline prefix, or CORROBORATING ≥3)**. Veto fires before any other check (U1 step 1). Veto list (expanded per adv-R2-003): exact tokens `ceasefire`, `hostage`/`hostages`, `refugee`/`refugees`, `tribunal`, `war crimes`, `looted`, `testify`/`testimony`/`testifying`, `airstrike`/`airstrikes`, `kill`/`kills`/`killed`/`killing`, `strike`/`strikes`/`struck`, `attack`/`attacks`/`attacked`/`attacking`, `bomb`/`bombs`/`bombed`/`bombing`/`bombings`, `massacre`/`massacres`, `casualties`, `casualty`, `militant`/`militants`, `dead`/`died`/`dies`/`dying`, `wounded`, `evacuat`/`evacuated`/`evacuating`. These are unambiguous active-conflict / accountability / restitution / casualty markers — present, the story is hard news regardless of how many feel-good tokens it stacks. The list errs on the side of preserving real events (conservative-by-design). Without expanded morphology, constructions like "Iran retaliates after strike kills six" (no `\bairstrike\b`, no `\bkilled\b`) would pass the veto and depend on the 3-threshold alone (adv-R2-003).
- **R4.** Ingest (`server/worldmonitor/news/v1/list-feed-digest.ts`) MUST stamp every `story:track:v1` row with `isFeelGood: '1' | '0'` derived from `classifyFeelGood(item)`. New rows written from now on carry the stamp.
- **R5.** Read-time (`scripts/seed-digest-notifications.mjs` `buildDigest`) MUST drop rows where `track.isFeelGood === '1'` AND re-classify residue rows (where the stamp field is absent — ingested before this PR shipped) from the persisted `title/link/description` so the filter is effective immediately on rollout, not only after the 48h TTL window. Mirrors the `isOpinion` residue-catch pattern at `scripts/seed-digest-notifications.mjs:508-520`.
- **R6.** A `droppedFeelGood` local counter in `buildDigest` MUST increment per drop, AND a separate conditional `console.log` line (`[digest] buildDigest feel-good filter dropped N item(s)…`) MUST fire when `droppedFeelGood > 0` — sibling to the existing `droppedOpinion` pattern at `scripts/seed-digest-notifications.mjs:488` (counter) and `550-556` (conditional log). The plan's earlier R6 incorrectly claimed `dropped_opinion` was emitted on the per-attempt `[digest] brief filter drops` log line (~1654-1668); that line does NOT carry opinion telemetry — feasibility review C1 caught this. The actual opinion telemetry is its own conditional log inside `buildDigest`.

---

## Scope Boundaries

- **Out of scope: fixing the upstream importance/severity classifier.** The classifier wrongly tags feel-good pieces as HIGH; the correct long-term fix is its retraining. That's a much larger model-rebuild effort. The classifier in this plan is a structural backstop that excludes the content class regardless of severity, parallel to how `classifyOpinion` works alongside the unchanged upstream classifier.
- **Out of scope: small-town place-name detection** (e.g. recognising "Peru, Illinois" pop. 9,800 as a local-color signal). Would require a population dataset and a country/region resolver. The token-based signals (R3) catch the Veterans case (3 corroborating: `reunite`, `vintage`, `memories`) without place-name detection. Revisit only if production telemetry shows feel-good slipping through that token signals don't catch but place-name would.
- **Out of scope: any product surface for lifestyle stories.** This plan only excludes the content class from the brief pool. Whether the product later surfaces lifestyle stories elsewhere is a separate decision (cheap to make later — `isFeelGood` is carried end-to-end on the row).
- **Out of scope: changes to `classifyOpinion`** or the opinion-classifier signal lists. Sibling classifier, parallel design, independent files. The two share NO mutable state.
- **Out of scope: cache prefix bumps.** Neither the brief envelope cache nor the synthesis cache is keyed on `isFeelGood` (those keys are derived from the eventually-included pool, which now legitimately excludes more rows). Natural cache rotation; no prefix bump.

---

## Context & Research

### Relevant Code and Patterns

This plan mirrors PR #3690 (opinion-classifier) **exactly**. All file paths and patterns:

- `server/_shared/opinion-classifier.js` (5,309 bytes) — the precedent. STRONG_URL_SEGMENTS array + STRONG_HEADLINE_PREFIX_RE + CORROBORATING_DESCRIPTION_RE + `isWholeHeadlineQuoted` helper + tiered `classifyOpinion({title, link, description})` export. Replicate this structure for `classifyFeelGood`.
- `server/_shared/opinion-classifier.d.ts` (598 bytes) — type declaration. Replicate as `feelgood-classifier.d.ts`.
- `tests/opinion-classifier.test.mjs` (7,182 bytes) — 12 tests covering happy paths, the slash-delimited path-segment requirement (S26 / PR review), STRONG headline prefix, CORROBORATING 2-threshold, and edge cases (whole-headline-quoted false positives, etc.). Mirror this test file structure.
- `server/worldmonitor/news/v1/list-feed-digest.ts` — `parseRssXml` at line 478 stamps `isOpinion: classifyOpinion({title, link, description})`. `ParsedItem` type at line 163 declares `isOpinion: boolean`. `buildStoryTrackHsetFields` at line 911 persists `'isOpinion', item.isOpinion ? '1' : '0'`. Mirror all three for `isFeelGood`.
- `scripts/seed-digest-notifications.mjs` — `buildDigest` at line 500-520 does the read-time filter for `isOpinion` (stamp trust + residue re-classify + `droppedOpinion` counter at line 488). Mirror this block for `isFeelGood`. Telemetry surface: the conditional `console.log` at lines 550-556 (`if (droppedOpinion > 0) console.log('[digest] buildDigest opinion filter dropped …')`) — sibling conditional log for feel-good. The per-attempt `[digest] brief filter drops` log line at `:1654-1668` does NOT carry opinion telemetry today and must NOT gain a feel-good field either (per C1; the rest of the plan is explicit about this).
- `Dockerfile.digest-notifications` line 88: `COPY server/_shared/opinion-classifier.js server/_shared/opinion-classifier.d.ts ./server/_shared/`. Add a sibling COPY for the feel-good classifier files.
- `tests/dockerfile-digest-notifications-imports.test.mjs` — the transitive-import-closure test that caught the missing `opinion-classifier.js` COPY in PR #3690. Will catch the same omission here if I forget; build the COPY into U4 so the test passes by construction.

### Institutional Learnings

- PR #3690 review (Greptile P2): `/opinion-` as an unbounded substring false-positively classified hard-news slugs like `/world/opinion-polls-tighten-election`. Fix: every URL entry in `STRONG_URL_SEGMENTS` is slash-delimited on both sides (path segment, not substring). Same rule applies here — `/local/` not `/local-`, `/feature/` not `/feature-`.
- PR #3690's CORROBORATING design (2-signal threshold) survived production cleanly with no false positives — the conservative posture is well-validated for this content-classification family.
- The May 14 brief analysis (origin of PR #3690) named opinion-piece exclusion as "exclude entirely, not severity-cap" — same posture applies here. A capped feel-good piece still occupies a card slot a real event should have.

### External References

- None. Pattern is fully internal — PR #3690 is the template, no new framework or third-party guidance needed.

---

## Key Technical Decisions

- **Conservative-by-design (folded in from old R7 per scope-guardian SG-001).** False negatives (one feel-good piece ships, visible cosmetic issue) are preferred over false positives (a real event silently disappears from the brief). Every defensive choice in R1-R6 is an expression of this priority: pathname-only URL match (R1/C3), narrow STRONG list (R1: 9 segments, excludes `/travel/`/`/style/`/`/local/`/`/photos/`), distinct-token-via-alternation-group dedup (R3/adv-R2-002), CORROBORATING threshold raised from 2 to **3** (R3/adv-R2-003), morphology-expanded hard-news veto applied **before any classification path** (R3a/adv-R2-003), and exclusion of overpromiscuous tokens (`restored`, `meet the`).
- **Mirror PR #3690 structurally — sibling classifier, sibling stamp, sibling filter.** Two independent classifiers (opinion + feel-good) rather than one merged classifier. Independence keeps each signal list focused, each test file scoped, and each future evolution path independent. Cost: a small amount of structural duplication. Benefit: each classifier's signal list is justifiable on its own merits.
- **`classifyFeelGood` returns `true | false`, never `'maybe'`.** Same shape as `classifyOpinion`. The "veto-first → STRONG-URL → STRONG-prefix → CORROBORATING ≥3-distinct" sequence is the only decision point.
- **URL matching uses parsed pathname, NOT `.includes()` on the full URL string (adv-002 / C3).** `STRONG_URL_PATHNAME_SEGMENTS` is matched against `new URL(link).pathname.toLowerCase()` inside a try/catch (malformed URL → skip URL signal). This closes the injection vector where `?utm=/local/promo` or `#/community/footer` would otherwise falsely trigger STRONG via aggregator tracking params. The same gap exists in `server/_shared/opinion-classifier.js:93` today; backport recommended in Sources & References as a sibling follow-up PR.
- **STRONG signals are URL pathname segments + explicit headline prefixes only.** No description-only STRONG signals — description framing is too soft for a sole-strip trigger; it must compound with at least 2 other signals (3-threshold).
- **CORROBORATING dedup is by alternation-group label, NOT raw matched substring (adv-R2-002).** The regex `/(?<reunite_group>reunite|reunited|reunites|reuniting|reunion|reunions|reuniters?)/i` captures all reunite-family inflections under the named group `reunite_group`; the distinct-token set keys on the group name. Without this rule, `reunite` (title) and `reunited` (description) would count as 2 distinct strings, defeating the C2 echo-protection the plan relies on. Implementation MUST use named-capture groups (or an equivalent group-id mechanism) — raw `match[0]` dedup is incorrect.
- **CORROBORATING threshold raised from 2 to 3 distinct tokens (adv-R2-003).** The 2-threshold made hard-news false positives reachable on natural news prose ("Survivors recount decades later their memories of the Halabja massacre" = 2 distinct, no `\bairstrike\b`/`\bkilled\b` veto without morphology expansion; "Iran retaliates after strike kills six" = 2 if a description token stacks). Raising to 3 removes that constructible class entirely and is recall-safe for the Veterans anchor (3 distinct naturally). Pair with morphology-expanded veto for belt-and-suspenders.
- **Hard-news veto (R3a) runs FIRST and overrides every classification path (adv-R2-003 + SG-R2-002).** The veto is checked BEFORE STRONG URL, STRONG headline prefix, AND CORROBORATING counting — a single veto hit returns false immediately. Veto-list expanded with morphology variants (`kill`/`kills`/`killed`/`killing`, `strike`/`strikes`/`struck`, `attack`/`attacks`/`attacked`/`attacking`, `bomb`/`bombs`/`bombed`/`bombing`, `massacre`, `casualties`, `militants`, `dead`/`died`/`dies`, `wounded`, `evacuat`) so natural news inflections veto without requiring exact-token publisher cooperation. R3a wording supersedes the earlier "even when corroborating signals reach the threshold" framing (which falsely scoped veto to CORROBORATING only).
- **`restored` and `meet the` excluded from CORROBORATING tokens (adv-001 + adv-R2-004).** Both are high-FP-rate: `restored` trips restitution news ("Restored Klimt painting returned to family"); `meet the` is a function-word bigram common in diplomacy ("US officials meet the Russian delegation in Geneva"). Veterans anchor doesn't need either. Trade: legitimately-feel-good restorations/introductions need other tokens to fire — acceptable.
- **`/travel/`, `/style/`, `/local/`, and `/photos/`+`/photo/` demoted from STRONG to CORROBORATING (M5 + adv-R2-001).** Major outlets file hard news under all four: BBC travel advisories (`/travel/`), FT/Bloomberg business-of-style (`/style/`), regional papers' breaking local news (`/local/`), Reuters/AP wire-photo desks for breaking strikes/disasters (`/photos/`). As CORROBORATING each contributes 1 distinct signal toward the 3-threshold; alone none classify.
- **`Watch:` and `See:` deliberately NOT in STRONG headline prefixes.** They overlap with legitimate news-video coverage (CBS "Watch tornadoes swirl…" pattern).
- **Tokens use word-boundary matching** (`\bword\b`). Multi-word tokens use whitespace-tolerant outer boundaries: `\bdecades\s+later\b`. Mirrors how `classifyOpinion`'s `CORROBORATING_DESCRIPTION_RE` works.
- **Stamp name `isFeelGood` (camelCase boolean → '1' | '0' string on Redis).** Matches `isOpinion` exactly. Persistence layer: `buildStoryTrackHsetFields`. No schema bump; HSET fields are open.
- **Read-time filter precedes severity / phase / sensitivity filters** (mirror the `isOpinion` filter position at line 510). Earlier filtering = cleaner downstream telemetry.
- **Telemetry is a local counter + conditional log inside `buildDigest` only (C1).** Per-attempt `[digest] brief filter drops` log at `:1654-1668` does NOT carry this signal; mirrors what `dropped_opinion` does. See R6 for the exact pattern.
- **Opinion + feel-good telemetry asymmetry documented (adv-005 / M6).** The `continue` after each filter means a row matched by BOTH classifiers increments only the first counter that fires (opinion, since it runs first) — applies to stamped, residue-classified, and mixed paths equally. The post-deploy telemetry watch on `droppedFeelGood` undercounts the overlap class. Documented in U3's implementation comment AND in the operator runbook (Documentation / Operational Notes) so engineers AND on-call read the counters correctly. Acceptable trade vs. running both classifiers always.
- **No cache prefix bump.** The brief envelope is rebuilt per cron tick; synthesis cache key `brief:llm:digest:v6` is keyed on the pool hash (`hashDigestInput`), which naturally changes when the pool excludes new rows. No staleness risk.
- **Place-name signal deferred (Scope Boundaries).** The Veterans case is caught by token signals alone, and adding population-threshold detection is a meaningful additional scope.

---

## Open Questions

### Resolved During Planning

- **Should `Watch:` and `See:` be STRONG feel-good prefixes?** No. They overlap with legitimate news-video coverage (e.g. CBS hurricane / tornado / disaster videos). Including them as STRONG would silently drop real events. Keep them out; the existing `HEADLINE_PREFIX_RE` already strips them as prefixes for cosmetic reasons.
- **Should small-town place-name detection be in scope?** No — deferred. The token signals catch the Veterans case (`reunite` + `vintage` + `memories` = 3 corroborating). Revisit only if production shows feel-good slipping through that place-name detection would catch.
- **One merged classifier vs two sibling classifiers (opinion + feel-good)?** Two sibling classifiers. Keeps each signal list focused and each evolution path independent. Negligible structural duplication; major clarity benefit.
- **Where in `buildDigest` does the feel-good filter sit relative to the opinion filter?** Adjacent — right after the opinion filter block, before severity/phase/sensitivity filters. Both are "this content class isn't a brief event" filters; co-locating them makes the editorial intent obvious to a reader.
- **Should the classifier examine the `description` field for STRONG signals or only CORROBORATING?** CORROBORATING only. Description framing is too soft for a sole-strip trigger. Mirrors `classifyOpinion` (which also restricts description to CORROBORATING).
- **Cache prefix bump?** No. Pool changes naturally rotate the synthesis cache key.

### Deferred to Implementation

- **Exact starting token list for CORROBORATING.** Plan provides a starting list (R3); implementation may add 1-2 tokens if test fixtures or the first post-deploy brief surface a real-world case the starting list misses. Conservative — every addition slightly increases false-positive risk.
- **Exact starting URL segment list for STRONG.** Plan provides a starting list (R1); implementation may add segments if real-world feed fixtures surface variants. Same conservative posture.
- **Whether to also add a `'feelgood'` drop reason to the existing `onDrop` event interface in `shared/brief-filter.js`.** Currently `onDrop` carries `reason: 'severity' | 'headline' | 'url' | 'shape' | 'cap' | 'source_topic_cap' | 'institutional_static_page'`. The opinion filter doesn't go through `onDrop` (it filters in `buildDigest`, before `filterTopStories`). Feel-good filter is sibling — same path, no `onDrop` change needed. Verify at implementation time.

### Surfaced in Document Review (ce-doc-review 2026-05-17, FYI — not blocking)

These were raised by the multi-persona review, judged out-of-scope for this PR, and recorded here so a future iteration has a starting list. Not blockers for shipping U1-U4.

- **FYI-001 (adversarial, sibling backport).** The `.includes()` URL match bug we're closing in `feelgood-classifier` (C3 / adv-002) exists today in `server/_shared/opinion-classifier.js:93`. Same shape: `?utm=/opinion/promo` would falsely trigger STRONG. Worth a tiny follow-up PR — backport `new URL(link).pathname.toLowerCase()` + try/catch to `classifyOpinion`. Out of scope here to keep the diff focused on the feel-good change.
- **FYI-002 (feasibility, empirical tuning).** The CORROBORATING token list (R3) and the hard-news veto list (R3a) are educated starting positions, not telemetry-derived. The post-deploy first-week watch (Documentation / Operational Notes) should drive add/remove decisions. Without that follow-up loop the lists will silently rot.
- **FYI-003 (coherence, regex tokenization).** `decades later` and `years later` are multi-word tokens. Implementation must decide whether to encode them as `\bdecades\s+later\b` (whitespace-tolerant) or a literal — and the test fixtures (T9c) need to lock the choice. Document the regex shape in the U1 file header comment so a future reader doesn't accidentally break it.
- **FYI-004 (security-lens NOT activated — surfaced anyway by adversarial).** The hard-news veto list is intentionally narrow (`ceasefire|hostage|refugee|tribunal|war crimes|looted|testify|airstrike|killed`). Country names and `war`/`combat`/`attack` are NOT in the list because of slippery-slope risk. If production shows a real false positive that a country-name veto would catch, revisit — but the conservative posture is the right starting point.
- **FYI-005 (product-lens NOT activated — surfaced by scope-guardian).** No metric on filter-drop rate aggregation. The conditional `[digest] buildDigest feel-good filter dropped N` log is searchable, but a Grafana / Datadog panel charting `dropped_feelgood` over time would make the first-week telemetry watch observable instead of grep-based. Out of scope for the PR; cheap follow-up.
- **FYI-006 (adversarial, recall gap).** Removing `restored` from the CORROBORATING token list (per C2) opens a recall gap: a genuinely feel-good restoration piece ("Restored 1923 carousel reopens to community after 40 years") needs at least 2 OTHER tokens to fire. Acceptable trade for restitution-news (Klimt painting) protection, but worth noting if production shows a restoration-class miss.
- **FYI-007 (scope-guardian, future signals).** Some publishers (BBC, Reuters, AP) tag RSS items with `<category>` values like `Human Interest`, `Features`, `Lifestyle`. The classifier currently ignores `<category>` entirely. A future v2 could read the field as an additional CORROBORATING signal — cheap, more reliable than substring matching. Deferred because: not all publishers populate it, and the token-based design works for the Veterans anchor case today.
- **FYI-008 (feasibility, CI safety-net hardening).** `tests/dockerfile-digest-notifications-imports.test.mjs` catches U4-class omissions but only when a developer remembers to run it. A pre-merge CI gate (already runs `tsx --test`?) closes that loop. Verify the test is part of the default CI job at implementation; if not, file a sibling ticket to add it. Out of scope to add a CI workflow here.

---

## Implementation Units

- [ ] U1. **Create the `feelgood-classifier` shared module**

**Goal:** Add a self-contained `classifyFeelGood({title, link, description})` shared classifier mirroring `classifyOpinion`. Pure function, returns `boolean`, never throws, tiered STRONG / CORROBORATING signal logic.

**Requirements:** R1, R2, R3, R3a.

**Dependencies:** None — leaf module.

**Files:**
- Create: `server/_shared/feelgood-classifier.js`
- Create: `server/_shared/feelgood-classifier.d.ts`
- Test: `tests/feelgood-classifier.test.mjs`

**Approach:**
- Match the exact structure of `server/_shared/opinion-classifier.js`: top-of-file context comment naming the May 17 brief incident, four sets of pattern constants (veto + STRONG URL + STRONG prefix + CORROBORATING), an exported `classifyFeelGood({title, link, description}) => boolean`.
- **`STRONG_URL_PATHNAME_SEGMENTS`** (slash-delimited, both sides): `/lifestyle/`, `/lifestyles/`, `/feature/`, `/features/`, `/gallery/`, `/in-pictures/`, `/oddities/`, `/human-interest/`, `/community/`. **Not** `/travel/`, `/style/`, `/local/`, `/photos/`, or `/photo/` — all moved to corroborating per M5 + adv-R2-001 (legitimate hard-news classes live under these segments at major outlets). Every entry is `/segment/`, never `/segment-`.
- **URL match runs on `new URL(link).pathname.toLowerCase()` inside try/catch** (C3 / adv-002). NOT `.includes()` on the raw URL string. Aggregator tracking params (`?utm=/local/promo`) and fragments (`#/community/footer`) must not falsely trigger STRONG. Malformed URL → catch → fall back to "no URL signal" (do not throw).
- **`STRONG_HEADLINE_PREFIX_RE`** = `/^(?:photos?|gallery|in pictures)\s*:/i`. Trailing colon required (mirrors `STRONG_HEADLINE_PREFIX_RE` in opinion-classifier).
- **`HARD_NEWS_VETO_RE` (R3a — runs FIRST, expanded morphology per adv-R2-003)** = `/\b(?:ceasefire|hostages?|refugees?|tribunal|war\s+crimes|looted|testify|testimony|testifying|airstrikes?|kills?|killed|killing|strikes?|struck|attacks?|attacked|attacking|bombs?|bombed|bombing|bombings|massacres?|casualt(?:y|ies)|militants?|dead|d(?:ied|ies|ying)|wounded|evacuat(?:ed|ing|ion))\b/i`. Applied to BOTH title AND description (any match in either vetoes). Inline comment: "Conservative-by-design: this list errs on the side of preserving real events. Adding `war`/`combat`/country names was considered and rejected as slippery (would veto legitimate feel-good content with crossover vocabulary)."
- **`CORROBORATING_TITLE_TOKENS_RE`** — word-boundary alternation using **named capture groups** (the alternation-group label is the distinct-token identity per adv-R2-002). `restored` REMOVED per C2 / adv-001 (FP on restitution news); `meet the` REMOVED per adv-R2-004 (function-word bigram FP on diplomacy headlines). Example shape:
  ```
  /(?<reunite_group>\breunit(?:e[ds]?|ing|ers?)\b|\breunions?\b)
   |(?<vintage>\bvintage\b)
   |(?<nostalgia>\bnostalgia\b)
   |(?<memories_group>\bmemor(?:y|ies|ial)\b)
   |(?<tribute_group>\btributes?\b)
   |(?<heartwarming>\bheartwarming\b)
   |(?<inspirational>\binspirational\b)
   |(?<feel_good>\bfeel[-\s]good\b)
   |(?<local_hero>\blocal\s+hero\b)
   |(?<unsung>\bunsung\b)
   |(?<decades_later>\bdecades\s+later\b)
   |(?<years_later>\byears\s+later\b)/gi
  ```
  *Note: the `reunite_group` alternation captures reunite/reunited/reunites/reuniting/reuniters/reunion/reunions all under one group — they count as 1 distinct token. Same for `memories_group` (memory/memories/memorial) and `tribute_group` (tribute/tributes). Multi-word tokens use `\bw1\s+w2\b` (whitespace-tolerant outer boundaries, per SG-R2-005).*
- **`CORROBORATING_DESCRIPTION_RE`** = same named-group regex as title + description-only framing phrases (also as named groups so they dedup correctly):
  ```
  /(?<evoking_memories>\bevoking\s+(?:powerful\s+)?memories\b)
   |(?<powerful_connections>\bpowerful\s+connections\b)
   |(?<feel_good_story>\bfeel[-\s]good\s+story\b)
   |(?<human_interest>\bhuman\s+interest\b)
   |(?<lifestyle_feature>\blifestyle\s+feature\b)
   |(?<gathered_to_remember>\bgathered\s+to\s+remember\b)/gi
  ```
- **`CORROBORATING_PATHNAME_RE`** (expanded per adv-R2-001) = `/\/(?<travel_pathname>travel)\/|\/(?<style_pathname>style)\/|\/(?<local_pathname>local)\/|\/(?<photos_pathname>photos?)\//i`. Demoted-from-STRONG segments — each named group counts as 1 distinct corroborating signal when matched (the two `/photos?/` variants collapse under `photos_pathname`). Matched against `URL.pathname.toLowerCase()` (same try/catch as STRONG).
- **Counting (DISTINCT tokens — group-label dedup per adv-R2-002):** Iterate `matchAll` over each regex against title and description; collect the set of `Object.keys(match.groups).find(k => match.groups[k] !== undefined)` — i.e., the named capture group that fired. The distinct-token set is the union of group names across title (TOKENS), description (TOKENS + DESCRIPTION_RE framing), and pathname (PATHNAME_RE). Example: title "Veterans reunite with vintage planes" matches `reunite_group` + `vintage`; description "veterans reunited evoking powerful memories" matches `reunite_group` (DEDUPED) + `evoking_memories` + `memories_group`. Distinct set: `{reunite_group, vintage, evoking_memories, memories_group}` = 4. **Threshold: ≥ 3 distinct group names (adv-R2-003 — raised from 2).**
- **`classifyFeelGood({title, link, description})`:**
  1. Hard-news veto check (R3a — UNCONDITIONAL, runs FIRST, overrides every path): if `HARD_NEWS_VETO_RE` matches title OR description → return `false` immediately. Veto applies to STRONG URL, STRONG headline prefix, AND CORROBORATING — no path bypasses (per SG-R2-002 / adv-R2-003).
  2. STRONG URL pathname segment (parsed pathname, try/catch around `new URL`) → return `true`.
  3. STRONG headline prefix → return `true`.
  4. Count distinct corroborating group names across title + description + pathname. If ≥ **3** → return `true`.
  5. Else `false`.
- **Type declaration `.d.ts`:** `export function classifyFeelGood(story: { title?: unknown; link?: unknown; description?: unknown }): boolean;` — exact mirror.
- **Tests** (`tests/feelgood-classifier.test.mjs`) — ~20 scenarios, mirroring `tests/opinion-classifier.test.mjs`'s structure.

**Patterns to follow:**
- `server/_shared/opinion-classifier.js` — overall shape, comment style, defensive `typeof` guards on inputs, function signature, conservative-by-design framing.
- `tests/opinion-classifier.test.mjs` — test structure, fixture style (named object literals), explicit comments on why each test exists (especially regression tests).

**Test scenarios:**

*Happy path — STRONG URL section (R1):*
- T1. `classifyFeelGood({title: 'X', link: 'https://example.com/lifestyle/holiday-recipes'})` → `true`.
- T2. `classifyFeelGood({title: 'X', link: 'https://example.com/features/local-hero'})` → `true`.
- T3. `classifyFeelGood({title: 'X', link: 'https://example.com/in-pictures/snow'})` → `true`. (`/in-pictures/` is in `STRONG_URL_PATHNAME_SEGMENTS` per R1.)

*Happy path — STRONG headline prefix (R2):*
- T4. `classifyFeelGood({title: 'Photos: Snowfall blankets Vermont', link: ''})` → `true`.
- T5. `classifyFeelGood({title: 'Gallery: Award-winning photography of 2026', link: ''})` → `true`.

*Critical regression — `Watch:` is NOT a STRONG prefix:*
- T6. `classifyFeelGood({title: 'Watch: tornadoes swirl through Oklahoma', link: '', description: 'Severe weather hit three counties.'})` → `false`. Verifies the `Watch:` exclusion documented in K.T.D. and R2.

*Critical regression — slash-delimited URL segments only (PR #3690 lesson):*
- T7. `classifyFeelGood({title: 'X', link: 'https://example.com/world/lifestyle-of-the-rich-and-famous'})` → `false`. The slug merely contains `lifestyle-` as a substring; not a `/lifestyle/` path segment. Mirrors the May 15 brief's `/world/opinion-polls-tighten-election` case that PR #3690 had to fix.
- T8. `classifyFeelGood({title: 'X', link: 'https://example.com/local-elections-coverage'})` → `false`. Same — `/local-` is a slug prefix on a hard-news article, not a `/local/` section.

*Critical regression — URL match uses parsed pathname, not raw URL `.includes()` (C3 / adv-002):*
- T7b. `classifyFeelGood({title: 'X', link: 'https://example.com/world/news?utm_campaign=/local/promo'})` → `false`. Tracking param contains `/local/` but pathname is `/world/news`. STRONG must NOT fire on query strings.
- T7c. `classifyFeelGood({title: 'X', link: 'https://example.com/world/news#/community/footer'})` → `false`. Same protection for URL fragments.
- T7d. `classifyFeelGood({title: 'X', link: 'not a valid URL'})` → `false`. Malformed URL handled defensively (try/catch); URL signal skipped.

*Happy path — CORROBORATING 3-distinct-token threshold (R3) — the Veterans anchor case:*
- T9. `classifyFeelGood({title: 'Veterans reunite with their vintage war planes', link: 'https://news.google.com/rss/articles/CBM…', description: 'In Peru, Illinois, military veterans recently reunited with the vintage warplanes they once piloted, evoking powerful memories and connections.'})` → `true`. Distinct group names: `{reunite_group, vintage, evoking_memories, memories_group}` = 4 ≥ 3 (the `reunite`/`reunited` echo between title and description deduplicates to `reunite_group`; `vintage` appears in both title and description but dedups; `memories` matches `memories_group`; `evoking powerful memories` matches `evoking_memories` description-framing token). No hard-news veto words present. Anchor case from the May 17 brief — survives the threshold-3 raise.

*Critical regression — group-label dedup means inflection echoes count ONCE (adv-R2-002):*
- T9-dedup. `classifyFeelGood({title: 'Veterans reunite at airshow', link: '', description: 'The pilots reunited with their vintage planes and reuniting was tearful.'})` → `false`. Distinct groups: `{reunite_group, vintage}` = 2 < 3. The three reunite-family inflections (`reunite`/`reunited`/`reuniting`) all collapse into `reunite_group`. Without group-label dedup, raw-substring counting would give `{reunite, reunited, reuniting, vintage}` = 4 → trip threshold incorrectly.

*Critical regression — distinct-token rule + veto blocks ceasefire/hostage hard news (C2 / adv-001):*
- T9b. `classifyFeelGood({title: 'Hostages reunite with families after Gaza ceasefire', link: '', description: 'Three hostages reunited with their families in Tel Aviv hours after the ceasefire took effect.'})` → `false`. Veto fires first (`ceasefire`, `hostages` both match expanded morphology in `HARD_NEWS_VETO_RE`). Even without the veto, distinct groups = `{reunite_group}` only (echo collapses) = 1 < 3.
- T9c. `classifyFeelGood({title: 'Refugees reunite with families they had not seen in years', link: '', description: 'UN brokered the meeting.'})` → `false`. Veto fires (`refugees` matches `refugees?`). Without veto, distinct = `{reunite_group}` = 1 (`years` alone without `years later` does not match `years_later`).
- T9d. `classifyFeelGood({title: 'Tribute to unsung witnesses who decades later testify against Milosevic', link: '', description: 'The tribunal heard from three survivors.'})` → `false`. Veto fires (`testify` and `tribunal`). Without veto, distinct = `{tribute_group, unsung, decades_later}` = 3 — would classify; the veto is what saves it. Documents accountability-news protection (veto is load-bearing here).
- T9e. `classifyFeelGood({title: 'Restored Klimt painting returned to family decades later', link: '', description: 'Found in attic by descendants of original owners.'})` → `false`. With `restored` removed from token list, distinct = `{decades_later}` = 1 < 3.

*Critical regression — `meet the` removal blocks diplomacy FP (adv-R2-004):*
- T9f. `classifyFeelGood({title: 'US officials meet the Russian delegation in Geneva', link: '', description: 'Both sides aim to revive memories of detente from decades later in the talks.'})` → `false`. With `meet the` removed, distinct = `{memories_group, decades_later}` = 2 < 3. (Pre-fix, distinct would have been `{meet_the, memories_group, decades_later}` = 3 → false positive.) Documents diplomacy-headline protection.

*Critical regression — expanded veto morphology catches active-conflict natural prose (adv-R2-003):*
- T9g. `classifyFeelGood({title: 'Iran retaliates after strike kills six near Hormuz', link: '', description: 'Tehran vowed years later to remember the attack; memories of past Gulf war remain bitter.'})` → `false`. Veto fires on `strike`, `kills`, AND `attack` (all in expanded morphology — `\bstrike[s]?\b`, `\bkills?\b`, `\battack[s]?\b`). Without expansion, none of these would fire (`\bairstrike\b` is too specific). Without veto, distinct = `{years_later, memories_group}` = 2 < 3 — would still pass, but the veto is the principal defense.
- T9h. `classifyFeelGood({title: 'Survivors recount decades later their memories of the Halabja massacre', link: '', description: 'Three witnesses describe the chemical attack on the Kurdish village.'})` → `false`. Veto fires on `massacre` AND `attack`. Without veto, distinct = `{decades_later, memories_group}` = 2 < 3 — saved by both veto AND threshold-3 backstop.
- T9i. `classifyFeelGood({title: 'Three militants bombed by drone near border', link: '', description: 'Casualties unclear; villagers wounded in crossfire.'})` → `false`. Veto fires on `militants`, `bombed`, `casualties`, AND `wounded` (4 veto hits — any one would suffice). No corroborating tokens present anyway; documents veto coverage even without feel-good tokens.

*Critical regression — single corroborating signal does NOT trip the threshold:*
- T10. `classifyFeelGood({title: "Veterans' painful memories of Iraq War surface in new testimony", link: '', description: 'Witnesses spoke before the Senate committee.'})` → `false`. Veto fires (`testimony` is in expanded morphology `testify|testimony|testifying`). Without veto, distinct = `{memories_group}` = 1 < 3.
- T11. `classifyFeelGood({title: 'Tribute to fallen soldiers held at Arlington', link: '', description: 'The defense secretary spoke at the ceremony.'})` → `false`. Distinct = `{tribute_group}` = 1 < 3 (no veto fires — `fallen soldiers` is not in the veto list; bare `dead` would veto if present).

*Critical regression — STRONG signal alone is enough even with no corroborating, but veto still overrides:*
- T12. `classifyFeelGood({title: 'Hard news headline with no soft tokens', link: 'https://example.com/lifestyle/topic', description: 'Body without any soft tokens.'})` → `true`. STRONG URL fires alone. NB: this story has no hard-news veto words. The 3-threshold doesn't apply on the STRONG path.
- T12b. `classifyFeelGood({title: 'Airstrike kills six in southern Lebanon', link: 'https://example.com/lifestyle/topic'})` → `false`. STRONG URL would fire, but veto fires FIRST (`airstrike`, `kills`). Documents that the veto absolutely precedes STRONG (SG-R2-002 / adv-R2-003 — R3a is unconditional).
- T12-strong-prefix-veto. `classifyFeelGood({title: 'Photos: aftermath of strike on civilian convoy', link: ''})` → `false`. STRONG headline prefix `Photos:` would fire, but veto on `strike` runs first. Documents veto overrides STRONG headline-prefix path too.

*Critical regression — `/travel/`, `/style/`, `/local/`, `/photos/` are CORROBORATING only (M5 + adv-R2-001):*
- T12c. `classifyFeelGood({title: 'X', link: 'https://example.com/travel/border-closure-update'})` → `false`. `/travel/` matches `CORROBORATING_PATHNAME_RE` → 1 distinct (`travel_pathname`). 1 < 3.
- T12d. `classifyFeelGood({title: 'Visit Vienna: vintage tram tour reunites old friends and evokes powerful connections', link: 'https://example.com/travel/article'})` → `true`. Distinct: `{reunite_group, vintage, powerful_connections, travel_pathname}` = 4 ≥ 3. Veto check: no veto words. Documents corroborating-pathname + token stacking.
- T12e. (adv-R2-001 demotion test for `/local/`) `classifyFeelGood({title: 'Building collapse leaves three dead in Cleveland', link: 'https://news.example.com/local/breaking-collapse-cleveland'})` → `false`. `/local/` is CORROBORATING now (1 distinct), but veto fires on `dead` (expanded morphology). Documents that the prior STRONG-`/local/` design would have silently dropped this hard-news piece.
- T12f. (adv-R2-001 demotion test for `/photos/`) `classifyFeelGood({title: 'Aftermath of strike on Tel Aviv', link: 'https://reuters.com/photos/tel-aviv-strike-aftermath'})` → `false`. `/photos/` is CORROBORATING now (1 distinct under `photos_pathname` group), but veto fires on `strike`. Documents wire-photo desk protection.
- T12g. (`/local/` + token stacking) `classifyFeelGood({title: 'Heartwarming vintage car parade reunites old neighborhood', link: 'https://news.example.com/local/feature'})` → `true`. Distinct: `{heartwarming, vintage, reunite_group, local_pathname}` = 4 ≥ 3. No veto. Documents legitimate CORROBORATING-pathname contribution after demotion.

*Critical regression — 3-distinct-token threshold boundary (adv-R2-003):*
- T-threshold-2. `classifyFeelGood({title: 'Vintage car show in Brooklyn', link: '', description: 'Memories of the 1960s flood Park Slope.'})` → `false`. Distinct = `{vintage, memories_group}` = 2 < 3. (Under the prior 2-threshold this would have classified — the raised threshold is what blocks it.)
- T-threshold-3. `classifyFeelGood({title: 'Vintage car show reunites Brooklyn neighbors', link: '', description: 'Memories of the 1960s flood Park Slope.'})` → `true`. Distinct = `{vintage, reunite_group, memories_group}` = 3 ≥ 3. Documents threshold boundary precisely.

*Edge case — missing / non-string inputs (defensive):*
- T13. `classifyFeelGood({})` → `false`. `classifyFeelGood({title: 42, link: null, description: undefined})` → `false`. Defensive guards (mirror `classifyOpinion`).

**Verification:**
- All ~22 scenarios above pass under `npx tsx --test tests/feelgood-classifier.test.mjs`.
- `npx biome check server/_shared/feelgood-classifier.js tests/feelgood-classifier.test.mjs` — clean.

---

- [ ] U2. **Wire ingest-time `isFeelGood` stamp on `story:track:v1`**

**Goal:** Have every row written by `parseRssXml` carry an `isFeelGood: boolean` field, persisted as `'1' | '0'` by `buildStoryTrackHsetFields`. Mirrors the `isOpinion` wiring exactly.

**Requirements:** R4.

**Dependencies:** U1.

**Files:**
- Modify: `server/worldmonitor/news/v1/list-feed-digest.ts`
- Test: `tests/news-rss-description-extract.test.mts` — asserts `ParsedItem` shape post-parse (file exists; both `isFeelGood: true` and `isFeelGood: false` fixtures added here).
- Test: `tests/news-story-track-description-persistence.test.mts` — asserts `buildStoryTrackHsetFields` writes the field (file exists; mirror what PR #3690 added for `isOpinion`).

**Approach:**
- Import `classifyFeelGood` from `'../../../_shared/feelgood-classifier.js'` (sibling of the existing `classifyOpinion` import at line 17).
- Add `isFeelGood: boolean;` to the `ParsedItem` type (sibling of `isOpinion` at line 163).
- In `parseRssXml`, sibling to line 478's `isOpinion: classifyOpinion({title, link, description})`, add `isFeelGood: classifyFeelGood({title, link, description})`.
- In `buildStoryTrackHsetFields` at line 911, add `'isFeelGood', item.isFeelGood ? '1' : '0'` as a sibling field.
- Update the comment block at lines 156-163 (which describes the opinion-classification flow) to also mention `isFeelGood` parity.

**Patterns to follow:**
- The exact diff PR #3690 applied for `isOpinion` (commit history `git log -p server/worldmonitor/news/v1/list-feed-digest.ts | grep isOpinion`). Mirror line-for-line.

**Test scenarios:**

- T14. *Happy path:* A `parseRssXml` test fixture for a clearly-feel-good RSS item (Veterans-style) → returned `ParsedItem` has `isFeelGood: true`. Sibling: a clearly-hard-news fixture → `isFeelGood: false`.
- T15. *Persistence:* `buildStoryTrackHsetFields({…, isFeelGood: true})` includes `'isFeelGood', '1'` in the output array. With `isFeelGood: false`, includes `'isFeelGood', '0'`.
- T16. *Backward-compat in tests:* update any existing `baseItem`-style fixture that's shared across `parseRssXml` tests to include `isFeelGood: false` so post-change tests don't break on missing-field assertions (mirror what PR #3690 needed to do for `isOpinion`).

**Verification:**
- `npx tsx --test tests/news-rss-description-extract.test.mts tests/news-story-track-description-persistence.test.mts` — all green, new fixtures + existing tests pass.
- A `git diff` review confirms the changes to `list-feed-digest.ts` are textually parallel to the `isOpinion` lines.

---

- [ ] U3. **Wire read-time `isFeelGood` filter in `buildDigest` + drop telemetry**

**Goal:** `buildDigest` drops `story:track:v1` rows where `track.isFeelGood === '1'`, re-classifies stamp-missing residue rows from persisted `title/link/description`, increments a local `droppedFeelGood` counter, and emits a separate conditional `console.log` line — **exact shape derived from the actual opinion log at `scripts/seed-digest-notifications.mjs:550-556` at implementation time**, mirroring whatever suffix that line carries (today the opinion line emits `[digest] buildDigest opinion filter dropped ${N} op-ed/analysis item(s) from the pool (variant=… lang=… sensitivity=…)`; the feel-good log mirrors the same `from the pool (variant=… lang=… sensitivity=…)` shape with content type `feel-good/lifestyle item(s)`) — when `droppedFeelGood > 0`. Per FEAS-001, do NOT invent a `(stamped=A, residue=B)` breakdown that the opinion mirror does not emit; mirror what is actually there.

**Requirements:** R5, R6.

**Dependencies:** U1 (uses `classifyFeelGood` for residue re-classification). **U2 MUST ship before U3** — without U2, every row is "residue" and U3's residue-catch loop classifies every row at read time on every cron tick (perf regression). U2 ensures new rows carry the stamp so the residue-catch is bounded to the rollout window only.

**Files:**
- Modify: `scripts/seed-digest-notifications.mjs`
- Test (greenfield): `tests/digest-buildDigest-feelgood-filter.test.mjs` — new test file dedicated to U3, mirroring the pattern of `tests/digest-no-reclassify.test.mjs` (which is the closest neighbour that tests `buildDigest` behaviour). Keeping U3's tests in their own file avoids tangling with the opinion-filter tests and makes the feel-good telemetry-shape assertions easy to locate.

**Approach:**
- Import `classifyFeelGood` from `'../server/_shared/feelgood-classifier.js'` (sibling of the existing `classifyOpinion` import at line 33).
- Add a `let droppedFeelGood = 0;` counter declaration inside `buildDigest` at the same scope as `let droppedOpinion = 0;` (currently at line 488).
- Insert a feel-good filter block immediately AFTER the existing opinion filter block (currently at lines 500-520) and BEFORE the `derivePhase`/`matchesSensitivity` checks. The structure is identical:
  ```
  const stampedFeelGood = track.isFeelGood === '1';
  const feelGoodStampMissing = typeof track.isFeelGood !== 'string' || track.isFeelGood.length === 0;
  if (
    stampedFeelGood ||
    (feelGoodStampMissing && classifyFeelGood({
      title: track.title,
      link: track.link ?? '',
      description: typeof track.description === 'string' ? track.description : '',
    }))
  ) {
    droppedFeelGood++;
    continue;
  }
  ```
  *(Directional sketch, not implementation specification — match the existing opinion-block style exactly. Per FEAS-001, the opinion block does NOT track stamped/residue sub-counters — do NOT invent them; the feel-good block stays a single `droppedFeelGood` counter mirroring `droppedOpinion`.)*
- Add a conditional `console.log` line immediately after the buildDigest loop body, sibling to the existing `if (droppedOpinion > 0) console.log('[digest] buildDigest opinion filter dropped …')` at lines 550-556:
  ```
  if (droppedFeelGood > 0) {
    console.log(`[digest] buildDigest feel-good filter dropped ${droppedFeelGood} item(s)`);
  }
  ```
  *(Match the exact log-line shape and prefix the opinion line at `:550-556` actually uses today — including the `from the pool (variant=… lang=… sensitivity=…)` suffix. The opinion line has NO stamped/residue breakdown; do not invent one for feel-good. Read the opinion line at implementation time and mirror its format byte-for-byte.)*
- **Do NOT add a `feelGood` field to `dropStats`** and **do NOT modify the per-attempt `[digest] brief filter drops` log line** at `:1654-1668`. Neither carries `dropped_opinion` today — feasibility review C1 confirmed the original plan misread that line. The conditional `buildDigest` log is the only telemetry surface, sibling to opinion's.
- **Asymmetry comment (M6 / adv-005):** add a brief implementation comment above the feel-good filter block noting that a row stamped both `isOpinion: '1'` AND `isFeelGood: '1'` increments only `droppedOpinion` (the opinion filter `continue`s first). The `droppedFeelGood` counter is therefore "rows dropped by the feel-good filter, after the opinion filter already ran" — not "all feel-good content seen." Future operators reading the two counters need this context to avoid concluding the feel-good filter is "underperforming" relative to opinion when the truth is overlap-by-construction.

**Patterns to follow:**
- Lines 488 + 500-520 + 550-556 of `scripts/seed-digest-notifications.mjs` — the opinion counter declaration, filter block, and conditional log. Replicate structurally; only the field name and counter rename change.

**Test scenarios:**

*Happy path — stamped row drops:*
- T17. `buildDigest` over a track-rows fixture where one row has `isFeelGood: '1'` → that row is excluded from the returned stories array. Verify via the conditional log: stdout contains `[digest] buildDigest feel-good filter dropped 1 item(s)`.

*Residue path — stamp-missing row re-classified:*
- T18. `buildDigest` over a fixture where one row has NO `isFeelGood` field (residue, pre-stamp ingest) AND `classifyFeelGood({title, link, description})` would classify it as feel-good → row is excluded, conditional log fires with count 1.
- T19. Stamp-missing row that does NOT classify as feel-good → row passes through, conditional log does NOT fire (count stays 0).

*Critical regression — opinion + feel-good filters are independent (and asymmetric per M6):*
- T20. Fixture row with `isOpinion: '1'` and no `isFeelGood` field → dropped via opinion path; opinion conditional log fires, feel-good conditional log does NOT fire. Sibling: row with `isFeelGood: '1'` and no `isOpinion` field → feel-good conditional log fires, opinion log does NOT.
- T20b. *Asymmetry case:* row stamped BOTH `isOpinion: '1'` AND `isFeelGood: '1'` → opinion filter fires first and `continue`s; opinion conditional log fires with count 1, feel-good conditional log does NOT fire (count stays 0). Documents M6 — confirms the asymmetry is intentional and locked.

*Telemetry — conditional log shape (not the per-attempt line):*
- T21. The `console.log` emission contains the exact prefix `[digest] buildDigest feel-good filter dropped` and the correct count. (Capture stdout in the test.) Sibling test asserts the per-attempt `[digest] brief filter drops` log line at `:1654-1668` does NOT carry a `dropped_feelgood=` field — that surface is intentionally unchanged (mirrors what `dropped_opinion` does NOT do).

**Verification:**
- `npx tsx --test tests/digest-buildDigest-feelgood-filter.test.mjs tests/digest-no-reclassify.test.mjs tests/digest-orchestration-helpers.test.mjs` — green.
- Broader brief sweep `npx tsx --test tests/brief-from-digest-stories.test.mjs tests/brief-llm.test.mjs tests/seed-envelope-parity.test.mjs` — no regressions.
- Manual `grep -n 'droppedFeelGood\|feel-good filter dropped' scripts/seed-digest-notifications.mjs` returns the counter declaration, the filter-block increment, and the conditional log — and ONLY those three sites.

---

- [ ] U4. **Dockerfile coverage for the new classifier file**

**Goal:** `Dockerfile.digest-notifications` copies `server/_shared/feelgood-classifier.js` and `.d.ts` into the Railway image so `scripts/seed-digest-notifications.mjs`'s import resolves at runtime. Mirrors PR #3690's Dockerfile fix.

**Requirements:** R4 / R5 (without this the digest cron crashes at startup with `ERR_MODULE_NOT_FOUND`).

**Dependencies:** U1, U2, U3 (the COPY only matters once the file exists and is imported).

**Files:**
- Modify: `Dockerfile.digest-notifications`
- Test: `tests/dockerfile-digest-notifications-imports.test.mjs` — the transitive-import-closure test that caught the missing `opinion-classifier.js` COPY in PR #3690 will catch this one too if forgotten. Build correctness in by adding the COPY now.

**Approach:**
- Add `COPY server/_shared/feelgood-classifier.js server/_shared/feelgood-classifier.d.ts ./server/_shared/` as a sibling to the existing line 88 opinion-classifier COPY. Same target directory, same flags.

**Patterns to follow:**
- Line 88 of `Dockerfile.digest-notifications` — exact pattern to mirror.

**Test scenarios:**
- T22. `tests/dockerfile-digest-notifications-imports.test.mjs` runs and reports zero unresolved transitive imports. (The test scans the closure of `scripts/seed-digest-notifications.mjs` imports and verifies every file is copied. If U4 is skipped, this test fails with a clear error pointing at `feelgood-classifier.js`.)

**Verification:**
- `npx tsx --test tests/dockerfile-digest-notifications-imports.test.mjs` — green.
- Manual: `grep feelgood Dockerfile.digest-notifications` returns the new COPY line.

---

## System-Wide Impact

- **Interaction graph:** New classifier is pure; no callbacks, no async. Ingest stamping (`parseRssXml` → `buildStoryTrackHsetFields` → Redis HSET) gains one field. `buildDigest` gains one filter block. No other surface reads or writes `isFeelGood`.
- **Error propagation:** Classifier never throws (defensive `typeof` guards mirror `classifyOpinion`). Ingest path can't be broken by a malformed RSS item. `buildDigest` filter logic is identical in shape to the opinion filter, which has shipped cleanly.
- **State lifecycle risks:** `story:track:v1` rows ingested before this PR ships have NO `isFeelGood` field. Residue catch (U3) re-classifies from persisted fields, so the filter is effective immediately on rollout — not only after the 48h TTL window. Mirrors the post-rollout behaviour the `isOpinion` residue-catch was specifically designed for.
- **API surface parity:** No external API change. The Redis row schema gains a field but HSET is open — no schema migration needed, no consumer break.
- **Integration coverage:** U3's tests (T20) explicitly verify opinion and feel-good filters are independent (one row can be stamped both, or only one, or neither, and the counters move correctly). U4's Dockerfile test (T22) is the integration sentinel for the runtime import resolution.
- **Unchanged invariants:** `classifyOpinion` and all opinion-classifier signal lists are not touched. The brief envelope contract, the synthesis prompt, `filterTopStories`, and `orderBriefCandidates` are not touched. The feel-good filter sits parallel to the opinion filter at the same buildDigest stage; everything downstream of buildDigest is unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| CORROBORATING token list false-positives on a hard-news headline that legitimately contains 2+ feel-good tokens (e.g. "Veterans reunite to tribute fallen comrades after combat memories surface") | The 2-signal threshold is the structural backstop; the token list is the surface. T10 and T11 lock the single-signal-doesn't-trip-it rule. If production telemetry shows a real false-positive class, tighten the token list (remove the ambiguous token) or add a "hard-news context" override (e.g. weight tokens lower when source is a known wire). Conservative starting list keeps risk low. |
| Place-name signal missing means the filter misses non-token-rich local-color pieces (e.g. "Iowa town celebrates centennial" with no `reunite`/`vintage`/`memories`-class tokens) | Documented in Scope Boundaries; deferred to v2 if production shows it. The Veterans anchor case is caught without place-name. |
| Opinion + feel-good signal lists drift over time and the two classifiers' boundary becomes unclear | Two independent classifiers, two independent test files, two independent signal lists is itself the mitigation — each evolves on its own evidence. The integration test (T20) verifies the two filters are independent. If a story qualifies as BOTH opinion AND feel-good (e.g. a columnist's nostalgia essay), both filters drop it independently and the counters reflect that — no double-counting concern since each is just a `continue`. |
| The transitive-imports Dockerfile test catches the missing COPY in CI but not before someone burns time on a broken Railway deploy | U4 builds the COPY in BEFORE the U1-U3 imports go live in the cron path. If implementers follow the U1→U2→U3→U4 ordering, the test passes by construction. The test exists precisely as the safety net for this class. |
| Sibling stamps `isOpinion` and `isFeelGood` accumulate on `story:track:v1` and the row gets sprawling over time | Two boolean fields is negligible. The pattern is "structural backstops as siblings" — if a future classifier C3 is needed, it follows the same pattern. Open-ended growth is bounded by editorial categories; not unbounded. |
| Token list overlap with the existing `HEADLINE_PREFIX_RE` (which strips `photos`/`watch`/`gallery` as prefixes) — classifyFeelGood runs on the ORIGINAL title (with prefix intact), but `stripHeadlinePrefix` would remove the prefix BEFORE the title is shown | The classifier runs at INGEST on the raw RSS `<title>` (pre-strip), so it sees `Photos:` etc. and classifies correctly. Read-path classification (residue catch in U3) also runs on the persisted raw `track.title`, which is also pre-strip. No conflict. |

---

## Documentation / Operational Notes

- No user-facing documentation impact.
- **Operational rollout:** ship in U1→U2→U3→U4 order to keep the Dockerfile coverage aligned with the imports. The cron Dockerfile is rebuilt on every merge to main per Railway autodeploy; the transitive-imports test gates the merge before that.
- **Post-deploy verification:** spot-check the next 3-5 production briefs for (a) the previously-stripped Veterans-style cards being absent, (b) no real events disappearing that shouldn't, (c) the dedicated `buildDigest` conditional log line `[digest] buildDigest feel-good filter dropped N item(s)` appearing on most cron ticks (the line is emitted ONLY when `droppedFeelGood > 0`; absence of the line is ambiguous — see telemetry-watch note below). The per-attempt `[digest] brief filter drops` line at `:1654-1668` does NOT carry `dropped_feelgood=` and never will (per R6 / KTD / U3 — sibling to how `dropped_opinion` is also not on that line).
- **First-week telemetry watch:** `grep '[digest] buildDigest feel-good filter dropped' production-log` to find drops; review the cited stories. If false positives appear, tighten the CORROBORATING token list or expand the hard-news veto (R3a). If the conditional log line never fires across multiple cron ticks, do NOT conclude "no feel-good content" — the line is silent at count zero. Pair the grep with a count of `[digest] buildDigest opinion filter dropped` for the same window to sanity-check the cron is running.
- **Operator note — opinion+feel-good counter asymmetry (M6 / adv-005 / adv-residue):** a row matched by BOTH classifiers — whether stamped, residue-classified, or one-of-each — increments only the opinion counter (opinion filter runs first and `continue`s). `droppedFeelGood = N` should be read as "rows the feel-good filter dropped *after* opinion had already passed on them in this run," NOT "all feel-good content seen this run." A low `droppedFeelGood` relative to `droppedOpinion` is expected when overlap (columnist-nostalgia-essay, op-ed-with-tribute-framing) is heavy; do NOT respond by broadening the feel-good token list — that creates real false positives in the conservative-by-design posture. This applies equally during the 48h residue-rollout window when most rows hit the residue path.

---

## Sources & References

- Origin: this session's May 17 brief Definition-of-Done verification, item #2 ("Veterans reunite with vintage warplanes" feel-good piece ranked HIGH in a serious intel brief).
- PR #3690 — opinion-classifier (`classifyOpinion`) — the architectural template this plan mirrors. Same shape: shared classifier + ingest stamp + buildDigest filter + Dockerfile + tests.
- `server/_shared/opinion-classifier.js` and `tests/opinion-classifier.test.mjs` — the pattern files for U1.
- `server/worldmonitor/news/v1/list-feed-digest.ts:478, 911` — the pattern lines for U2.
- `scripts/seed-digest-notifications.mjs:500-520` — the pattern block for U3.
- `Dockerfile.digest-notifications:88` — the pattern line for U4.
- `tests/dockerfile-digest-notifications-imports.test.mjs` — the transitive-imports sentinel that catches the U4-omission failure mode.
