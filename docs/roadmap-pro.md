# WorldMonitor Pro — Implementation Roadmap

## Context

The `/pro` landing page promises features across 4 tiers (Free, Pro, API, Enterprise) but almost nothing beyond the marketing page exists. Current state:

- **Convex**: bare — `registrations` + `counters` tables only
- **Auth**: none — no Clerk, no sessions. Desktop uses manual `WORLDMONITOR_API_KEY` in keychain
- **Payments**: none — no Stripe
- **Gating**: UI-only on desktop (6 panels, 3 map layers). No server-side enforcement. `api/_api-key.js` validates against static `WORLDMONITOR_VALID_KEYS` env var
- **User dashboard**: none
- **API tier**: none (marketed as separate product)
- **Delivery channels**: none (Slack/Telegram/Discord/WhatsApp/Email)
- **AI briefings**: none (LLM infra exists via Groq but no scheduled briefs)
- **Equity research**: basic quotes only — no financials, analyst targets, valuation metrics

Key architectural constraint: **main app is vanilla TS + Vite (NOT React)**. Only `pro-test/` landing page is React. Clerk must use `@clerk/clerk-js` headless SDK.

**Recommended MVP scope**: Phases 0–4 + tasks 5.1, 5.2 = monetization MVP. Defer Phase 6 XL features until revenue validates demand.

---

## Dependency Graph

```
Phase 0 (Decisions)
  ├──→ Phase 1 (Auth) ────┐
  └──→ Phase 2 (Schema) ──┤
                           ├──→ Phase 3 (Payments) ──→ Phase 4 (Gating)
                           │                                  │
                           │                           ┌──────┼──────┐
                           │                           ▼      ▼      ▼
                           └──────────────────→ Phase 5   Phase 6  Phase 7
                                              (Dashboard) (Pro)    (API)
                                                                     │
                                                                     ▼
                                                              Phase 8 (Enterprise)
```

**Critical path**: Decisions → Auth + Schema (parallel) → Payments → Gating → everything else

---

## Summary

| Phase | P0 | P1 | P2 | P3 | Total |
|-------|----|----|----|----|-------|
| 0: Decisions | 3 | — | — | — | 3 |
| 1: Auth | 2 | 2 | — | — | 4 |
| 2: Schema | 2 | 1 | 1 | — | 4 |
| 3: Payments | 3 | 2 | 1 | — | 6 |
| 4: Gating | 2 | 2 | — | — | 4 |
| 5: Dashboard | — | 2 | 3 | — | 5 |
| 6: Pro Features | — | 5 | 3 | — | 8 |
| 7: API Tier | — | 2 | 2 | — | 4 |
| 8: Enterprise | — | — | — | 10 | 10 |
| **Total** | **12** | **16** | **10** | **10** | **48** |

---

## GitHub Issues

### Phase 0: Foundational Decisions

---

#### Issue #0.1: Select authentication provider

**Title**: `decision: auth provider — Clerk (@clerk/clerk-js headless) vs Convex Auth`

**Labels**: `decision`, `auth`, `P0`
**Priority**: P0 | **Size**: S | **Dependencies**: None

**Description**:
Evaluate and select an authentication provider for WorldMonitor Pro.

**Options**:

1. **Clerk** (recommended) — first-class Convex integration, handles email/social login, webhook sync to Convex. `@clerk/clerk-js` headless SDK for vanilla TS app, `@clerk/clerk-react` for `/pro` React page.
2. **Convex Auth** — built-in, fewer moving parts, but newer and less battle-tested.
3. **Supabase Auth** — battle-tested but adds another infra layer on top of Convex.

**Key constraint**: Main app is vanilla TS + Vite (NOT React). Auth SDK must support headless DOM mounting (`mountSignIn()` / `mountSignUp()`).

**Acceptance criteria**:

- [ ] Decision documented with rationale
- [ ] Prototype: sign-in flow working in vanilla TS with chosen provider
- [ ] Verify Convex webhook sync works (user created in Clerk → user appears in Convex)

---

#### Issue #0.2: Select payment provider

**Title**: `decision: payment provider — Stripe Checkout (hosted) vs embedded`

**Labels**: `decision`, `payments`, `P0`
**Priority**: P0 | **Size**: S | **Dependencies**: None

**Description**:
Select payment processing approach.

**Recommendation**: Stripe Checkout (hosted). Simpler than embedded, handles SCA/3DS automatically, less frontend code. Stripe Customer Portal for billing management.

**Acceptance criteria**:

- [ ] Stripe account configured with test mode
- [ ] Decision documented: hosted vs embedded checkout

---

#### Issue #0.3: API tier architecture decision

**Title**: `decision: API tier architecture — separate Stripe products, independent of Pro plan`

**Labels**: `decision`, `api-tier`, `P0`
**Priority**: P0 | **Size**: S | **Dependencies**: None

**Description**:
The marketing page states API is "separate from Pro — use both or either." Define the entitlement model.

**Decision points**:

- Separate Stripe products: Pro Monthly/Annual + API Starter + API Business
- A user can have Pro (dashboard features) without API access, or API access without Pro
- Single `entitlements` projection table derives access from all active subscriptions
- Rate limits per `rateLimitTier`, not per product

**Acceptance criteria**:

- [ ] Entitlement matrix documented (which endpoints are free/pro/api-only)
- [ ] Schema for `entitlements` projection table designed

---

### Phase 1: Authentication (Weeks 1–2)

---

#### Issue #1.1: Clerk + Convex integration

**Title**: `feat(auth): Clerk + Convex integration — users table, webhook sync`

**Labels**: `auth`, `backend`, `infra`, `P0`
**Priority**: P0 | **Size**: M | **Dependencies**: #0.1

**Description**:
Set up Clerk as the authentication provider and wire it into Convex via webhook.

**Implementation**:

1. Install `@clerk/clerk-js` (vanilla TS main app) + `@clerk/clerk-react` (pro-test React page)
2. Add `users` table to `convex/schema.ts` (see schema in Phase 2)
3. Create Clerk webhook handler as Convex HTTP action:
   - `user.created` → create user in Convex with `clerkId`, `email`, `name`, `plan: "free"`
   - `user.updated` → sync email/name changes
   - `user.deleted` → anonymize/tombstone user records (NOT hard delete audit/billing)
4. Configure environment variables: `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`

**Key files**:

- `convex/schema.ts` — add users table
- `convex/clerk-webhook.ts` — new HTTP action
- `.env.example` — add Clerk env vars

**Acceptance criteria**:

- [ ] User signs up via Clerk → user document created in Convex `users` table
- [ ] User updates profile in Clerk → Convex user updated
- [ ] Webhook signature verified (reject unsigned/invalid requests)
- [ ] Automated: Clerk webhook integration test

---

#### Issue #1.2: Sign-in/sign-up UI in vanilla TS dashboard

**Title**: `feat(auth): sign-in/sign-up UI in vanilla TS dashboard (clerk-js headless)`

**Labels**: `auth`, `frontend`, `P0`
**Priority**: P0 | **Size**: M | **Dependencies**: #1.1

**Description**:
Add authentication UI to the main vanilla TS dashboard using Clerk's headless `@clerk/clerk-js` SDK.

**Implementation**:

1. Initialize `Clerk` instance in app entry point
2. Use `clerk.mountSignIn(element)` / `clerk.mountSignUp(element)` for auth modals
3. Add user avatar + dropdown to existing navbar (sign out, account, billing links)
4. Expose `currentUser` and user entitlements via a service module (`src/services/auth.ts`)
5. Update locked panel CTA from "Join Waitlist" to "Sign Up / Sign In"

**Key files**:

- `src/main.ts` — Clerk initialization
- `src/services/auth.ts` — new auth service
- `src/components/Panel.ts` — update locked panel CTA (line ~300)
- `src/locales/en.json` — update `premium.joinWaitlist` to "Sign In to Unlock"

**Risk**: `@clerk/clerk-js` headless is less documented than React SDK. Prototype `mountSignIn()` early to validate the approach.

**Acceptance criteria**:

- [ ] Sign in / sign up modal works in vanilla TS app
- [ ] User avatar + dropdown in navbar
- [ ] Locked panel CTA says "Sign In to Unlock" (or "Upgrade to Pro" if already signed in as free)
- [ ] Auth state persists across page refreshes

---

#### Issue #1.3: Tauri desktop auth flow

**Title**: `feat(auth): Tauri desktop auth flow — PKCE + deep link callback`

**Labels**: `auth`, `desktop`, `P1`
**Priority**: P1 | **Size**: L | **Dependencies**: #1.1

**Description**:
Implement Clerk auth flow for the Tauri desktop app with proper session persistence.

**Implementation**:

1. Register `worldmonitor://auth/callback` deep link URI scheme in Tauri config
2. Use PKCE OAuth flow (Clerk supports this)
3. On successful callback, store Clerk session token in macOS Keychain via existing `setSecret()` pattern
4. Token lifecycle: refresh on app foreground, auto-refresh if <5min remaining
5. Logout: clear keychain entry + `clerk.signOut()` + invalidate cached entitlements
6. Fallback: if deep link fails, show one-time code flow (email-based)

**Key files**:

- `src-tauri/tauri.conf.json` — register deep link
- `src-tauri/capabilities/default.json` — add deep-link capability
- `src/services/runtime-config.ts` — existing `getSecretState`/`setSecret`

**Risk**: Tauri WKWebView has known limitations. Use system browser for OAuth callback, pass token back via deep link.

**Acceptance criteria**:

- [ ] Sign in works on macOS desktop app
- [ ] Session persists across app restarts (keychain)
- [ ] Token auto-refreshes
- [ ] Sign out clears all cached state

---

#### Issue #1.4: Migrate waitlist registrations to users table

**Title**: `feat(auth): migrate waitlist registrations → users table`

**Labels**: `auth`, `migration`, `P1`
**Priority**: P1 | **Size**: M | **Dependencies**: #1.1

**Description**:
Migrate existing Convex `registrations` table entries to the new `users` table.

**Migration playbook**:

1. **Dry-run**: migrate to staging Convex first, validate counts match
2. **Dedupe**: normalize emails, merge duplicate registrations by `normalizedEmail`
3. **Consent**: existing Turnstile-verified registrations have implicit consent; send "your account is ready" email with opt-out link via Resend
4. **Create Clerk accounts**: use Clerk Admin API to create user accounts for each registration
5. **Preserve data**: copy `referralCode`, `referralCount`, `source`, `appVersion`
6. **Rollback**: keep `registrations` table intact, only deprecate after 30-day validation period
7. **Validation**: post-migration script compares `registrations` count vs `users` count, flags mismatches

**Acceptance criteria**:

- [ ] All waitlist emails have corresponding `users` entries
- [ ] Referral codes and counts preserved
- [ ] "Account ready" emails sent via Resend
- [ ] `registrations` table untouched (rollback safety)
- [ ] Dry-run report shows 0 mismatches

---

### Phase 2: Convex Schema Expansion (Weeks 1–2, parallel with Phase 1)

---

#### Issue #2.1: Core schema — users, subscriptions, entitlements, apiKeys, usage, savedViews, alertRules

**Title**: `feat(backend): users/subscriptions/entitlements/apiKeys/usage/savedViews/alertRules schema`

**Labels**: `backend`, `convex`, `P0`
**Priority**: P0 | **Size**: M | **Dependencies**: #0.1, #0.3

**Description**:
Design and implement the full Convex schema for Pro features.

**Schema**:

```typescript
// New tables alongside existing registrations + counters

users: {
  clerkId: string (indexed),
  email: string (indexed),
  name: string,
  stripeCustomerId?: string (indexed),
  referralCode: string (indexed),
  referralCount: number,
  createdAt: number,
  updatedAt: number,
}

subscriptions: {
  userId: Id<"users"> (indexed),
  stripeSubscriptionId: string (indexed),
  product: "pro" | "api_starter" | "api_business",
  status: "active" | "past_due" | "canceled" | "trialing",
  currentPeriodStart: number,
  currentPeriodEnd: number,
  cancelAtPeriodEnd: boolean,
  createdAt: number,
}

entitlements: {
  userId: Id<"users"> (indexed, unique),
  dashboardTier: "free" | "pro",
  apiTier: "none" | "starter" | "business",
  rateLimitTier: "free_anon" | "free_authed" | "pro" | "api_starter" | "api_business",
  features: string[],           // ["equity_research", "ai_briefs", "saved_views", ...]
  derivedFrom: Id<"subscriptions">[],
  computedAt: number,
}
// Derived projection — recomputed on every subscription change
// Single source of truth for ALL gating decisions

stripeEvents: {
  eventId: string (indexed, unique),
  processedAt: number,
  eventType: string,
}
// Idempotency table — prevents duplicate webhook processing

apiKeys: {
  userId: Id<"users"> (indexed),
  keyHash: string (indexed),     // SHA-256 hash — NEVER store plaintext
  prefix: string,                // first 8 chars for UI identification
  name: string,
  scopes: string[],              // ["read:market", "read:conflict", "*"]
  tier: "starter" | "business",
  expiresAt?: number,
  lastUsedAt?: number,
  createdAt: number,
  revokedAt?: number,
}
// 256-bit random keys (crypto.getRandomValues), prefixed wm_live_ / wm_test_
// Constant-time comparison via crypto.timingSafeEqual on hash

usage: {
  apiKeyId: Id<"apiKeys"> (indexed),
  date: string,                  // YYYY-MM-DD
  endpoint: string,
  count: number,
}

savedViews: {
  userId: Id<"users"> (indexed),
  name: string,
  panels: string[],
  mapLayers: object,
  watchlistSymbols: string[],
  createdAt: number,
}

alertRules: {
  userId: Id<"users"> (indexed),
  name: string,
  type: "threshold" | "event" | "keyword",
  config: object,
  channels: object[],
  enabled: boolean,
  createdAt: number,
}

auditLog: {
  userId: Id<"users"> (indexed),
  action: string,
  resource: string,
  metadata: object,
  ip?: string,
  createdAt: number,
}
// Structured audit for: auth events, key lifecycle, billing changes, entitlement decisions
```

**Key file**: `convex/schema.ts`

**Acceptance criteria**:

- [ ] All tables created with proper indexes
- [ ] Schema passes Convex validation (`npx convex dev`)
- [ ] `entitlements` table has unique constraint on `userId`

---

#### Issue #2.2: User CRUD mutations & queries

**Title**: `feat(backend): user CRUD mutations & queries`

**Labels**: `backend`, `convex`, `P0`
**Priority**: P0 | **Size**: M | **Dependencies**: #2.1

**Description**:
Implement Convex mutations and queries for user management.

**Functions**:

- `users.getByClerkId(clerkId)` — query
- `users.getByApiKey(keyHash)` — query (joins apiKeys → users → entitlements)
- `users.create({ clerkId, email, name })` — mutation (from Clerk webhook)
- `users.update({ userId, ...fields })` — mutation
- `users.anonymize(userId)` — mutation (for account deletion — tombstone PII, preserve audit/billing)
- `entitlements.recompute(userId)` — mutation (rebuild from active subscriptions)
- `entitlements.getByUserId(userId)` — query
- `auditLog.write({ userId, action, resource, metadata, ip })` — mutation

**Acceptance criteria**:

- [ ] CRUD operations work via Convex dashboard
- [ ] `recompute` correctly derives entitlements from multiple subscriptions
- [ ] Anonymize replaces PII with `deleted-{hash}` but preserves audit records
- [ ] Automated: unit tests for entitlement recomputation (free, pro, api_starter, pro+api_business)

---

#### Issue #2.3: API key generation, hashing, and validation

**Title**: `feat(backend): API key generation (wm_live_xxx), hashing, validation`

**Labels**: `backend`, `convex`, `P1`
**Priority**: P1 | **Size**: M | **Dependencies**: #2.1

**Description**:
Implement secure API key lifecycle management.

**Implementation**:

1. **Generation**: 256-bit random via `crypto.getRandomValues()`, prefixed `wm_live_` or `wm_test_`
2. **Storage**: SHA-256 hash only in Convex. Plaintext returned once on creation — never again.
3. **Validation**: constant-time comparison via `crypto.timingSafeEqual` on hashed input
4. **Scopes**: per-key permission list (e.g., `["read:market", "read:conflict", "*"]`)
5. **Expiry**: optional `expiresAt` field
6. **Rotation**: create new key → user confirms → revoke old key
7. **Audit**: all create/revoke/rotate events logged to `auditLog`

**Functions**:

- `apiKeys.create({ userId, name, scopes, tier })` — returns plaintext key ONCE
- `apiKeys.validate(keyHash)` — query, returns entitlements if valid
- `apiKeys.revoke(keyId)` — mutation, sets `revokedAt`
- `apiKeys.listByUser(userId)` — query (returns prefix + metadata, never hash)

**Acceptance criteria**:

- [ ] Key format: `wm_live_<32 hex chars>`
- [ ] Plaintext never stored or logged
- [ ] Revoked keys return 401
- [ ] Expired keys return 401
- [ ] Automated: hash/verify round-trip test, constant-time comparison test

---

#### Issue #2.4: Usage tracking — daily counters

**Title**: `feat(backend): usage tracking — daily counters per API key per endpoint`

**Labels**: `backend`, `convex`, `P2`
**Priority**: P2 | **Size**: S | **Dependencies**: #2.1

**Description**:
Track API usage per key per day for billing and dashboard display.

**Functions**:

- `usage.record(apiKeyId, endpoint)` — mutation (increment or create daily counter)
- `usage.getDaily(apiKeyId, date)` — query
- `usage.getMonthly(apiKeyId, month)` — query (aggregate)

**Acceptance criteria**:

- [ ] Daily counters increment correctly
- [ ] Monthly aggregation sums daily values

---

### Phase 3: Payments — Stripe (Weeks 3–4)

---

#### Issue #3.1: Stripe products and prices

**Title**: `feat(payments): Stripe products — Pro Monthly/Annual + API Starter/Business`

**Labels**: `payments`, `infra`, `P0`
**Priority**: P0 | **Size**: S | **Dependencies**: #0.2

**Description**:
Create Stripe products and price objects for all tiers.

**Products**:

1. **WorldMonitor Pro Monthly** — $X/mo
2. **WorldMonitor Pro Annual** — $X/yr (discount)
3. **WorldMonitor API Starter** — $Y/mo (1,000 req/day, 5 webhook rules)
4. **WorldMonitor API Business** — $Z/mo (50,000 req/day, unlimited webhooks + SLA)

**Environment variables**:

- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRO_MONTHLY_PRICE_ID`, `STRIPE_PRO_ANNUAL_PRICE_ID`
- `STRIPE_API_STARTER_PRICE_ID`, `STRIPE_API_BUSINESS_PRICE_ID`

**Acceptance criteria**:

- [ ] Products created in Stripe test mode
- [ ] Price IDs stored as env vars
- [ ] `.env.example` updated

---

#### Issue #3.2: Checkout flow via Convex HTTP action

**Title**: `feat(payments): checkout flow — Convex HTTP action → Stripe Checkout redirect`

**Labels**: `payments`, `backend`, `P0`
**Priority**: P0 | **Size**: M | **Dependencies**: #2.1, #3.1

**Description**:
Create a Convex HTTP action that generates a Stripe Checkout Session and returns the URL.

**Implementation**:

1. Convex HTTP action receives authenticated user ID + product choice
2. Look up or create Stripe customer (store `stripeCustomerId` on user)
3. Create Stripe Checkout Session with `success_url` and `cancel_url`
4. Return checkout URL for client-side redirect
5. Handle upgrade (free → pro), API tier purchase, and plan switching

**Acceptance criteria**:

- [ ] Authenticated user can initiate checkout
- [ ] Redirects to Stripe Checkout
- [ ] Success URL leads back to dashboard with success message
- [ ] Stripe customer ID stored on user record

---

#### Issue #3.3: Stripe webhook handler

**Title**: `feat(payments): Stripe webhook handler — subscription lifecycle in Convex`

**Labels**: `payments`, `backend`, `P0`
**Priority**: P0 | **Size**: L | **Dependencies**: #3.2

**Description**:
Handle Stripe webhook events to manage subscription lifecycle in Convex.

**Safety requirements**:

- **Signature verification**: `stripe.webhooks.constructEvent()` with `STRIPE_WEBHOOK_SECRET`
- **Idempotency**: check `stripeEvents` table by `event.id` before processing; skip duplicates
- **Event age monitoring**: log alerts for events older than 5 minutes (indicates outage/retry), but do NOT reject them — legitimate Stripe retries can arrive late
- **Subscription reconciliation**: do NOT use a forward-only state machine. Fetch current subscription object via `stripe.subscriptions.retrieve()` and reconcile `status`, `current_period_end`, and `items`. This correctly handles `past_due → active`, resumed subscriptions, and plan switches.
- **Dead-letter**: failed processing logged to `auditLog` with full event payload for manual retry
- **Entitlement recomputation**: every subscription change triggers `recomputeEntitlements(userId)` + Redis cache invalidation

**Webhook events**:

- `checkout.session.completed` → create subscription, link to user, recompute entitlements
- `invoice.paid` → renew subscription period
- `invoice.payment_failed` → update status to `past_due`, send warning email via Resend
- `customer.subscription.updated` → reconcile from Stripe object, recompute entitlements
- `customer.subscription.deleted` → mark canceled, recompute entitlements (downgrade)

**Acceptance criteria**:

- [ ] All 5 webhook events handled correctly
- [ ] Duplicate events are idempotent (no double processing)
- [ ] Entitlements update within seconds of payment
- [ ] Failed webhooks logged for manual retry
- [ ] Automated: webhook contract tests via Stripe CLI `trigger`

---

#### Issue #3.4: Pricing page

**Title**: `feat(payments): pricing page — replace waitlist form with real plans + checkout`

**Labels**: `payments`, `frontend`, `P1`
**Priority**: P1 | **Size**: M | **Dependencies**: #3.2

**Description**:
Replace the current waitlist form on `/pro` with a real pricing page that initiates checkout.

**Implementation**:

- Side-by-side comparison: Free vs Pro vs API vs Enterprise
- Monthly/annual toggle for Pro
- "Get Started" buttons → Clerk sign-in (if not authed) → Stripe Checkout
- "Coming Soon" section for Enterprise with "Contact Sales" CTA
- Integrate with existing i18n (23 languages)

**Acceptance criteria**:

- [ ] Pricing page shows all tiers with features
- [ ] Checkout flow works end-to-end
- [ ] Works in all 23 supported languages

---

#### Issue #3.5: Billing management via Stripe Customer Portal

**Title**: `feat(payments): billing management via Stripe Customer Portal`

**Labels**: `payments`, `frontend`, `P1`
**Priority**: P1 | **Size**: S | **Dependencies**: #3.3

**Description**:
Add a link/button that redirects to Stripe Customer Portal for self-service billing management (update payment method, view invoices, cancel subscription, switch plans).

**Acceptance criteria**:

- [ ] Portal link accessible from `/account/billing`
- [ ] User can update payment method, view invoices, cancel

---

#### Issue #3.6: 14-day free trial for Pro

**Title**: `feat(payments): 14-day free trial for Pro`

**Labels**: `payments`, `backend`, `P2`
**Priority**: P2 | **Size**: S | **Dependencies**: #3.3

**Description**:
Configure Stripe to offer a 14-day trial for Pro tier (no credit card required). Trial expiry → email reminder via Resend. Auto-downgrade on trial end via webhook.

**Acceptance criteria**:

- [ ] Trial activates without credit card
- [ ] Reminder email sent 3 days before trial ends
- [ ] Auto-downgrade on expiry triggers entitlement recomputation

---

### Phase 4: Feature Gating (Week 5)

---

#### Issue #4.1: Server-side entitlement verification in gateway.ts

**Title**: `feat(gating): server-side entitlement verification in gateway.ts`

**Labels**: `gating`, `backend`, `P0`
**Priority**: P0 | **Size**: L | **Dependencies**: #2.2, #2.3

**Description**:
Add entitlement-aware middleware to the server gateway so pro-only endpoints are enforced server-side.

**Implementation**:

1. After `validateApiKey()` (gateway.ts line 161), inject entitlement check
2. Look up user entitlements from Redis cache (`ent:{userId}` or `ent:key:{keyHash}`)
3. If cache miss, query Convex, populate cache with 60s TTL
4. **Active invalidation**: `recomputeEntitlements()` deletes Redis cache entry immediately via Upstash REST API
5. **Fail-closed**: if Redis AND Convex both unavailable, return 503 (never grant unauthorized access)
6. Check endpoint against entitlement matrix
7. Return `403 { error: "Upgrade required", requiredPlan: "pro", upgradeUrl: "/pro" }` for gated endpoints

**Entitlement matrix**:

| Endpoint Category | free_anon | free_authed | pro | api_starter | api_business |
|---|---|---|---|---|---|
| Public data (seismology, news, weather) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Market quotes, crypto, commodities | ✓ | ✓ | ✓ | ✓ | ✓ |
| Equity research (financials, targets) | — | — | ✓ | — | ✓ |
| AI briefs, flash alerts | — | — | ✓ | — | — |
| Economy analytics (correlations) | — | — | ✓ | — | ✓ |
| Risk scoring, scenario analysis | — | — | ✓ | — | ✓ |

**API key migration (dual-read rollout)**:

1. **Phase A**: validate against BOTH static `WORLDMONITOR_VALID_KEYS` AND new entitlements. Log comparison metrics.
2. **Phase B**: after 1 week with 0 mismatches, flip flag to new system only. Keep env var as emergency rollback.
3. **Phase C**: remove static key validation code after 30 days.

**Key files**:

- `server/gateway.ts` — main middleware injection point
- `api/_api-key.js` — extend validation logic
- `server/_shared/rate-limit.ts` — rate limit by entitlement tier

**Acceptance criteria**:

- [ ] Free user gets 403 on equity research endpoint
- [ ] Pro user gets 200 on equity research endpoint
- [ ] API starter gets 200 on data endpoints, 403 on dashboard-only features
- [ ] Fail-closed: 503 when Redis + Convex both down
- [ ] Dual-read metrics dashboard shows match/mismatch counts
- [ ] Automated: E2E entitlement gating tests per tier

---

#### Issue #4.2: Client-side plan context service

**Title**: `feat(gating): client-side plan context service (src/services/plan-context.ts)`

**Labels**: `gating`, `frontend`, `P0`
**Priority**: P0 | **Size**: M | **Dependencies**: #1.2, #2.2

**Description**:
Create a client-side service that exposes user plan/entitlements for UI gating.

**Implementation**:

1. New service: `src/services/plan-context.ts`
2. On auth, query user entitlements from Convex
3. Expose helpers: `isPro()`, `hasApiAccess()`, `getPlan()`, `hasFeature(name)`
4. Replace ALL `getSecretState('WORLDMONITOR_API_KEY').present` checks with plan context
5. Works for both web (Clerk session) and desktop (Clerk + Tauri keychain)
6. Include `computedAt` timestamp for staleness detection

**Key files to update**:

- `src/components/Panel.ts` — replace `getSecretState` check
- `src/components/DeckGLMap.ts` — replace layer premium check
- `src/components/GlobeMap.ts` — replace layer premium check
- `src/app/panel-layout.ts` — replace `_wmKeyPresent` logic

**Acceptance criteria**:

- [ ] `isPro()` returns true for pro users, false for free
- [ ] All `getSecretState('WORLDMONITOR_API_KEY')` references replaced
- [ ] Plan context updates within 60s of subscription change

---

#### Issue #4.3: Refactor panel/layer premium flags

**Title**: `feat(gating): refactor panel/layer premium flags → plan context`

**Labels**: `gating`, `frontend`, `P1`
**Priority**: P1 | **Size**: M | **Dependencies**: #4.2

**Description**:
Update panel and map layer configurations to use the new plan context instead of desktop-only `isDesktopRuntime()` checks.

**Changes**:

- `src/config/panels.ts` — premium flags read from plan context, apply to web AND desktop
- `src/config/map-layer-definitions.ts` — same
- Locked panel CTA: "Upgrade to Pro" → links to pricing page (not waitlist)
- Expand locked panels beyond current 2+4 to cover all pro-tier features

**Acceptance criteria**:

- [ ] Premium gating works on web (not just desktop)
- [ ] Locked panels link to `/pro` pricing page
- [ ] Enhanced panels show "PRO" badge for free users

---

#### Issue #4.4: Per-plan rate limiting

**Title**: `feat(gating): per-plan rate limiting in gateway`

**Labels**: `gating`, `backend`, `P1`
**Priority**: P1 | **Size**: M | **Dependencies**: #4.1

**Description**:
Implement tiered rate limiting based on user plan.

**Rate limits**:

| Tier | Requests/day | Requests/min |
|------|-------------|-------------|
| Free (no auth) | 100 | 5 |
| Free (authenticated) | 500 | 10 |
| Pro | 10,000 | 60 |
| API Starter | 1,000 | 30 |
| API Business | 50,000 | 300 |

**Unauthenticated identity**:

- Key: `cf-connecting-ip` + endpoint path bucket
- **Trusted-proxy rule**: only honor `cf-connecting-ip` from Cloudflare IP ranges. Non-CF sources fall back to actual remote address. Log spoofing attempts.
- Turnstile challenge at 50% daily quota
- Abuse flag at 3x daily limit

**Acceptance criteria**:

- [ ] Free user rate-limited at 100 req/day
- [ ] Pro user rate-limited at 10,000 req/day
- [ ] Rate limit headers returned: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- [ ] Automated: rate limit integration tests per tier

---

### Phase 5: User Dashboard (Weeks 6–7)

---

#### Issue #5.1: Account page

**Title**: `feat(dashboard): /account page — profile, plan badge, API keys`

**Labels**: `dashboard`, `frontend`, `P1`
**Priority**: P1 | **Size**: M | **Dependencies**: #1.2, #2.2, #2.3

**Description**:
Create an account page at `/account` showing profile info, current plan, and API key management.

**Sections**:

1. **Profile**: name, email (from Clerk), avatar
2. **Plan**: current plan badge, expiry date, upgrade button
3. **API Keys**: list keys (prefix only), create, copy (once), revoke, regenerate
4. **Referral**: referral code, count, share link (preserved from waitlist)

**Acceptance criteria**:

- [ ] Profile info displayed from Clerk
- [ ] Plan badge shows current tier
- [ ] API key CRUD works (create shows plaintext once, subsequent views show prefix only)
- [ ] Referral stats visible

---

#### Issue #5.2: Billing page

**Title**: `feat(dashboard): /account/billing — invoices, plan management`

**Labels**: `dashboard`, `frontend`, `P1`
**Priority**: P1 | **Size**: M | **Dependencies**: #3.3

**Description**:
Create a billing page showing current subscription, next payment date, and link to Stripe Customer Portal.

**Sections**:

1. Current plan + next billing date + amount
2. Payment method (last 4 digits)
3. Link to Stripe Customer Portal for self-service management
4. Upgrade/downgrade buttons

**Acceptance criteria**:

- [ ] Shows current plan and billing cycle
- [ ] Stripe portal link works
- [ ] Upgrade/downgrade triggers new checkout

---

#### Issue #5.3: API usage stats

**Title**: `feat(dashboard): API usage stats with daily/monthly charts`

**Labels**: `dashboard`, `frontend`, `P2`
**Priority**: P2 | **Size**: M | **Dependencies**: #2.4, #5.1

**Description**:
Display API usage charts on the account page (daily and monthly breakdowns).

**Acceptance criteria**:

- [ ] Daily usage bar chart
- [ ] Monthly aggregation
- [ ] Per-endpoint breakdown

---

#### Issue #5.4: Notification preferences & delivery channels

**Title**: `feat(dashboard): notification preferences & delivery channels config`

**Labels**: `dashboard`, `frontend`, `P2`
**Priority**: P2 | **Size**: M | **Dependencies**: #5.1

**Description**:
Settings page for configuring notification delivery channels (Slack webhook URL, Telegram bot, Discord webhook, email preferences).

**Acceptance criteria**:

- [ ] Add/remove delivery channels
- [ ] Test notification button per channel
- [ ] Channel credentials encrypted at rest

---

#### Issue #5.5: API documentation page

**Title**: `feat(docs): interactive API docs page with OpenAPI 3.1 from proto defs`

**Labels**: `dashboard`, `docs`, `P2`
**Priority**: P2 | **Size**: L | **Dependencies**: #4.1

**Description**:
Generate OpenAPI 3.1 spec from existing sebuf proto definitions (50+ RPCs across 15+ domains). Host interactive API explorer.

**Implementation**:

- Parse proto files with `(sebuf.http.config)` annotations
- Generate OpenAPI 3.1 spec
- Host via Swagger UI or Redoc at `/developers` or `/api/docs`
- Per-endpoint plan requirements documented
- Code examples in curl, Python, JS/TS

**Acceptance criteria**:

- [ ] OpenAPI spec covers all public endpoints
- [ ] Interactive explorer works
- [ ] Plan requirements shown per endpoint

---

### Phase 6: Pro Features (Weeks 8–12)

---

#### Issue #6.1: Equity research data pipeline

**Title**: `feat(pro): equity research — financials, analyst targets, valuation metrics`

**Labels**: `pro-feature`, `backend`, `P1`
**Priority**: P1 | **Size**: XL | **Dependencies**: #4.1

**Description**:
Build a new data pipeline for equity research features (pro-only).

**Data to add**:

- Financial statements (income, balance sheet, cash flow)
- Analyst consensus price targets
- Valuation metrics (PE, PB, EV/EBITDA)
- Earnings calendar

**Sources** (evaluate): Finnhub premium, Financial Modeling Prep (FMP), Alpha Vantage

**Implementation**:

- New sebuf proto service: `worldmonitor/equity/v1/`
- RPCs: `get-company-financials`, `get-analyst-consensus`, `get-valuation-metrics`, `list-earnings-calendar`
- Redis caching via `cachedFetchJson` pattern
- New panel: Equity Research dashboard (pro-only, gated via entitlements)

**Acceptance criteria**:

- [ ] Financial data available for major US stocks
- [ ] Analyst targets displayed with consensus rating
- [ ] Equity panel shows for pro users, locked for free
- [ ] Data refreshes at least daily

---

#### Issue #6.2: AI daily briefs engine

**Title**: `feat(pro): AI daily briefs engine — scheduled LLM summaries`

**Labels**: `pro-feature`, `backend`, `P1`
**Priority**: P1 | **Size**: XL | **Dependencies**: #4.1, #6.5

**Description**:
Build a scheduled AI briefing system that synthesizes overnight developments and delivers via configured channels.

**Implementation**:

1. Cron job (Railway or Convex cron) runs at configurable time per user timezone
2. Aggregates latest data from Redis bootstrap keys (40+ keys exist)
3. Ranks events by user's configured focus areas (markets, geopolitics, energy, etc.)
4. Generates structured brief via Groq LLM (infrastructure exists in `deduct-situation.ts`)
5. Stores brief in Convex `briefs` table
6. Delivers via configured channels (email, Slack, Telegram, Discord)

**Flash alerts**: real-time event detection → LLM classification (existing `classify-event` RPC) → push notification

**Acceptance criteria**:

- [ ] Daily brief generated and delivered
- [ ] Focus areas configurable per user
- [ ] Brief stored and viewable in dashboard
- [ ] Flash alerts delivered within 5 minutes of event

---

#### Issue #6.3: Sub-60s data refresh

**Title**: `feat(pro): sub-60s data refresh for pro users`

**Labels**: `pro-feature`, `backend`, `P1`
**Priority**: P1 | **Size**: L | **Dependencies**: #4.1

**Description**:
Reduce data refresh interval for pro users from 5-15 minutes to <60 seconds.

**Phased approach**:

1. **Phase 1**: reduce client-side polling interval based on plan (simplest — just change `DataLoaderManager` interval for pro users)
2. **Phase 2**: Server-Sent Events (SSE) for high-frequency data (markets, alerts) — push new data as it arrives

**Acceptance criteria**:

- [ ] Pro users see data refresh <60s
- [ ] Free users unchanged (5-15 min)
- [ ] Server load monitored (10x more requests from pro)

---

#### Issue #6.4: Server-side watchlists & custom views

**Title**: `feat(pro): persistent server-side watchlists & custom views`

**Labels**: `pro-feature`, `fullstack`, `P1`
**Priority**: P1 | **Size**: M | **Dependencies**: #2.1, #4.2

**Description**:
Migrate watchlists from localStorage to Convex `savedViews` table for cross-device sync.

**Currently localStorage-only**:

- `src/services/market-watchlist.ts`
- `src/services/aviation/watchlist.ts`

**Implementation**:

- On first sign-in, import existing localStorage watchlists to Convex
- Sync changes bidirectionally (Convex → client on load, client → Convex on change)
- Cross-device sync (web ↔ desktop)

**Acceptance criteria**:

- [ ] Watchlists persist across devices
- [ ] localStorage data migrated on first sign-in
- [ ] Offline-first: works without connection, syncs on reconnect

---

#### Issue #6.5: Delivery channels — Slack, Telegram, Discord, Email

**Title**: `feat(pro): delivery channels — Slack, Telegram, Discord, Email`

**Labels**: `pro-feature`, `backend`, `P1`
**Priority**: P1 | **Size**: XL | **Dependencies**: #2.1

**Description**:
Build multi-channel delivery infrastructure for AI briefs and alerts.

**Channels** (in priority order):

1. **Email** — Resend (already integrated). Extend for formatted briefs/alerts.
2. **Slack** — incoming webhook URL (user provides). Format messages with blocks.
3. **Telegram** — Bot API. Create `@WorldMonitorBot`. User starts conversation, store `chat_id`.
4. **Discord** — webhook URL (user provides). Format with embeds.
5. **WhatsApp** — P3 (requires Twilio/Meta business verification, highest cost)

**Security**:

- Webhook URL allowlisting: only `hooks.slack.com`, `discord.com/api/webhooks`, Telegram API
- Secrets encrypted via server-managed envelope encryption (`APP_ENCRYPTION_KEY` env var)
- PII redacted from outbound payloads
- Per-channel signing/verification where supported

**Acceptance criteria**:

- [ ] Email delivery works (formatted brief)
- [ ] Slack webhook delivery works
- [ ] Telegram bot delivery works
- [ ] Discord webhook delivery works
- [ ] Secrets encrypted at rest
- [ ] Test notification button per channel

---

#### Issue #6.6: Economy analytics — correlation views

**Title**: `feat(pro): economy analytics — GDP/inflation/rates correlation views`

**Labels**: `pro-feature`, `frontend`, `P2`
**Priority**: P2 | **Size**: L | **Dependencies**: #4.1

**Description**:
Build correlation views on top of existing economic data (FRED, BIS, World Bank RPCs already exist).

**New visualizations**:

- GDP growth vs market performance
- Inflation trends vs central bank rates
- Growth cycle detection and labeling
- Cross-country comparison charts

**Acceptance criteria**:

- [ ] Correlation charts display correctly
- [ ] Data from existing FRED/BIS/World Bank endpoints
- [ ] Pro-only (gated via entitlements)

---

#### Issue #6.7: Risk monitoring — convergence alerting & scenario analysis

**Title**: `feat(pro): risk monitoring — convergence alerting & scenario analysis`

**Labels**: `pro-feature`, `fullstack`, `P2`
**Priority**: P2 | **Size**: L | **Dependencies**: #4.1

**Description**:
Enhance existing risk analytics with scenario analysis and convergence alerting.

**Existing engines** (enhance, don't rebuild):

- `src/services/geo-convergence.ts` — convergence detection
- `src/services/focal-point-detector.ts` — focal point detection
- `src/services/country-instability.ts` — CII scoring
- `src/services/signal-aggregator.ts` — signal aggregation

**New**:

- Scenario analysis UI (what-if modeling)
- Convergence alerting (push when signals converge in a region)
- Risk trend visualization over time

**Acceptance criteria**:

- [ ] Scenario analysis UI works
- [ ] Convergence alerts delivered via configured channels
- [ ] Pro-only (gated via entitlements)

---

#### Issue #6.8: 22-services-1-key

**Title**: `feat(pro): 22-services-1-key — replace BYOK with Pro key for all services`

**Labels**: `pro-feature`, `fullstack`, `P1`
**Priority**: P1 | **Size**: M | **Dependencies**: #4.1

**Description**:
Pro users should NOT need to configure individual API keys for Finnhub, FRED, ACLED, etc. A single WorldMonitor Pro subscription gives access to all 22 services.

**Implementation**:

- Server-side: pro requests use WorldMonitor's own upstream API keys (already configured as env vars)
- Free tier: continues using BYOK via desktop settings panel
- Gateway identifies pro user → skips BYOK requirement → uses server-side keys for upstream calls

**Key files**:

- `src/services/settings-constants.ts` — 20+ key definitions
- `server/gateway.ts` — skip BYOK check for pro users

**Acceptance criteria**:

- [ ] Pro user sees data without configuring any individual API keys
- [ ] Free user still uses BYOK
- [ ] No upstream API key leakage to client

---

### Phase 7: API Tier (Weeks 10–14, separate product)

---

#### Issue #7.1: API key issuance & management portal

**Title**: `feat(api-tier): API key issuance & management portal`

**Labels**: `api-tier`, `fullstack`, `P1`
**Priority**: P1 | **Size**: M | **Dependencies**: #2.3, #5.1

**Description**:
Extend the account page with API key management specifically for API tier subscribers.

**Features**:

- Create multiple keys with different names/scopes
- View usage per key
- Rotate keys (create new → confirm → revoke old)
- Set per-key rate limits within tier allowance

**Acceptance criteria**:

- [ ] Multiple keys can be created
- [ ] Per-key usage visible
- [ ] Key rotation flow works

---

#### Issue #7.2: Per-key usage tracking with daily limits

**Title**: `feat(api-tier): per-key usage tracking with daily limits`

**Labels**: `api-tier`, `backend`, `P1`
**Priority**: P1 | **Size**: M | **Dependencies**: #2.4, #4.4

**Description**:
Track and enforce daily usage limits per API key based on tier (Starter: 1,000/day, Business: 50,000/day).

**Implementation**:

- Increment `usage` counter on each request
- Check daily total before processing
- Return `429` with `Retry-After` header when limit exceeded
- Dashboard shows usage vs limit

**Acceptance criteria**:

- [ ] Daily limit enforced per key
- [ ] 429 returned with retry info when exceeded
- [ ] Usage dashboard shows consumption

---

#### Issue #7.3: OpenAPI 3.1 spec from sebuf protos

**Title**: `feat(api-tier): OpenAPI 3.1 spec auto-generation from sebuf protos`

**Labels**: `api-tier`, `docs`, `P2`
**Priority**: P2 | **Size**: L | **Dependencies**: None

**Description**:
Auto-generate OpenAPI 3.1 specification from existing sebuf proto definitions.

**Acceptance criteria**:

- [ ] Spec covers all public RPC endpoints
- [ ] Plan requirements documented per endpoint
- [ ] Code examples in curl, Python, JS/TS

---

#### Issue #7.4: Webhook delivery system

**Title**: `feat(api-tier): webhook delivery system with retry & HMAC signatures`

**Labels**: `api-tier`, `backend`, `P2`
**Priority**: P2 | **Size**: L | **Dependencies**: #7.1

**Description**:
Allow API tier subscribers to configure webhook endpoints for event delivery.

**Implementation**:

- Convex table: `webhookEndpoints` (userId, url, events, secret)
- HMAC-SHA256 signature on each delivery
- Exponential backoff retry (3 attempts)
- Starter: 5 webhook rules; Business: unlimited
- Delivery log with status codes

**Acceptance criteria**:

- [ ] Webhook delivery works with signature
- [ ] Failed deliveries retried with backoff
- [ ] Tier limits enforced

---

### Phase 8: Enterprise (Months 4–12+, all P3)

---

#### Issue #8.1: Organization accounts & team management

**Title**: `feat(enterprise): organization accounts & team management`

**Labels**: `enterprise`, `fullstack`, `P3`
**Priority**: P3 | **Size**: XL | **Dependencies**: #1.1

**Description**:
Multi-user organizations with shared dashboards, seat management, and invite flow.

---

#### Issue #8.2: RBAC

**Title**: `feat(enterprise): RBAC (role-based access control)`

**Labels**: `enterprise`, `backend`, `P3`
**Priority**: P3 | **Size**: L | **Dependencies**: #8.1

**Description**:
Role-based access: admin, analyst, viewer. Per-role permissions for panels, data access, and configuration.

---

#### Issue #8.3: SSO (SAML/OIDC)

**Title**: `feat(enterprise): SSO (SAML/OIDC via Clerk Enterprise)`

**Labels**: `enterprise`, `auth`, `P3`
**Priority**: P3 | **Size**: L | **Dependencies**: #8.1

**Description**:
Enterprise SSO via Clerk's Enterprise plan. Requires Clerk Enterprise subscription.

---

#### Issue #8.4: TV/SOC display mode

**Title**: `feat(enterprise): TV/SOC display mode`

**Labels**: `enterprise`, `frontend`, `P3`
**Priority**: P3 | **Size**: M | **Dependencies**: None

**Description**:
Full-screen dashboard for wall displays with auto-rotating panels and custom layouts. Some exists in `src/services/tv-mode.ts`.

---

#### Issue #8.5: White-label & embeddable panels

**Title**: `feat(enterprise): white-label & embeddable panels`

**Labels**: `enterprise`, `frontend`, `P3`
**Priority**: P3 | **Size**: XL

**Description**:
Your brand, your domain, your desktop app. Embeddable iframe panels (50+ available).

---

#### Issue #8.6: Satellite imagery & SAR integration

**Title**: `feat(enterprise): satellite imagery & SAR integration`

**Labels**: `enterprise`, `backend`, `P3`
**Priority**: P3 | **Size**: XL

**Description**:
Live-edge satellite imagery and SAR (Synthetic Aperture Radar) with change detection. Requires partnerships with Maxar/Planet.

---

#### Issue #8.7: AI agents with investor personas & MCP

**Title**: `feat(enterprise): AI agents with investor personas & MCP`

**Labels**: `enterprise`, `backend`, `P3`
**Priority**: P3 | **Size**: XL

**Description**:
Autonomous intelligence agents using Model Context Protocol. Connect as tool to Claude, GPT, or custom LLMs.

---

#### Issue #8.8: 100+ data connectors

**Title**: `feat(enterprise): 100+ data connectors`

**Labels**: `enterprise`, `backend`, `P3`
**Priority**: P3 | **Size**: XL

**Description**:
PostgreSQL, Snowflake, Splunk, Sentinel, Jira, Slack, Teams. Export to PDF, PowerPoint, CSV, GeoJSON. Multi-quarter effort.

---

#### Issue #8.9: On-premises / air-gapped deployment

**Title**: `feat(enterprise): on-premises / air-gapped deployment`

**Labels**: `enterprise`, `infra`, `P3`
**Priority**: P3 | **Size**: XL

**Description**:
Docker-based on-premises deployment with air-gapped option. Full architecture rethink required — currently all cloud-native (Vercel + Convex + Railway).

---

#### Issue #8.10: Android TV app

**Title**: `feat(enterprise): Android TV app`

**Labels**: `enterprise`, `frontend`, `P3`
**Priority**: P3 | **Size**: XL

**Description**:
Dedicated Android TV app for SOC walls and trading floors. Separate codebase.

---

## Key Risks

1. **Vanilla TS + Clerk**: `@clerk/clerk-js` headless is less documented than React SDK. Prototype early.
2. **Edge + Convex plan lookups**: Vercel Edge can't import Convex. Must cache in Upstash Redis with active invalidation on webhook events.
3. **Sub-60s refresh at scale**: 10x more requests from pro users. SSE/WebSocket needed long-term.
4. **API as separate product**: Multiple Stripe subscriptions per user adds billing complexity. `entitlements` projection table mitigates scattered logic.
5. **Desktop auth + Tauri WKWebView**: Known limitations. PKCE flow with `worldmonitor://` deep link callback.
6. **API key migration outage**: Dual-read rollout (old + new in parallel) with comparison metrics before cutover.

## Observability & Operations

- **Audit logging**: all auth events, key lifecycle, billing changes, entitlement decisions → `auditLog` table
- **Structured metrics**: entitlement cache hit/miss ratio, webhook processing latency, API key validation latency
- **Alerting**: Slack/PagerDuty for webhook failures, entitlement errors, rate limit abuse spikes
- **Incident rollback plan**:
  - Auth cutover: feature flag to disable Clerk and revert to static API key validation
  - Payment cutover: Stripe test mode for staging; webhook replay via Stripe Dashboard
  - Migration rollback: `registrations` table preserved 30 days alongside `users`

## Data Retention & Privacy

- **API usage data**: retained 90 days, then aggregated to monthly summaries
- **Audit logs**: retained 1 year, then archived to cold storage
- **AI-generated briefs**: retained 30 days per user, older briefs auto-deleted
- **PII handling**: email + name stored in Convex (encrypted at rest). No PII in Redis cache. No PII in outbound delivery payloads.
- **Account deletion**: Clerk `user.deleted` webhook → delete user data. **Audit logs and billing records are NOT deleted** — user identifiers anonymized/tombstoned (`deleted-{hash}`). Stripe customer marked deleted; invoice history retained by Stripe.
