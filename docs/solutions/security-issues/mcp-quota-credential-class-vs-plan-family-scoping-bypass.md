---
title: "MCP quota scoped by credential class, not plan family, let API-tier subscribers mint pro-tier allowance"
date: 2026-07-26
category: security-issues
module: api/mcp/quota.ts
problem_type: security_issue
component: payments
severity: high
symptoms:
  - "api_starter/api_business subscribers satisfy the pro OAuth token mint gate (tier>=1 + mcpAccess in api/oauth/authorize-pro.ts) and, once minted, receive the 1000/day MCP catalog allowance instead of their entitled 50/day"
  - "user_key and pro-OAuth credential classes belonging to the same user increment the same per-user Redis daily quota counter even though the two contexts resolve to different daily limits"
  - "a user_key request rejected at the hardcoded 50/day cap clamps the shared Redis counter down to 50 (F4 counter-clamp-on-rejection), refunding quota already consumed under the higher-limit pro-OAuth context"
  - "the Settings page MCP quota display (api/user/mcp-quota.ts) and the enforcement path (api/mcp/auth.ts checkMcpEntitlementGate) could disagree because each independently resolved the daily limit from plan key"
root_cause: scope_issue
resolution_type: code_fix
related_components: [assistant, testing_framework]
tags: [mcp-quota, entitlement-bypass, plan-family-scoping, oauth-token-minting, shared-redis-counter, deny-list-pattern, mutation-testing, quota-display-enforcement-parity]
---


# MCP quota scoped by credential class, not plan family, let API-tier subscribers mint pro-tier allowance

## Problem

Plan 2026-07-25-001 unit U3 made the MCP daily quota plan-driven. Instead of a flat 50/day for every
Pro caller, the cap comes from the entitlement's `features.planLimits.mcpCallsPerDay`: pro plans 50,
pro_business 250, enterprise `null` (unlimited, still metered). The plan's decision KTD6 drew a
deliberate boundary — plan-driven limits apply to the `pro` (OAuth) context only, and `user_key`
callers stay on the hardcoded 50/day, because "raising API-tier MCP allowances is a deliberate
follow-up."

That boundary was implemented as a **credential-class** check when the intent was a **plan-family**
check. The pro pre-check read the allowance straight off the entitlement and passed it to the
metering layer, with no filter on which plan it came from:

```ts
// api/mcp/auth.ts — before (checkMcpEntitlementGate)
const passed = (): McpPreCheckResult => ({ ok: true, mcpDailyLimit: ent?.features?.planLimits?.mcpCallsPerDay });
```

`checkMcpEntitlementGate` is shared by both identity-resolved contexts (`api/mcp/auth.ts:438`), and
`runUserKeyPreChecks` drops the limit on the way out (`api/mcp/auth.ts:485-499`), so a `user_key`
caller really did stay at 50. The gap is on the other side: **API-tier subscribers can mint a pro
OAuth token too.** The mint gate in `api/oauth/authorize-pro.ts:362-367` rejects only on
`tier < 1 || mcpAccess !== true || validUntil < now` — and `api_starter` is `tier: 2` with
`mcpAccess: true` (`convex/config/productCatalog.ts:202-215`), `api_business` likewise
(`convex/config/productCatalog.ts:220-234`). Both satisfy the gate.

So an `api_starter` customer could complete the OAuth flow and receive their **1000/day** catalog
allowance through the OAuth door (`api_business`: 10,000/day) while the identical entitlement,
presented as a `wm_…` user key, stayed capped at 50 — the exact allowance raise KTD6 said was a
future decision, granted by accident through the other credential.

A second failure rides on the first. Both credential classes INCR the **same** per-user Redis daily
counter, `dailyCounterKey(userId)` (`api/mcp/quota.ts:84`, `api/mcp/dispatch.ts:157` covering both
`pro` and `user_key`). The F4 counter-clamp on the rejection path deliberately clamps toward the
*rejecting context's resolved limit* rather than the plan default (`api/mcp/quota.ts:146-172`, and
the comment at `:130-133` explains why: clamping a 250/day caller down to 50 would hand them 200 free
calls). With two different limits resolvable against one counter, a `user_key` rejection at 50 could
clamp a counter that a 1000/day pro context had legitimately driven past it — a refund of
already-consumed quota.

## Symptoms

There was no production symptom: the bug lived on an unmerged branch (PR #5635, `feat/pro-business-tier`)
and the leak requires an API-tier subscriber who also connects over OAuth. What made it hard to see is
that everything *looked* right at every local vantage point:

- The U3 unit tests all passed. Discriminating on `context.kind` is exactly what KTD6's prose says, so
  the implementation read as a faithful translation of the decision.
- Enforcement and display agreed with each other, so the Settings quota widget would have shown
  `X / 1000` to an api_starter user — consistently, and consistently wrong.
- The clamp-refund interaction is invisible from either call site alone. `reserveQuota` is correct in
  isolation; `checkMcpEntitlementGate` is correct in isolation; the hazard only exists because a
  shared counter can be reached with two different resolved limits.

It took a 9-reviewer adversarial pass over the whole branch to converge on it — the finding is
cross-file by nature, and no single-unit review has the vantage point.

## What Didn't Work

**Discriminating on `context.kind` (the original U3 implementation).** Passing the plan allowance from
the `pro` pre-check and withholding it from the `user_key` pre-check is a literal reading of KTD6, it
passed its tests, and it reviewed well at unit level. It is wrong because credential class and plan
family are independent axes: OAuth is not the pro-plan door, it is the "tier ≥ 1 + mcpAccess" door,
and API tiers walk through it.

**An allow-list of plan-driven plan keys (`pro_monthly`, `pro_annual`, `pro_business_*`, `enterprise`).**
The security reviewer proposed this as the fail-closed shape, and in the abstract it is the safer
default. It was rejected because it breaks a behavior that is already pinned: `free` is not in the
list, so its honest `0` allowance (`convex/config/productCatalog.ts:137-150`) would fall through to
the 50/day fallback and the Settings endpoint would advertise 50 MCP calls/day to a user who has
none. That contract has a test — `tests/mcp-quota.test.mjs:286`, "honours a real zero allowance
verbatim (0 is a limit, not a missing one)". The deny-list makes the minimal behavior change that
matches the stated rule "API tiers keep 50" and nothing else.

**Per-credential-class counter keys.** Giving `pro` and `user_key` separate daily counters would
dissolve the clamp interaction directly, but it changes what the meter means: one user could then
consume 50 through the key *and* 250 through OAuth. The counter is per-user on purpose (the principal
is the key owner — the same reasoning already applied to the shared 60/min limiter,
`api/mcp/auth.ts:525-530`).

## Solution

A shared helper in `api/mcp/quota.ts:68-74` gates the plan allowance on plan family, backed by an
explicit deny-list at `api/mcp/quota.ts:51-56`:

```ts
const API_TIER_MCP_CAPPED_PLAN_KEYS = new Set([
  'api_starter',
  'api_starter_annual',
  'api_business',
  'api_business_annual',
]);

export function resolvePlanDrivenMcpAllowance(
  planKey: string | undefined,
  mcpCallsPerDay: number | null | undefined,
): number | null | undefined {
  if (planKey && API_TIER_MCP_CAPPED_PLAN_KEYS.has(planKey)) return undefined;
  return mcpCallsPerDay;
}
```

Returning `undefined` hands the value to `resolveDailyLimit` (`api/mcp/quota.ts:34-40`), which maps
anything unreadable — `undefined`, a legacy row with no `planLimits`, NaN, a negative — to
`PRO_DAILY_QUOTA_LIMIT` (50, `server/_shared/pro-mcp-token.ts:483`). `null` still passes through as
unlimited and `0` is still honoured verbatim.

Both consumers call it. Enforcement, in the `passed()` closure of `checkMcpEntitlementGate`
(`api/mcp/auth.ts:461-464`):

```ts
const passed = (): McpPreCheckResult => ({
  ok: true,
  mcpDailyLimit: resolvePlanDrivenMcpAllowance(ent?.planKey, ent?.features?.planLimits?.mcpCallsPerDay),
});
```

And the Settings display endpoint, at `api/user/mcp-quota.ts:130`, feeding the same
`resolveDailyLimit` at `api/user/mcp-quota.ts:140`. Display equals enforcement by construction rather
than by a second copy of the normalisation.

Note that `api_business_annual` is in the deny-list but is not a plan key in the catalog today (grep
finds it only at `api/mcp/quota.ts:55`) — a deliberate forward entry so an annual API-Business SKU
cannot ship the leak back in.

The fix landed in the review-fix commit of PR #5635 (`feat/pro-business-tier`), open and unmerged as
of this writing.

## Why This Works

Once API-family plans resolve to 50 on the OAuth path, the two credential classes agree on the cap
for every user who can hold both, and the clamp-refund scenario dissolves rather than being separately
patched. The reason is a catalog property: pro-family plans are `apiAccess: false`
(`convex/config/productCatalog.ts:157` for pro, `:186` for pro_business — the comment at `:175-176`
says it is deliberate, so a Pro seat cannot mint a `wm_…` key). So the only plans that can hold a
`user_key` at all are the API family, and those now resolve to the same 50 on both paths. No user can
present two differing limits against one counter. Enterprise is the one plan holding both credentials
with a plan-driven value, and its value is `null` — the unlimited path skips the rejection branch
entirely (`api/mcp/quota.ts:122`), so it never clamps.

The deny-list direction is what preserves the rest of the surface: every plan not named keeps its
allowance verbatim, which is why pro's 50, pro_business's 250, enterprise's `null` and free's `0` all
survive untouched. The helper is the single decision point — one exported function, two call sites —
so the eventual follow-up that *does* raise API-tier MCP allowances is a one-line deletion from the
set, not an audit of both paths.

## Prevention

**When a decision says "this applies to X only", encode the axis the decision actually names.** KTD6
named a plan boundary ("API tiers keep 50") and the implementation encoded a credential boundary.
They coincide only if credential class determines plan family, which nothing in this system
guarantees — the OAuth mint gate tests `tier >= 1 + mcpAccess`, not plan. Before implementing a
scoping rule, name the discriminator explicitly and check it is the one the rule is about.

**When two code paths write the same shared counter, they must agree on the limit that reads it.**
The clamp bug is not a second, unrelated defect; it is what a shared counter does when two callers
resolve different limits against it. Any change that makes a limit vary per-caller should be checked
against every writer of the counter it governs, not just the caller being changed.

**Route both the enforcement and the display of a limit through one exported function.** The Settings
endpoint exists specifically to show users the cap the meter applies; a second copy of the
normalisation would be exactly the drift it exists to prevent (`api/mcp/quota.ts:30-32`). There is a
test pinning the reuse — `tests/mcp-quota.test.mjs:390`, "reuses api/mcp/quota.ts resolveDailyLimit —
no second copy of the normalisation".

**Mutation-test a security fix before claiming coverage** (standing rule, *auto memory [claude]*).
This one was proved by reverting the deny-list guard to a raw passthrough and confirming that exactly
the three new witnesses go red, then restoring:

```
tests/mcp-quota-plan-driven.test.mjs:259  SECURITY: api_starter on the PRO context is capped at 50,
                                          not its 1000 catalog allowance
tests/mcp-quota-plan-driven.test.mjs:272  SECURITY: api_business on the PRO context is capped at 50,
                                          not its 10000 catalog allowance
tests/mcp-quota.test.mjs:296              displays 50 for an API-tier plan, not its catalog MCP
                                          allowance (display == enforcement)
```

The enforcement witness asserts the rejecting number, not just the rejection — so a future change
that 429s for the wrong reason still fails:

```js
it('SECURITY: api_starter on the PRO context is capped at 50, not its 1000 catalog allowance', async () => {
  const { deps, pipe } = makeProDeps({
    pipelineOpts: { initialCount: 50 },
    getEntitlements: async () => entitlement('api_starter', limits(1000), { tier: 2 }),
  });
  const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
  assert.equal(res.status, 429, 'API-tier catalog allowances must not leak through the OAuth door');
  const body = await res.json();
  assert.equal(body.error?.code, -32029);
  assert.match(body.error.message, /\(50\/day\)/, 'the enforced limit is the hardcoded default, not the plan value');
  assert.equal(pipe.count, 50);
});
```

After restoring the guard the verification run was green: 113 assertions passing across the touched
suites, 344 across the MCP suites, plus `typecheck` and `typecheck:api`.

**A cross-file boundary bug needs a cross-file reviewer.** The original U3 implementation was reviewed
and tested at unit level and survived both. What caught it was an adversarial pass reading the branch
as a whole, where the OAuth mint gate, the plan catalog, and the quota metering site are all in view
at once. Unit-scoped review cannot see a boundary that spans three files.
