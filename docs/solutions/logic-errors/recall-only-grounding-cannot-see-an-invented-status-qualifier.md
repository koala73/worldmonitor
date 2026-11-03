---
title: A recall-only grounding gate cannot see an invented status qualifier
date: 2026-09-21
last_updated: 2026-09-24
category: logic-errors
module: shared/brief-llm-core.js, scripts/lib/brief-llm.mjs
problem_type: logic_error
component: brief_system
severity: high
symptoms:
  - "The 2026-09-20 08:11 UTC email brief called the sitting US president \"former President Trump\" in the executive-summary lead, a Diplomacy teaser, and the gCaptain story card"
  - "A subscriber replied to the brief with \"Former President Trump?\"; the source headline said only \"Trump\" and the article body said \"U.S. President Trump\""
  - "Repro at the production model/temperature: headline-only prompts produced the qualifier in 6/6 digest and 6/6 description samples, and a real-lede context line only cut it to 3/6 and 5/6"
  - "Both existing gates passed the string, checkLeadGrounding because \"Trump\" is an anchor and recall-only, validateNoHallucinatedProperNouns because TITLE_PREFIX_STOP consumes \"Former\"/\"President\" and it was never wired into the email brief at all"
  - "Prompt-only bans were already proven inert: 24/24 digest samples opened sentence two with a banned stitching phrase variant"
root_cause: missing_validation
resolution_type: code_fix
related_components: [email_processing, background_job, testing_framework]
tags: [llm-hallucination, output-validation, status-qualifier, brief-digest, grounding-precision, regex-case-folding, prompt-only-fix, cache-revalidation]
---

# A recall-only grounding gate cannot see an invented status qualifier

## Problem

The WorldMonitor email brief sent on 2026-09-20 called the sitting US president "former President Trump" in three places. A reader replied to the brief with "Former President Trump?".

## Symptoms

Three shipped strings carried the fabricated qualifier.

- The executive-summary lead read "This development comes as former President Trump returns to the UN…"
- The "Diplomacy" thread teaser read "Former President Trump re-engages with the UN…"
- The gCaptain story card read "Former President Trump returned to the UN General Assembly…"

The source never said it. The story headline was "Trump Returns to UN as Iran War Spreads Across Shipping Chokepoints". The gCaptain article body says "U.S. President Trump" and never says "former".

A throwaway session harness, not committed, imported the shipping prompt builders `buildDigestPrompt` and `buildStoryDescriptionPrompt` by absolute path and called OpenRouter with the production model, temperature 0.4, and the production `max_tokens`, N=6 per arm. In the production prompt shape, which feeds the model only a short hash, the threat level, headline, category, country, and source per story and never the article body (`scripts/lib/brief-llm.mjs:536-557`), the digest said "former (US) President Trump" in 6 of 6 samples and the description said "Former President Trump" in 6 of 6. These are session measurements, not production telemetry.

## What Didn't Work

**Prompt-only instructions.** The digest system prompt already bans stitching phrases in prose, listing "this comes as", "this declaration comes as", and "this announcement comes as" (`scripts/lib/brief-llm.mjs:469-471`). Every one of the 24 digest samples in the session harness opened sentence two with "This development comes as" or "This development occurs as". A banned-phrase instruction that the model ignores 24 times out of 24 is not a control. Adding one more instruction for tenure qualifiers would have bought nothing. The stitching-phrase gap is filed as #8438.

**Feeding the RSS description into the digest prompt.** Measured, not assumed. With a context line drawn from an article paragraph that does not mention Trump, the digest still fabricated in 5 of 6 samples and the description in 6 of 6. With the article's real lede, "When President Donald Trump addressed the United Nations a year ago…", the digest fell to 3 of 6 and the description to 5 of 6. That is a partial reduction, not a fix. It also changes cache-key material and widens the prompt injection surface, so it was dropped rather than shipped as belt and suspenders.

**The `i` flag paired with `\p{Lu}`.** The first validator regex matched the person's name with `\p{Lu}` while carrying the `i` flag. Under `i`, `\p{Lu}` also matches lowercase, so "Former officials said the deal was near." and "Former officials met." both matched and were reported as fabrications. The shipped pattern drops the flag and case-folds the qualifier and title words by construction with an `anyCase` helper, leaving the name strictly capitalized (`shared/brief-llm-core.js:1126-1132`).

**The proposed `/iu` plus post-check reshape.** A review pass proposed restoring the `i` flag and filtering out lowercase names in a post-check. Backtracking refutes it. Without `i`, the engine backtracks past a lowercase token to reach a real capitalized name, so "Former official adviser John Smith warned of escalation." is still flagged. With `i`, the first match eats the lowercase token, the post-check discards that match, and the real name behind it is never examined. The behavior is locked by a test at `tests/brief-llm-core.test.mjs:960`.

**A bad prototype fixture.** The prototype's "with title" arm ran twice against text that was not the article. The `<p>` regex returned undefined on the first run and a `find()` fallback returned navigation boilerplate on the second. Both sets of numbers were read before anyone eyeballed the excerpt.

**Mirroring only half the pair.** The edit touched `shared/brief-llm-core.js` and `shared/brief-llm-core.d.ts` but mirrored only the `.js` into `scripts/shared/`. The byte-identical contract test at `tests/brief-contract.test.mjs:266`, which asserts both the `.js` and the `.d.ts` pair, and the sync suite at `tests/edge-functions.test.mjs:49` went red on the missing `scripts/shared/brief-llm-core.d.ts`.

**Asserting the model from a code read.** The chain pins `google/gemini-2.5-flash` on the `openrouter` entry (`scripts/lib/llm-chain.cjs:60`) and the brief allow-lists that provider alone (`scripts/lib/brief-llm.mjs:130`), which makes the model code-determined. The same session also asserted the why-matters cache version as v5 from a code read when it is v6 on the cron and v11 on the edge. The correction matters because Axiom cannot arbitrate. The Railway service that runs the digest is `digest-notifications` (`scripts/railway-services.json:187-190`). A `railway variables -s digest-notifications` read during the session, recorded in #8440, showed `USAGE_TELEMETRY` and `AXIOM_API_TOKEN` unset, so `wm_api_usage` holds zero `llm_call` rows for the `brief-digest-cron` and `brief-description-cron` stages. The `brief-why-matters-gemini` rows that do exist come from the Vercel edge route, not the cron. Missing telemetry is filed as #8440.

## Solution

Opened in #8437, unmerged as of this writing.

**The validator.** `validateNoHallucinatedStatusQualifiers(summary, groundText)` is a new export in `shared/brief-llm-core.js:1155`, mirrored byte-identically into `scripts/shared/brief-llm-core.js` and declared in both `.d.ts` files (`shared/brief-llm-core.d.ts:65-68`). It returns `{ ok: true }` or `{ ok: false, hallucinated: string[] }`. It flags a tenure qualifier attached to a titled, named person unless the ground text carries that qualifier's class and that name. Malformed input returns `ok: true`, matching the sibling validators `validateNoHallucinatedProperNouns` and `validateNoHallucinatedFacts` in their default mode.

The qualifier table groups synonyms into classes (`shared/brief-llm-core.js:1113-1118`).

```js
const STATUS_QUALIFIER_CLASSES = [
  ['former', 'ex', 'erstwhile', 'one-time', 'onetime', 'then-', 'outgoing', 'retired'],
  ['acting', 'interim', 'caretaker'],
  ['incoming'],
  ['late'],
];
```

The pattern is a qualifier, then up to three bridge tokens, then a title word from `PERSON_TITLE_WORDS`, then an optional `of`, `the`, `for`, `to`, or `and`, then a capitalized name (`shared/brief-llm-core.js:1129-1132`). `then-` matches only in its hyphenated form. Ground text may be one string or one string per pool story. With an array, a class word and the name must both appear in the same entry (`shared/brief-llm-core.js:1166-1168`), so a qualifier borrowed from an unrelated story does not license a claim. Both sides run through `normalizeDottedAcronyms` (`shared/brief-llm-core.js:524`), so "U.S." grounds "US".

**Wiring point one, the digest.** `validateDigestProseShape` previously ran the grounding gate alone.

```js
  if (Array.isArray(stories) && stories.length > 0
      && !checkLeadGrounding({ lead, threads }, stories, MAX_STORIES_PER_USER)) {
    return null;
  }
```

It now repairs the lead, filters teasers, and re-grounds what survives (`scripts/lib/brief-llm.mjs:660-677`).

```js
  if (Array.isArray(stories) && stories.length > 0) {
    const ground = stories.slice(0, MAX_STORIES_PER_USER).map(storyGroundText);
    const repaired = repairLeadStatusQualifiers(lead, ground);
    if (repaired.dropped.length > 0) {
      console.warn(`[brief-llm] status-qualifier gate: dropped lead sentence(s) (${repaired.dropped.join(' | ')})`);
    }
    lead = repaired.lead;
    if (lead.length < 40) return null;
    threads = threads.filter((t) => {
      const check = validateNoHallucinatedStatusQualifiers(t.teaser, ground);
      if (!check.ok) console.warn(`[brief-llm] status-qualifier gate: dropped teaser (${check.hallucinated.join(' | ')})`);
      return check.ok;
    });
    if (threads.length < 1) return null;
    const groundingOpts = repaired.dropped.length > 0 ? { combinedThreshold: 1 } : {};
    if (!checkLeadGrounding({ lead, threads }, stories, MAX_STORIES_PER_USER, groundingOpts)) return null;
  }
```

**Wiring point two, the story card.** `parseStoryDescription` took only the headline.

```js
export function parseStoryDescription(text, headline) {
```

It now takes the RSS body as ground and rejects a failing sentence (`scripts/lib/brief-llm.mjs:340` and `scripts/lib/brief-llm.mjs:354-359`).

```js
export function parseStoryDescription(text, headline, groundText) {
```

```js
    const ground = [headline, groundText].filter((x) => typeof x === 'string' && x.length > 0).join('\n');
    const check = validateNoHallucinatedStatusQualifiers(sentence, ground);
    if (!check.ok) {
      console.warn(`[brief-llm] status-qualifier gate: rejected description (${check.hallucinated.join(' | ')})`);
      return null;
    }
```

`generateStoryDescription` passes `story.description` on the fresh path (`scripts/lib/brief-llm.mjs:417`) and on the cache-hit path (`scripts/lib/brief-llm.mjs:396`).

**Sentence-drop repair, not whole-digest rejection.** An early draft rejected the entire digest when the lead failed. Reading the fallback ladder changed that. `runSynthesisWithFallback` (`scripts/lib/digest-orchestration-helpers.mjs:194`) retries L2 on the same model with a capped pool, which is likely to fabricate again, and L3 returns a null synthesis that degrades the brief to a headline stub. So the repair drops only the failing sentences. `repairLeadStatusQualifiers` checks the whole lead first, splits on `LEAD_SENTENCE_SPLIT = /(?<=(?<!\b\p{Lu})[.!?])\s+/u` when it fails, keeps the sentences that pass, and returns an empty lead if the joined result still fails (`scripts/lib/brief-llm.mjs:689-702`). An empty or under-40-character lead rejects. When sentences were dropped, the shortened lead is re-grounded with `{ combinedThreshold: 1 }`, mirroring the dashboard brief's repair path (`scripts/_insights-brief.mjs:605`). Requirement 1 of `checkLeadGrounding` still applies unconditionally, so a shortened lead with no corpus anchor at all is still rejected.

**No cache version bump.** Both cache-hit paths already revalidate before returning. The digest hit runs `validateDigestProseShape(hit, stories)` (`scripts/lib/brief-llm.mjs:854`) and the description hit runs `parseStoryDescription(hit, …)` (`scripts/lib/brief-llm.mjs:396`). A poisoned row written before the fix is therefore rejected on read and regenerated, which is what a version bump would have bought at the cost of discarding every clean row. The test `generateStoryDescription revalidates a cached "Former President" row and re-LLMs it` (`tests/brief-llm.test.mjs:2099`) pins that behavior.

### Widening to more consumers (#8441, 2026-09-24)

PR #8573 runs the validator at three more publish gates, each with the semantics that gate already had. A World Brief lead sentence is dropped, and the brief is rejected as `lead-status-qualifier` when nothing survives. A World Brief story line falls back to its headline. The single-headline fallback publishes the headline. The pre-migration branch of `briefCitationGroundingGap` withholds the whole country brief. #8548 had already covered the evidence-format country brief and its crawlable branch.

The reproduction split by surface. The dashboard synthesis and single-headline prompts produced 0 ungrounded qualifiers across 42 synthesis drafts and 42 single-headline drafts. The models were deepseek-v4-flash, gemini-2.5-flash, llama-3.1-8b and gpt-oss-20b, on the live 2026-09-24 pool and the Sep 20 headlines. That prompt forbids adding context outright, which the email prompt does not. A committed snapshot did reproduce it: 1 of 120 frozen briefs in `docs/snapshots/crawlable-live-pulse-2026-09-19.json` says "former president Laurent Gbagbo" against a source that says only "proche de Laurent Gbagbo".

Widening the validator's reach exposed 2 defects that the single email consumer never hit. Review caught both.

**The bridge accepted any words.** Between the qualifier and the title, the pattern allowed up to 3 arbitrary words, so ordinary phrasing read as a qualified title: "Former officials said President Trump", "Late on Tuesday President Trump", "In a late-night ceremony President Trump", "Interim results show President Trump". On the email brief that cost an occasional sentence. At the new gates it would drop lead sentences, substitute story lines, and withhold country briefs over correct text. A bridge word must now be one of:

- a capitalized word that is not a weekday or month ("US", "Brazilian", "White House")
- an office modifier ("deputy", "national security")
- a title word ("official adviser")

Any other word ends the match (`BRIDGE_WORD_RE_SOURCE` in `shared/brief-llm-core.js`).

**The unit splitter hid the span.** The World Brief lead is validated per sentence, and its split fails closed at a dotted acronym before a capital (#5947). "…as former U.S. President Trump welcomed Xi [1]." therefore became "…as former U.S." and "President Trump welcomed…". No unit held qualifier, title and name together, and the fabricated qualifier published verbatim. The fix: when a unit ends at a dotted acronym, the next unit's qualifier check reads both units together against both units' cited stories, and a failure drops both halves (`scripts/_insights-brief.mjs`, `acronymHead`). A validator that matches a span is only as good as the units it is handed.

## Why This Works

Both existing gates were blind here by design, not by accident.

`checkLeadGrounding` (`shared/brief-llm-core.js:1374`) is a recall check. It asks whether the lead shares at least one anchor token with a story headline, skips entirely when the pool yields no anchors, and never asks whether every claim in the lead is supported. It also cannot see the qualifier, because `GROUNDING_ANCHOR_STOPWORDS` (`shared/brief-llm-core.js:1239`) contains `former`, `acting`, `president`, `prime`, and `minister`, added in PR #3667 precisely so an honorific shared between two unrelated headlines cannot act as an anchor. "Trump" is a real anchor, so the fabricated lead passed on the correct part of itself.

`validateNoHallucinatedProperNouns` (`shared/brief-llm-core.js:847`) never saw the qualifier either. Its extractor `extractProperNounSequencesWithMeta` (`shared/brief-llm-core.js:574`) has a title-prefix consume branch (`shared/brief-llm-core.js:612` and `shared/brief-llm-core.js:628-631`) that swallows any token in `TITLE_PREFIX_STOP` without registering it, and that list holds `President`, `Former`, `Ex`, `Acting`, and `Interim` (`shared/brief-llm-core.js:328-337`). "former President Trump" therefore extracts as `['trump']`, which the headline grounds. PR #3836's own test plan states the outcome as a pass. The validator is also not wired into the email brief at all. Its callers are `scripts/_insights-brief.mjs`, `scripts/seed-insights.mjs`, `scripts/crawlable-developments.mjs`, and `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts`. Extending it to those consumers is filed as #8441. `briefDateLine` (`shared/brief-llm-core.js:52`) only forbids contradictory years and dates, and `buildStoryDescriptionPrompt` does not append it at all.

A claim-level precision check is the right shape because the fabrication was not a new entity. Every proper noun in the shipped lead was real and grounded. What the model invented was a predicate attached to a real name, and a name-level recall check can never see a predicate. The qualifier plus title plus name pattern is narrow enough to keep false positives rare, once the words between qualifier and title are restricted to office words (see the #8441 section above; the first version was not), and broad enough to cover the whole class, since "acting Prime Minister Vance" and "the late President Carter" fail the same way and are equally wrong.

The classes exist so that grounding is not a bag of words. "ex-President Trump" in the source licenses "former President Trump" in the summary, because both words sit in the same class. "former" in the source never licenses "acting" in the summary, because a source saying a person used to hold an office says nothing about that person holding it provisionally now. Matching per class keeps synonym paraphrase legal and keeps substitution illegal.

The same class had already appeared on a sibling surface (session history). Round 7 of the GEO audit on 2026-09-07 filed #7865 for country-page briefs naming real, correctly spelled entities that the page's own sources never mentioned, measured at 20 of 50 bullets. The fix there was also a post-generation validator, and it prints a visible abstention line when nothing grounded survives. The email brief drops the failing sentence and logs a warning instead; whether a reader-facing disclosure belongs in an email is an open choice, not a settled one.

## Prevention

- Work test-first and use the captured strings as fixtures. The regression commit landed before the fix commit and went red with "validate is not a function". The three shipped strings became the fixtures in `tests/brief-llm-core.test.mjs` and `tests/brief-llm.test.mjs`. A fabrication that shipped to a reader is the highest-value fixture available, so capture it verbatim before touching code.
- Build a same-surface harness that replays real model outputs through the shipping parsers. The session pushed 24 real digest outputs and 24 real description outputs, four arms of six including the discarded bad-fixture arm, through `parseDigestProse` and `parseStoryDescription` against the Sep 20 pool. 14 digests parsed, 11 of those carried "former", all 11 shipped repaired, and none leaked. 23 of 24 descriptions carried "former", all 23 fell back to the headline, and none leaked. The same replay surfaced a separate defect, since 10 digests failed `JSON.parse` before any gate ran, 8 of them because the greeting was emitted outside the JSON. That is filed as #8439. Unit tests alone would have missed it.
- Mirror both `.js` and `.d.ts` under `scripts/shared`. The byte-identical contract test in `tests/brief-contract.test.mjs` and the sync suite in `tests/edge-functions.test.mjs` both fail on a half-mirror. Copy the pair in one step.
- Never pair `\p{Lu}` with the `i` flag. Under `i` the uppercase property matches lowercase, which silently turns a capitalization check into no check at all. Case-fold the words that should be case-insensitive by construction and leave the ones that must be capitalized alone.
- Treat stopword lists and title-prefix lists as declared blind spots. Every entry in `GROUNDING_ANCHOR_STOPWORDS` and `TITLE_PREFIX_STOP` is a word the surrounding gate has agreed not to see. When a new fabrication class appears, enumerate those lists first and ask whether the fabricated words are on them. Here they were, on both.
- Check `railway variables` before treating Axiom silence as evidence. A cron whose service lacks `USAGE_TELEMETRY` and `AXIOM_API_TOKEN` produces zero rows whether it runs or not. When telemetry is absent, reproduce through the shipping prompt builders instead of theorizing from a code read.
- Ask what dimension the gate still does not look at (session history). The country-page root cause logged on 2026-09-08 was a citation index that proved a marker existed, not that the source supported the claim. This gate looked at names, not predicates. The next class will live in whatever the new gate ignores.
- Replay a new prose gate over a recent corpus and measure the drop rate before shipping (session history). The country-page gate, replayed against an earlier snapshot, would have left zero published briefs. Here the replay over 24 real outputs showed repairs and fallbacks, not wholesale loss.
- Before widening a shared validator to new publish gates, run it against ordinary sentences it must accept. A validator's false positives stay cheap only while its consumers are few. The bridge flaw in the #8441 section shipped in #8437 and cost almost nothing on the email brief. At a gate that withholds a whole country brief, the same flaw is expensive. The must-accept fixtures now live in `tests/brief-llm-core.test.mjs`.
- When a gate validates a span, test it on text that crosses the boundary of each unit the caller splits into. The World Brief splitter and the email splitter cut at different places, so each caller needs its own boundary fixture.
- Reproduce on each surface separately. The same model and failure class gave 6 of 6 on the email prompt and 0 of 84 on the dashboard prompt. The frozen crawlable snapshot was the only place the failure appeared outside email.

## Related Issues

- PR #8573 carries the #8441 widening and both validator fixes (open, unmerged as of this writing). #8571 records why the 2 lead splitters cannot be unified, and a related lead-repair defect. #8570 is the dead free OpenRouter backup model found during that reproduction.
- PR #8437 carries the original fix. Follow-ups from the same investigation: #8438 (banned stitching phrases are prompt-only), #8439 (greeting emitted outside the JSON loses leads to `JSON.parse`), #8440 (`digest-notifications` emits no `llm_call` telemetry), #8441 (extend this validator to the dashboard, crawlable, and country-brief consumers, and unify the two lead-sentence splitters).
- PR #3667 introduced `checkLeadGrounding` and the title stopwords; PR #3836 introduced `validateNoHallucinatedProperNouns` and `TITLE_PREFIX_STOP`. #6109 was the previous false-positive fight on the same proper-noun validator. #6112 was the previous case of a brief surface reaching users without the gates a sibling surface runs. #7865 was the country-page precision failure with the visible abstention fix.
- [The evidence gate for LLM-extracted values](../design-patterns/evidence-gate-llm-extracted-values-bypass-classes.md) is the prior chapter of the same doctrine on the prices pipeline: prompt-only anti-fabrication does not hold, the deterministic gate's matcher is its own attack surface, and the abstain path must be observable.
- [A bare ISO alpha-2 token is never a country mention](./iso-country-code-false-positive-poisons-brief-grounding.md) is the brief system's other grounding-precision fix; its one-matcher-for-every-surface discipline is the lesson #8441 applies to this validator.
- [Checks must fail closed when they lose their target](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md) describes the same shape from the refactor side; here the blindness was chosen, not inherited.
- [A degraded 200 digest poisoned the last-good cache](./degraded-200-digest-poisoned-the-last-good-cache.md) is why revalidation on read, not a version bump, is the right cache answer.
- `docs/methodology/news-digest-and-briefing.mdx` states that email digest prose passes proper-noun grounding and that the prompt's stitching-phrase ban is a control. Neither holds; the page needs a refresh.
