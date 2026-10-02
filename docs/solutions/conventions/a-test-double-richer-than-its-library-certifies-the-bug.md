---
title: "A test double richer than its library certifies the bug it hides"
date: 2026-09-17
category: conventions
module: docker/redis-rest-proxy.mjs, test doubles for third-party clients
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Hand-writing a stub, fake, or mock for a third-party client the repo does not install as a dependency"
  - "Asserting that production source contains a specific call site, as a stand-in for behavioural coverage"
  - "A bug report says a code path has never worked, while its tests are green"
  - "Reviewing a test whose fixture defines the same surface the code under test consumes"
symptoms:
  - "A route fails 100% of the time in production while its unit tests pass"
  - "A regression test scrapes the implementation and asserts it matches a literal call site"
  - "Mutation-testing the production line reds the suite, yet the bug still shipped"
  - "A stub exposes a method the real library does not have, so the wrong call works in tests"
root_cause: wrong_api
resolution_type: test_fix
related_components:
  - testing_framework
  - development_workflow
tags:
  - test-doubles
  - stub-drift
  - source-scrape-assertions
  - mutation-testing
  - vacuous-tests
  - third-party-api
  - green-while-dead
---

# A test double richer than its library certifies the bug it hides

## Context

`docker/redis-rest-proxy.mjs` is the Upstash-compatible Redis REST proxy bundled with WorldMonitor's self-hosted Docker stack. Its `POST /multi-exec` route answered **every** request with `403 {"error":"multi.sendCommand is not a function"}` — 100% failure, for as long as the route had existed. `sendCommand` is a method on the node-redis *client*; the v4 transaction chain queues with `addCommand`. Verified against `redis@4.7.1`, the version `docker/Dockerfile.redis-rest` installs:

```
typeof client.multi().sendCommand  // 'undefined'
typeof client.multi().addCommand   // 'function'
```

Two seeders publish exclusively through that route and failed every pass. The defect was reported in #8265 by a self-hoster; it had also been noted in passing in PR #7997 without being tracked.

The interesting part is not the one-word fix. It is that the route had **two** dedicated tests and both were green, because each had independently been shaped around the defect.

## Guidance

### 1. Derive a test double's surface from the library, not from the code under test

The client stub in `tests/redis-rest-proxy-auth.test.mjs` was:

```js
multi() {
  return { sendCommand: client.sendCommand, async exec() { /* ... */ } };
}
```

It answered `sendCommand` — a method node-redis v4's `RedisClientMultiCommand` **does not have**. The stub was *richer* than the real library, so the broken call site worked in tests and only in tests.

A stub is a claim about an external API. Written from "what does the code under test call?", it can only ever agree with that code. Written from "what does the library actually expose?", it can disagree — which is the entire point of having it.

When the library is not a repo dependency (here it is installed only inside the container image), install it once in a scratch directory, probe the real object, and pin what you found:

```js
// Captured from redis@4.7.1, the version docker/Dockerfile.redis-rest installs:
//   const m = createClient().multi();
//   typeof m.addCommand   // 'function'   (queues a raw command, returns the chain)
//   typeof m.exec         // 'function'
//   typeof m.sendCommand  // 'undefined'  <- the bug
const MULTI_V4_METHODS_USED = new Set(['addCommand', 'exec']);
```

Then make the drift itself impossible to reintroduce — read which methods the production source calls on the chain and check them against that set, and require the fixture to expose *exactly* the same surface:

```js
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const called = [...new Set([...code.matchAll(/\bmulti\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))].sort();

assert.ok(called.length > 0, 'found no multi.<method>() call sites — the scan broke, not the proxy');
assert.deepEqual(called, [...MULTI_V4_METHODS_USED].sort());

// `makeMulti()` returns { multi, queued, execCalls } — `.multi` is the
// transaction OBJECT, not a factory (the client stub's own `multi()` method is
// the factory, and returns this object). So these are its method names.
// A stub richer than the library hides a call site that throws in production;
// a poorer one fails for the wrong reason.
assert.deepEqual(Object.keys(makeMulti().multi).sort(), [...MULTI_V4_METHODS_USED].sort());
```

Note what this replaced. The obvious guard — `assert.equal(typeof makeMulti().multi.sendCommand, 'undefined')` — restates the fixture defined a hundred lines above it in the same file. It is true whether or not production is broken, and it was the single test that stayed green when the bug was reintroduced.

### 2. A source-scrape assertion cannot be the only proof that a call site works

`tests/redis-rest-proxy-command-parity.test.mjs` asserted:

```js
assert.match(proxySrc, /multi\.sendCommand\(commandForExecution\(cmd\)\)/,
  'the /multi-exec handler must delegate to the shared command gate');
```

The intent was sound — prove the authorization gate is wired into the route. The effect was to **pin the broken call site as the contract**. Anyone who fixed the bug would have reded this test and been invited to "fix" it back.

A scrape can prove a call site *exists*. It can never prove the call *works*, because it compares the implementation against a transcription of itself. Keep the wiring scrape if the wiring is genuinely what you want pinned, but pair it with behaviour, and add the negative:

```js
assert.match(proxySrc, /queuedCommand = commandForExecution\(cmd\)/,
  'the /multi-exec handler must delegate to the shared command gate');
assert.match(proxySrc, /multi\.addCommand\(queuedCommand\)/,
  'must queue the command the gate authorized, not the caller\'s array');
assert.doesNotMatch(proxySrc, /multi\.sendCommand\(/,
  'sendCommand is a node-redis CLIENT method; the v4 multi chain queues with addCommand');
```

### 3. Use non-pre-normalized fixtures, or a normalization assertion proves nothing

The first replacement test asserted the gate's output reached Redis:

```js
const res = await app.post('/multi-exec', [['SET', 't:a', 'hello'], ['GET', 't:a']]);
assert.deepEqual(app.transaction().queued, [['SET', 't:a', 'hello'], ['GET', 't:a']]);
```

`commandForExecution` upper-cases the verb and `String()`s every argument — but the fixture was *already* upper-case and all strings, so the gate's output was byte-identical to its input. Sabotaging the handler to `multi.addCommand(cmd)` (call the gate for its throw, then queue the caller's unvalidated array) passed 4/4. The fix is to feed input the transform must visibly change:

```js
const res = await app.post('/multi-exec', [['set', 't:a', 1], ['get', 't:a']]);
assert.deepEqual(app.transaction().queued, [['SET', 't:a', '1'], ['GET', 't:a']]);
```

This matters beyond tidiness here: the gate already rewrites arguments in production (`LEGACY_EVAL_REPLACEMENTS` swaps pinned Lua script text), so "queues the caller's array" is a real security bypass, not a hypothetical.

### 4. Prove each guard by breaking the specific thing it guards

Three separate defects need three separate mutations. Run each and record which tests red — a mutation that reds nothing means the guard is decorative:

| Mutation | Tests red (of 16) |
|---|---|
| `multi.sendCommand(queuedCommand)` — the original bug | 12 |
| `multi.addCommand(cmd)` — gate called for its throw, raw array queued | 2 |
| neutralize the shape guard (`String(args[0])` again) | 3 |
| re-add `sendCommand` to the stub — the drift that hid all of it | 1 |

The last row is the one that did not exist before and is the whole lesson: **mutation-testing the production code does not catch a stub that models the wrong API.** Reverting the fix reds the suite *only once the stub is right*. The stub needs its own mutation.

## Why This Matters

A wrong stub is worse than no test. No test leaves a known gap; a wrong stub reports coverage over a path that has never once executed, and every later reviewer — human or agent — treats green as evidence. Here it held for the entire life of the route, across at least one PR (#7997) that noticed the symptom in passing and moved on, while the 403 status sent every self-hoster who hit it to audit `REDIS_TOKEN`.

The two mechanisms reinforced each other. The stub made the broken call pass; the scrape made the broken call *required*. Either alone might have been caught by the other.

## When to Apply

- Writing a fake for any dependency the repo does not install — container-only packages, sidecar clients, vendored SDKs. The absence of the real module from `node_modules` is exactly what lets a stub drift unnoticed.
- Reviewing a test whose fixture and whose assertion were written in the same sitting by the same author against the same implementation.
- Any `assert.match(source, /.../)` against production code. Ask what it would take for it to be green while the feature is broken.
- A bug report claiming a path has never worked, when that path has tests. Suspect the harness before the reporter.

## Examples

Reproducing the defect end-to-end, before the fix — the real proxy process, the real `node-redis` client, a fake RESP server:

```
POST /pipeline   -> 200 [{"result":"OK"},{"result":"hello"}]
POST /multi-exec -> 403 {"error":"multi.sendCommand is not a function"}
```

`/pipeline` passing is what localizes the fault: auth, connectivity, and the shared command gate are all fine, so only the transaction path is broken.

After (`multi.addCommand(queuedCommand)`), the same probe:

```
POST /multi-exec -> 200 [{"result":"OK"},{"result":"hello"}]
POST /multi-exec (denied cmd) -> 403 {"error":"Command not allowed: FLUSHALL"}
```

## Related

- [Verify the verifier: mutation-test every layer built to catch silent failure](verify-the-verifier-mutation-test-every-detection-layer.md) — the general convention this extends. That doc mutation-tests the *detector*; this one adds that mutating production code is not sufficient when the *test double* models an API that does not exist.
- [A --check gate that rebuilt its expectation from the artifact it was checking](../logic-errors/a-check-gate-that-rebuilt-its-expectation-from-the-artifact-it-was-checking.md) — the same self-reference failure in a CI gate rather than a test double.
- Fix opened in PR #8287 (issue #8265); unmerged as of this writing.
