---
title: A prompt-only stitching ban cannot stop "This development comes as"
date: 2026-09-21
category: logic-errors
module: scripts/lib/brief-llm.mjs
problem_type: logic_error
component: brief_system
severity: high
symptoms:
  - "The 2026-09-20 08:00 brief opened its second lead sentence with \"This development comes as former President Trump returns to the UN\", stapling the Iran peace-terms story to the Trump/UN story"
  - "24/24 gemini-2.5-flash samples on the production digest prompt used \"This development comes as\" or \"This development occurs as\""
  - "DIGEST_PROSE_SYSTEM_BASE already banned \"this comes as\", \"this declaration comes as\", and \"this announcement comes as\"; grep found those phrases only inside the prompt string"
root_cause: missing_validation
resolution_type: code_fix
related_components: [email_processing, background_job, testing_framework]
tags: [llm-hallucination, output-validation, prompt-only-fix, brief-digest, stitching-phrase, cache-revalidation]
---

# A prompt-only stitching ban cannot stop "This development comes as"

## Problem

The WorldMonitor email brief sent on 2026-09-20 opened its second executive-summary sentence with "This development comes as former President Trump returns to the UN", joining the Iran peace-terms story to the Trump/UN story with a weak temporal connective. The same prompt that produced that lead already listed "this comes as", "this declaration comes as", and "this announcement comes as" as banned stitching phrases.

## Symptoms

- The shipped lead used a near-miss variant the banned-phrase list does not name.
- A session harness on the production digest prompt, model, and temperature produced "This development comes as" or "This development occurs as" in 24 of 24 samples.
- `grep -n BANNED scripts/lib/brief-llm.mjs shared/brief-llm-core.js` found the phrases only inside the prompt string. Nothing in `validateDigestProseShape` inspected them.

The status-qualifier repair in #8437 drops that particular captured sentence when "former President Trump" is ungrounded. When the source *does* license "former", the glue sentence still ships. That is the gap this gate closes.

## What Didn't Work

**Prompt-only instructions.** The dedicated `BANNED stitching phrases` section already named ten connectives. The model ignored the list 24 times out of 24 and invented a variant one token off the listed forms. Adding "this development comes as" to the same list would have been the same class of fix that had already failed.

**A cache-generation bump.** Cache hits already run `validateDigestProseShape(hit, stories)` before they return. A parser gate repairs or rejects a poisoned v9 row on read. Bumping `brief:llm:digest:v9` would discard every clean row to buy the same revalidation.

**Rejecting the whole digest.** `runSynthesisWithFallback` retries L2 on the same model with a capped pool, which is likely to stitch again, and L3 degrades the brief to a headline stub. The Iran peace-terms sentences in the captured lead were true. Dropping only the glue sentence keeps them.

## Solution

Opened in #8438.

`validateDigestProseShape` now runs `repairLeadStitchingPhrases` on every lead, with or without a stories pool. The matcher is a word-bounded stem regex, not the prompt's exact variants:

```js
const LEAD_STITCHING_STEM_RE = /\b(?:comes as|occurs as|meanwhile|at the same time|in other news|elsewhere|on another front|in a separate development)\b/i;
```

When any stem hits, the lead splits on the same `LEAD_SENTENCE_SPLIT` the status-qualifier repair uses, the matching sentences are dropped, and the rest rejoin. An empty or under-40-character surviving lead rejects so the caller falls through to L2/L3. Thread teasers are left alone; the prompt's ban, and the shipped defect, are lead-only.

Word boundaries keep "becomes as" from matching `comes as`. A shortened lead that still has a stories pool is re-grounded with `{ combinedThreshold: 1 }`, matching the status-qualifier path.

No cache version bump. A repairable cached stitch returns the shortened lead without a re-LLM. An irreparable one is treated as a miss.

## Why This Works

The prompt listed *forms*. The model produced a form the list did not contain. A stem check keyed on `comes as` and `occurs as` catches "this comes as", "this declaration comes as", "this announcement comes as", "this development comes as", and "this development occurs as" without having to name each one.

The gate is independent of grounding. A lead that is fully licensed by the pool can still be editorially incoherent if it staples two unrelated stories with a temporal connective. Status-qualifier repair cannot see that class.

## Prevention

- Treat a prompt ban the model has already ignored as a Vacuous Guard, not as a control. The measurement was 24/24 on the shipping prompt.
- Key connective bans on stems, not on the exact noun-phrase variants the last incident used.
- Work test-first with the captured near-miss, and include the case where the sibling gate would *pass* ("former" grounded) so the new gate is the one that has to fire.
- Do not bump a cache generation when the hit path already revalidates. Pin both the repair-on-hit and the reject-and-re-LLM paths.

## Related Issues

- Issue #8438 is this fix. #8437 shipped the status-qualifier repair that drops the same captured sentence when "former" is ungrounded. #8442 moved brief prose to `gemini-3.5-flash-lite`; that model measured 0/24 stitch phrases on one pool, which is not a substitute for a parser gate.
- [A recall-only grounding gate cannot see an invented status qualifier](./recall-only-grounding-cannot-see-an-invented-status-qualifier.md) is the sibling investigation; its "What Didn't Work" already recorded that the stitching ban was prompt-only.
- [The evidence gate for LLM-extracted values](../design-patterns/evidence-gate-llm-extracted-values-bypass-classes.md) is the prior chapter of the same doctrine: prompt-only anti-fabrication does not hold.
- [A degraded 200 digest poisoned the last-good cache](./degraded-200-digest-poisoned-the-last-good-cache.md) is why revalidation on read, not a version bump, is the right cache answer.
