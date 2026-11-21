---
name: verify-brief-erasure
description: Model-check that account erasure leaves no brief behind when a digest compose runs at the same time. Use when changing storeBrief or undoBriefWriteIfErased in scripts/lib/brief-l10n.mjs, the brief write in scripts/seed-digest-notifications.mjs, or deleteAccountRedisKeys, scanAccountBriefPage, deleteAccountBriefPage or the sweep scheduling in convex/accountDeletion/.
metadata:
  internal: true
---

# Verify brief erasure

**Property.** After an account is erased, Redis holds no brief envelope, localized sibling, slot index or latest pointer for it.

**Harm.** A deleted user's private brief stays readable for up to 7 days, against the erasure promise.

The compose and the erase share no lock. They agree through one Redis:

1. The compose indexes its slot, writes the envelopes, then re-reads `brief:erased:<user>`.
2. The erase sets that marker, then reads the index and deletes what it lists.
3. A delayed sweep deletes anything left.

## Run

```bash
node --import tsx --test tests/brief-erase-compose-model.test.mts
```

It takes about 30 s and runs in CI with the other data tests. It checks four things:

- With no Redis failures, the compose and the erase leave nothing, in every order of their Redis commands.
- With one failed or lost request anywhere, they still leave nothing. Every request is retried once, so one fault cannot strand a brief.
- With two failed or lost compose requests, the delayed sweep removes what the compose left.
- The sweep delay (`BRIEF_SWEEP_DELAY_MS`) is longer than the most compose requests seen in any run, times `BRIEF_REDIS_TIMEOUT_MS`. The model assumes the sweep runs after the compose.

## How it works

`tests/helpers/interleavings.mjs` runs the real functions against a fake Upstash `fetch`. Each Redis command is one step, because Upstash does not run a `/pipeline` atomically. Other clients' commands can run between its commands, and only `/multi-exec` is atomic.

A faulty request either never reaches Redis or runs every command and loses the response. The explorer replays the actors once for every order of steps and every placement of faults.

The search is reduced in two ways:

- **Sleep sets.** Orders that only swap two steps on different keys, or two reads, are explored once.
- **Unshared keys.** Commands on keys that `isShared` marks unshared take no step at all. The helper throws if a second actor ever touches one of those keys.

On replay, the helper checks that the actors repeat the recorded steps, so nondeterministic code fails loudly instead of corrupting the search.

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

It applies three breaks to the real code one at a time, runs the model, and restores the files:

- The compose skips the marker re-read after its envelope write. This is the race CodeRabbit flagged on #10896.
- The erase reads the slot index before it sets the marker.
- No delayed sweep. This is the case #10956 exists for.

Each must be caught. If a break no longer applies because the code moved, update its text in the script.

## Scope

Covered:

- One compose of one new slot, with an older slot already stored.
- One erase, retried up to `MAX_EXTERNAL_ATTEMPTS` times.
- The delayed sweep.
- The fault bounds listed under Run.

Not covered:

- Two composes for the same user at once.
- Two faults that include erase or sweep requests.
- A compose that starts after the sweep.
- Expiring TTLs.
- The Convex mutations that track the deletion's progress.

## Coverage record

| Check | Code |
|---|---|
| compose actor | `storeBrief`, `writeBriefSlotIndex`, `undoBriefWriteIfErased` in `scripts/lib/brief-l10n.mjs`; `redisPipeline` in `api/_upstash-json.js` |
| erase actor | `deleteAccountRedisKeys` in `convex/accountDeletion/sideEffects.ts` |
| sweep actor | `scanAccountBriefPage`, `deleteAccountBriefPage` in `convex/accountDeletion/sideEffects.ts`; `BRIEF_SWEEP_DELAY_MS` in `convex/accountDeletion/registry.ts` |

**Last confirmed against:** `2f1e70ac7b`, plus the commit that adds this skill.

When any covered function changes, reread it against the model, rerun the check, and move this line forward only after both pass.
