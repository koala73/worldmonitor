# Enterprise contract accounts

A contract account owns one customer's contract terms: the daily request
allowance, per-minute burst, monthly AI token allowances, overage rates,
safety-limit multiple, seat cap and AI providers. Its members share one
request pool and one burst bucket across REST (`wm_` keys) and MCP. The first
account is Hexion (PO C000003282).

Code: `convex/enterpriseAccounts.ts` (operator functions),
`convex/lib/enterpriseAccounts.ts` (membership reads),
`server/_shared/account-rate-limit.ts` and the per-key block in
`server/gateway.ts` (REST), `api/mcp/auth.ts` and `api/mcp/quota.ts` (MCP).

## What membership does

- An active member of a live contract (`contractStart <= now < contractEnd`)
  gets the Enterprise plan through entitlement recompute, with `validUntil`
  set to the contract end. A paid subscription or comp grant the member also
  holds still competes in recompute, but the edge entitlement carries the
  `account` block either way, so metering is always pooled.
- Members inherit the account's AI providers (see
  [ai-routing-policy.md](ai-routing-policy.md)). A per-user row can narrow
  them but never widen them. Members of an ended contract keep the routing
  policy until you remove them.
- Members are skipped by the self-serve plan-limit email scan.
- A user can be an active member of one account at a time.

## Metering

| Item | Value |
|---|---|
| Pool key | `rl:apikey:day:acct:<accountId>:YYYY-MM-DD` |
| Per-member key | `rl:apikey:day:acct:<accountId>:member:<userId>:YYYY-MM-DD` |
| Burst bucket | `rl:apikey:min` limiter keyed `acct:<accountId>`, shared by REST and MCP data calls |
| Safety limit | daily allowance times `breakerMultiple` (default 5) |

- Up to the allowance, requests are served normally.
- Past the allowance, requests are served with `X-WorldMonitor-Overage: true`
  and count as overage. The usage event carries `account_id` and `overage`.
- At the safety limit, requests get 429 `limit_type: daily` until UTC
  midnight. Burst overflow gets 429 `limit_type: per_minute`.
- Account limits are enforced whatever `API_RATE_LIMIT_ENFORCE` says. That
  flag still governs self-serve plans.
- MCP calls charge the pool at their per-tool weight. `get_mcp_allowance`
  shows the contract allowance as `limit` and the pooled count as `used`.
- If Redis is unavailable, REST requests are served unmetered (fail open).
  MCP data calls are refused with `-32603` and HTTP 503 (`Retry-After: 5`)
  because MCP never dispatches a call it could not reserve. The shared burst
  bucket fails open on both paths.

## Admin self-serve seats

The account admin manages people from Settings, in the plan section of the
dashboard (`src/components/EnterpriseSeatsSection.ts`, server
`convex/enterpriseSeats.ts`). It works like Business seats:

- The admin invites by company email. Each invite holds a seat and emails a
  link to `/dashboard?accept-enterprise-invite=<memberId>&token=<t>`, valid
  for 14 days. An expired invite frees its seat and shows as expired.
- The invitee accepts while signed in with the invited address, including
  after creating an account from the link. Acceptance makes them an active
  member at once (Enterprise plan, pooled allowance, account AI providers).
- The admin removes members or withdraws invites. Removal takes effect at
  once. The admin cannot remove their own seat; use `setAdmin` first.
- Other members see the account name and seat count, not the roster. After
  the contract ends, the admin still sees the roster and can remove people.
- Invites are refused after the contract ends, past `seatCap`, and for
  free-mail domains. Acceptance is refused for a user already active in
  another account. The invite step does not check other accounts, so it never
  reveals another customer's roster.
- An account can send at most `max(20, seatCap)` invites in any 24 hours.
  Withdrawn invites count, so inviting and withdrawing in a loop cannot send
  unlimited mail.
- If the invite email is not sent (no mail key, suppressed recipient, or a
  send error), the roster says so. The admin withdraws the invite and invites
  again.

Errors: `NOT_ACCOUNT_ADMIN`, `SEAT_CAP_REACHED`, `INVITEE_DOMAIN_NOT_CORPORATE`,
`CANNOT_INVITE_SELF`, `CONTRACT_ENDED`, `CANNOT_REMOVE_SELF`,
`INVITE_EMAIL_MISMATCH`, `INVITE_EXPIRED`, `INVITE_ALREADY_USED`,
`INVALID_INVITE_TOKEN`, `ALREADY_MEMBER_OF_ANOTHER_ACCOUNT`,
`INVITE_RATE_LIMITED`.

Deleting an account erases its member rows and any unclaimed invites addressed
to its verified email. A row another user accepted is that user's seat and is
kept, even when its stored address matches.

## Operator commands

Run from the main checkout with the prod deploy key exported
(`CONVEX_DEPLOY_KEY`, see the `wm-creds` skill). Times are epoch
milliseconds. Every member change recomputes that user and clears their
entitlement and AI-routing caches. Every account edit does the same for all
members.

Create an account:

```bash
npx convex run enterpriseAccounts:createAccount '{
  "name": "Hexion",
  "contractStart": 1793577600000,
  "contractEnd": 1825113600000,
  "dailyRequestAllowance": 10000,
  "perMinuteBurst": 300,
  "monthlyInputTokens": 15000000,
  "monthlyOutputTokens": 3000000,
  "overagePerThousandRequestsUsd": 3,
  "overagePerMillionInputTokensUsd": 4,
  "overagePerMillionOutputTokensUsd": 20,
  "seatCap": 5,
  "allowedProviders": ["anthropic"]
}'
```

`breakerMultiple` is optional (default 5). The call returns `{accountId}`.

| Task | Command |
|---|---|
| Edit terms | `enterpriseAccounts:updateAccount '{"accountId":"…","perMinuteBurst":400}'` (any term; rejects a seat cap below seats in use) |
| Add a member | `enterpriseAccounts:addMemberByUserId '{"accountId":"…","userId":"user_…","role":"member"}'` |
| Remove a member | `enterpriseAccounts:removeMember '{"accountId":"…","userId":"user_…"}'` |
| Set the admin | `enterpriseAccounts:setAdmin '{"accountId":"…","userId":"user_…"}'` (must be an active member; the previous admin becomes a member) |
| Read an account | `enterpriseAccounts:getAccountWithMembers '{"accountId":"…"}'` |
| List accounts | `enterpriseAccounts:listAccounts '{}'` |
| Check a member's block | `enterpriseAccounts:getLiveAccountBlockByUserId '{"userId":"user_…"}'` |

Removing the admin leaves the account with no admin until you run `setAdmin`.
Errors: `SEAT_CAP_REACHED`, `ALREADY_MEMBER_OF_ANOTHER_ACCOUNT`,
`NOT_A_MEMBER`, `ADMIN_MUST_BE_ACTIVE_MEMBER`, `SEAT_CAP_BELOW_MEMBERS`.

Recompute runs on its own at contract start and contract end.

## Migrating a customer from per-user comp grants

Done this way for Hexion's two users so Enterprise access and Anthropic-only
routing never lapse:

1. Read both entitlement rows; stop if either lacks `compPlanKey: enterprise`.
2. Pull the users' 30-day per-minute peak and daily totals from Axiom
   `wm_api_usage`. If the peak reaches the account burst, raise the burst for
   a transition window. (Hexion on 2026-11-06: peak 257 a minute, busiest day
   1,565.)
3. Create the account with the Order Form values.
4. Add the admin and the other members by user id, then `setAdmin`.
5. Check each member: `getLiveAccountBlockByUserId` returns the block and the
   routing lookup (`entitlements:getAiRoutingPolicyByUserId`) returns the
   account's providers with the `accountId`.
6. Remove each per-user comp grant with
   `payments/billing:revokeComplimentaryEntitlement '{"userId":"user_…","reason":"moved to contract account"}'`
   (it recomputes) and confirm the result still says `enterprise` with
   `validUntil` at the contract end.
7. Delete the per-user `aiRoutingPolicies` rows (`entitlements:clearAiRoutingPolicy`)
   and confirm the routing lookup still returns the account's providers.
8. Make one `wm_` call per member and confirm the pool key and that member's
   key increment.
