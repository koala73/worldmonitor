---
name: verify-brief-erasure
description: Model-check that account erasure leaves no brief behind when a digest compose runs at the same time. Use when changing storeBrief or undoBriefWriteIfErased in scripts/lib/brief-l10n.mjs, the brief write in scripts/seed-digest-notifications.mjs, or deleteAccountRedisKeys, sweepBriefEnvelopes, markExternalComplete or BRIEF_SWEEP_DELAY_MS in convex/accountDeletion/, or tests/helpers/interleavings.mjs.
metadata:
  internal: true
---

# Verify brief erasure

**Property.** After an account is erased, Redis holds no brief envelope, localized sibling, slot index or latest pointer for it.

**Harm.** A deleted user's private brief stays readable for up to 7 days, against the erasure promise.

The compose and the erase share no lock. They agree through one Redis:

1. The compose indexes its slot, writes the envelopes, then re-reads `brief:erased:<user>`.
2. The erase sets that marker, then reads the index and deletes what it lists.
3. Completing the deletion schedules a delayed sweep, which deletes anything left.

## Run

```bash
node --import tsx --test tests/brief-erase-compose-model.test.mts
```

It takes about 30 s and runs in CI with the other data tests. It checks four things:

- Control: a compose with no erase stores the new envelope, sibling, index entry and latest pointer.
- With no Redis failures, the compose and the erase leave nothing, in every order of their Redis commands. The compose may fail only by finding the erase marker.
- With one failed or lost request anywhere, they still leave nothing. The compose retries its index write, its marker read and each cleanup once, and a failed envelope write runs the cleanup before it throws. The erase retries up to `MAX_EXTERNAL_ATTEMPTS` times. So one fault cannot strand a brief.
- With two failed or lost compose requests, the sweep that completing the deletion scheduled removes what the compose left. In every run, the sweep delay must also outlast the compose: its requests times `BRIEF_REDIS_TIMEOUT_MS`. The model runs the sweep after the compose, which holds only then.

## How it works

`tests/helpers/interleavings.mjs` runs the real functions against a fake Upstash `fetch`. Each Redis command is one step, because Upstash does not run a `/pipeline` atomically. Other clients' commands can run between its commands, and only `/multi-exec` is atomic.

The Convex parts run through their real handlers with a fake `ctx`. The erase calls `markExternalComplete`, whose scheduler records the sweep. The sweep actor runs `sweepBriefEnvelopes` for each job, including its retries and next pages. The model Redis returns one key per `SCAN` call, and the fixture puts an unrelated key first, so the sweep must follow its cursor past an empty page.

A faulty request either never reaches Redis or runs every command and loses the response. The explorer replays the actors once for every order of steps and every placement of faults.

The search is reduced in two ways:

- **Sleep sets.** Orders that only swap two steps on different keys, or two reads, are explored once.
- **Unshared keys.** Commands on keys that `isShared` marks unshared take no step at all. The helper throws if a second actor ever touches one of those keys.

On replay, the helper checks that the actors repeat the recorded commands with the same arguments, so nondeterministic code fails loudly instead of corrupting the search. `tests/interleavings-helper.test.mjs` tests the helper itself.

## Reading a failure

A failure prints the violated property and the steps in order, for example:

```
brief keys survive the erase: brief:user_erased:2026-11-21-0800
  compose: ZADD brief:slots:user_erased
  erase: SET brief:erased:user_erased
  ...
```

Before you call it a product bug, check `createModelRedis` against real Redis semantics for each command in the trace. For example, real Redis never stores an empty sorted set. The first version of this model reported a false bug because its `ZREM` left one behind.

If the semantics are right, the trace is the bug. Fix the code, not the model.

## Changing the protocol on purpose

Keep the model calling the real functions. If you move a step into a new function, export it and call that. Do not copy the logic into the test. Then prove the model can still fail:

```bash
node scripts/check-brief-erasure-model-mutations.mjs
```

It applies five breaks to the real code one at a time, runs the model, and restores the files:

- The compose skips the marker re-read after its envelope write. This is the race CodeRabbit flagged on #10896.
- The erase reads the slot index before it sets the marker.
- Completing the deletion schedules no sweep. This is the case #10956 exists for.
- The sweep stops after its first `SCAN` page.
- The sweep delay is shorter than a compose can run.

Each must be caught. If a break no longer applies because the code moved, update its text in the script.

## Scope

Covered:

- One compose of one new slot, with an older slot already stored.
- One erase, retried up to `MAX_EXTERNAL_ATTEMPTS` times, then the deletion's completion.
- The sweep that completion schedules, with its retries and next pages.
- The fault bounds listed under Run.

Not covered:

- Two composes for the same user at once.
- Two faults that include erase or sweep requests.
- A compose that starts after the sweep.
- Expiring TTLs.
- The Convex mutations that track the deletion's progress, other than `markExternalComplete`. The erase's retry loop is written in the test.

## Coverage record

| Check | Code |
|---|---|
| compose actor | `storeBrief`, `writeBriefSlotIndex`, `undoBriefWriteIfErased` in `scripts/lib/brief-l10n.mjs`; `redisPipeline` in `api/_upstash-json.js` |
| erase actor | `deleteAccountRedisKeys` in `convex/accountDeletion/sideEffects.ts`; `markExternalComplete` in `convex/accountDeletion/erase.ts` |
| sweep actor | `sweepBriefEnvelopes`, `scanAccountBriefPage`, `deleteAccountBriefPage` in `convex/accountDeletion/sideEffects.ts`; `BRIEF_SWEEP_DELAY_MS` in `convex/accountDeletion/registry.ts` |

**Last confirmed against:** `2f1e70ac7b`, plus the commits of #11111, which adds this skill.

When any covered function changes, reread it against the model, rerun the check, and move this line forward only after both pass.
