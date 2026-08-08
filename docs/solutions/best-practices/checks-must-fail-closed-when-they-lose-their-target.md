---
title: A check that can no longer see its target must fail loudly, not go green
date: 2026-07-28
category: best-practices
module: mcp/registry, scripts/docs-stats
problem_type: best_practice
component: testing_framework
severity: high
applies_when:
  - "Writing a contract test that stubs or monkey-patches the unit under test"
  - "Writing a validator that parses a value out of another file by path or regex"
  - "Moving a file or symbol that build config, doc validators, or source-text guards point at"
tags:
  - testing
  - fail-closed
  - contract-tests
  - guard-coverage
  - monkey-patching
  - refactor-safety
  - mcp
---

# A check that can no longer see its target must fail loudly, not go green

## Context

While shipping #5696 (PR #5739) — extracting six client-only analysis engines into shared client/server cores and exposing nine new MCP tools — a full green suite of ~17,900 tests hid a published-contract violation, and a docs validator reported a claim as "code says 0" instead of erroring.

Both had the same shape. The check still ran. The check still passed. The check had simply stopped being able to observe the thing it was supposed to verify, and its design made that indistinguishable from success.

This is worse than no check. A missing check is a known gap; a blind check is a false assurance that suppresses the doubt that would have caught the bug.

## Guidance

### 1. When a test stubs the unit under test, enumerate what the stub makes unreachable

`tests/mcp-tool-output-contracts.test.mjs` validates that every MCP tool's response satisfies its declared `outputSchema`. For RPC-style tools it replaces the handler with a fabricated minimal-shape response — the file says so plainly at `tests/mcp-tool-output-contracts.test.mjs:12-17`:

```
//   • RPC tools (has `_execute`): `_execute` is monkey-patched to return a
//     ...
//     It does NOT exercise the real `_execute`
```

That is a defensible design — the real handler needs live Redis. But it means **no code path inside `_execute` is ever schema-checked**, including every early return. The envelope assertion is additionally gated off for exactly those tools (`tests/mcp-tool-output-contracts.test.mjs:152`):

```js
const isCacheTool = typeof tool._execute !== 'function';
```

So when four new tools declared `required: ['cached_at', 'stale', 'data']` and returned a bare `{ error: '...' }` on user-input faults, every gate passed. A strict MCP client validating responses against the published schema would have rejected a legitimate error response in production.

The stub is fine. Not asking "what did I just make invisible?" is the mistake. When you stub the unit under test, write down the paths the stub replaces and cover them another way.

### 2. A parse-out-of-another-file validator must throw when the parse fails

`scripts/docs-stats.mjs` verifies published documentation claims against code. It counted the priority-country table by regex out of a source file. The extraction moved that table to `shared/analysis-population-exposure.ts`, and the counter — still pointed at the old path — degraded silently, because its miss branch produced a number instead of an error (`origin/main:scripts/docs-stats.mjs:358-359`):

```js
const populationPriorityCountries = populationBlock
  ? (populationBlock[1].match(/^\s+[A-Z]{3}:\s*\{/gm) || []).length
  : 0;
```

The published doc says "20-country priority population table". The validator reported `code says 0`, framed as a stale *doc*. Nothing was stale — the validator had lost the file.

Its immediate neighbor in the same function got this right (`origin/main:scripts/docs-stats.mjs:351`):

```js
throw new Error('docs-stats: could not find LEADER_NAMES array in src/services/trending-keywords.ts');
```

`0` is a plausible count. `null`, `false`, and `[]` are plausible values. That plausibility is the trap: a fail-open default is laundered into a real-looking answer. If the parse fails, the program does not know the answer and must say so.

### 3. After moving a file, grep for its old path outside the import graph

The compiler and the test suite follow imports, so they verify the code. Nothing follows a **string** containing a path. In this one change, three separate consumers pinned paths the extraction moved:

- `vite.config.ts` — a `manualChunks` rule matching `/src/config/bases-expanded.ts` by suffix. With the table moved, the rule matched nothing and the 48KB dataset would have been duplicated into every panel chunk that imports it, while the chunk-name guard still passed against a near-empty chunk.
- `scripts/docs-stats.mjs` — the counter above.
- Source-text guard tests (`tests/docs-signal-alignment.test.mts`, `tests/cii-scoring.test.mts`) that `readFileSync` a path and assert regexes against its contents.

A moved file breaks all three silently. `rg -n "old/path"` across build config, scripts, and tests is a five-second step that the type system structurally cannot do for you.

## Why This Matters

Every one of these failures is green-on-red: the signal says "verified" while the property is unverified or false. That inverts the value of the check, because a green suite is used as license to stop looking.

The cost is asymmetric and compounding. The published MCP `outputSchema` is a contract other people's agents parse against; shipping a schema the server violates on every error path breaks callers who did nothing wrong, and the breakage surfaces in *their* logs. The docs validator exists specifically so published numbers stay true — a fail-open counter converts it into a generator of false confidence about exactly the claims it was built to protect.

There is also a discoverability trap: a blind check is invisible in code review precisely because it passes. Nobody investigates a green check.

## When to Apply

- Writing or reviewing a contract/schema test that mocks, stubs, or monkey-patches the unit under test.
- Writing a validator that reads a value out of another file by path, regex, or AST — anything with a "not found" branch.
- Any refactor that moves a file or renames an exported symbol: build config, doc generators/validators, and source-text guards all pin paths as strings.
- Reviewing a diff that edits a test's `readFileSync` path or a guard's regex. Repointing a guard is exactly when it can quietly become vacuous.

## Examples

**Fail-open vs fail-closed in a validator**

```js
// Fail-open: a moved file silently becomes a real-looking answer.
const count = block ? parse(block) : 0;

// Fail-closed: the program says it no longer knows.
if (!block) {
  throw new Error('docs-stats: could not find PRIORITY_COUNTRIES in shared/analysis-population-exposure.ts');
}
const count = parse(block);
```

**Covering what a stub makes unreachable**

The fix was not to un-stub the handler — it still needs live Redis. It was to test the specific paths the stub removes, choosing the ones reachable without I/O:

```js
// Each case drives a tool down its user-input fault branch WITHOUT any cache
// read (every guard short-circuits before Upstash), so these run offline.
const result = await tool._execute(args, '', {}, {});
assert.equal(typeof result.error, 'string');
for (const key of tool.outputSchema.required) {
  assert.ok(key in result, `${name} error return must include required key "${key}"`);
}
```

Writing that test also surfaced a second, unrelated improvement: one tool validated its `hotspot_id` argument *after* five Redis reads. Making the error path testable offline made the wasteful ordering obvious, and the guard moved ahead of the reads.

See `tests/mcp-analysis-rpc-tools.test.mjs` for the committed version.

## Related

- `docs/solutions/best-practices/test-guard-assertions-and-module-state-reset.md` — the adjacent failure mode: a test that reaches the *wrong branch* of a real guard. This doc covers a check that cannot reach the branch at all.
- Issue #5696 / PR #5739 — the change these were found in.
