# Pro monetization — current architecture

**Last verified**: 2026-04-21 against `origin/main @ 2f19d9635`.

Factual snapshot of how authentication, payments, entitlements, and billing management work today. Not aspirational. If you're reading this because `docs/roadmap-pro.md` said something different, that document is archived at [`docs/plans/archive/roadmap-pro-HISTORICAL.md`](../plans/archive/roadmap-pro-HISTORICAL.md) — ignore it.

## Stack at a glance

| Concern | Provider | Primary entry points |
|---|---|---|
| Auth | **Clerk** (`@clerk/clerk-js` headless on main app, `@clerk/clerk-react` on `/pro`) | `src/services/clerk.ts`, `pro-test/src/services/checkout.ts` |
| Payments | **Dodo Payments** (hosted overlay + full-page return) | `convex/lib/dodo.ts`, `dodopayments-checkout` npm SDK |
| Entitlements | **Convex** (`subscriptions` + `entitlements` tables, reactive WebSocket) | `convex/payments/*`, `src/services/entitlements.ts`, `src/services/billing.ts` |
| Referral attribution | **Dodo → Affonso** (via `metadata.affonso_referral` contract) | `convex/payments/checkout.ts:131`, `convex/payments/subscriptionHelpers.ts:299` |
| Billing portal | **Dodo customer portal** | `api/customer-portal.ts`, `convex/payments/billing.ts`, `src/services/billing.ts:openBillingPortal` |
| Gateway auth | Clerk bearer JWT + `validateBearerToken` | `server/auth-session.ts`, `api/create-checkout.ts` |

## Tier model

Products are Dodo `productId`s stored client-side in `pro-test/src/generated/tiers.json` and served at runtime from `https://api.worldmonitor.app/api/product-catalog`:

- **Free** — `price: 0`, no productId, card links to dashboard.
- **Pro Monthly** — `pdt_0Nbtt71uObulf7fGXhQup` ($39.99/mo).
- **Pro Annual** — `pdt_0NbttMIfjLWC10jHQWYgJ` ($399.99/yr, ~17% discount).
- **API Starter** — `pdt_0NbttVmG1SERrxhygbbUq` ($99.99/mo, 1k req/day).
- **API Annual** — `pdt_0Nbu2lawHYE3dv2THgSEV` ($999/yr).
- **Enterprise** — `mailto:enterprise@worldmonitor.app` (contact sales).

## Auth — Clerk

- **Init**: `src/services/clerk.ts` exposes `initClerk()`, `openSignIn()`, `signOut()`, `getClerkToken()` (50s cached, in-flight deduped, generation-guarded against account-switch races).
- **UserButton**: mounted by `src/components/AuthHeaderWidget.ts` when signed in; `"Sign In"` button when signed out.
- **JWT template**: `"convex"` preferred (carries `plan` claim for faster server checks); falls back to default session token.
- **`/pro` surface**: lazily loads `@clerk/clerk-js` via `pro-test/src/services/checkout.ts:ensureClerk()`, styled to match marketing page.
- **Desktop (Tauri)**: Clerk session token stored in macOS Keychain; deep-link callback wiring under `src-tauri/`.
- **Auth state**: `src/services/auth-state.ts` centralizes the current session; subscribers include billing watch, entitlement watch, referral service, auth header widget.

## Payments — Dodo

### Checkout creation

Two Convex actions at `convex/payments/checkout.ts`:

- `createCheckout` (public action): Convex/Clerk auth.
- `internalCreateCheckout` (internal action): called by `/relay/create-checkout` with trusted userId from the edge gateway.

Both share `_createCheckoutSession()` which:

1. Validates `returnUrl` against an allow-listed set of worldmonitor.app origins.
2. Builds metadata: `wm_user_id` (HMAC-signed via `convex/lib/identitySigning.ts`) + optional `affonso_referral`.
3. Calls `checkout()` from `convex/lib/dodo.ts`.
4. Returns `{ checkout_url }` for overlay open or full-page redirect.

### Duplicate guard

Before creating a session, `getCheckoutBlockingSubscription` checks for active/on_hold/cancelled subs. If one exists, throws/returns `ACTIVE_SUBSCRIPTION_EXISTS` with the blocking plan info — clients route the user to billing portal instead of creating a second sub.

### Overlay vs full-page flow

- **Overlay** (main app): `src/services/checkout.ts:openCheckout()` uses `DodoPayments.Checkout.open()` with `manualRedirect: true`. On success, a sessionStorage flag (`wm-post-checkout`) is set and the page reloads. Post-reload, `consumePostCheckoutFlag()` + entitlement transition detector show the success banner and unlock panels.
- **Full-page return** (fallback / `/pro` path): Dodo redirects to `worldmonitor.app/?subscription_id=...&status=active`. `src/services/checkout-return.ts:handleCheckoutReturn()` reads params, cleans the URL, returns success boolean.

### Webhook → subscription lifecycle

`convex/payments/subscriptionHelpers.ts` handles Dodo webhook events (`subscription.active`, `subscription.renewed`, `subscription.updated`, `payment.succeeded`, refunds). On first `subscription.active`, writes `subscriptions` row, recomputes `entitlements`, and credits referral attribution if `metadata.affonso_referral` matches a `userReferralCodes` row.

## Entitlements — Convex

- **Schema**: `subscriptions` (userId, planKey, status, currentPeriodEnd, dodoSubscriptionId) + `entitlements` (userId, tier, validUntil, derived from subscriptions).
- **Reactive watch**: `src/services/billing.ts:initSubscriptionWatch()` subscribes to `getSubscriptionForUser` over WebSocket. Updates fire within seconds of webhook processing.
- **Panel gating**: `src/services/entitlements.ts` exposes `isEntitled()`, `hasTier()`; `panel-layout.ts` reloads on free→pro transition so locked panels unlock without manual refresh.
- **Cache invalidation**: entitlement changes delete the Redis cache entry via Upstash REST API before the reload.

## Billing management

- **Entry point**: `UnifiedSettings.ts:450` renders a `<button class="manage-billing-btn">Manage Billing</button>` inside the settings modal.
- **Edge gateway**: `api/customer-portal.ts` validates Clerk bearer, relays to `/relay/customer-portal` on Convex, which calls Dodo to mint a user-scoped portal session.
- **Client-side**: `src/services/billing.ts:openBillingPortal()` fetches the portal URL via Convex action and opens in a new tab. Falls back to `https://customer.dodopayments.com` (generic portal) on any failure.
- **/pro parallel**: `pro-test/src/services/checkout.ts:openBillingPortal()` is triggered when a `/pro`-origin checkout hits `ACTIVE_SUBSCRIPTION_EXISTS`; currently redirects via `window.location.assign()` (same-tab).
- **Payment failures**: `src/components/payment-failure-banner.ts` renders a persistent red banner when subscription status is `on_hold`; auto-hides on return to `active`.

## Referral attribution

- **Code generation**: `/api/referral/me.ts` (edge, Clerk-auth'd) returns `{ code, shareUrl }` where `code` is a deterministic 8-char HMAC of the Clerk userId using `BRIEF_URL_SIGNING_SECRET`. Background binding into Convex via `ctx.waitUntil` — non-blocking on purpose (see module docstring for rationale).
- **Share link**: `https://worldmonitor.app/pro?ref=<code>`.
- **Attribution point**: recipient's checkout metadata carries `affonso_referral: <code>` (vendor contract — Dodo → Affonso referral tool; **do not rename**). On first `subscription.active` webhook, `subscriptionHelpers.ts:299` looks up the code in `userReferralCodes` and inserts a `userReferralCredits` row crediting the sharer.
- **Known gap**: referral code propagation from the dashboard-origin checkout path is incomplete (see the current UX hardening plan, PR-14).

## Security & auth surfaces

- **Edge endpoints** that accept Clerk JWTs must go through `validateBearerToken` (`server/auth-session.ts`). Applies to `/api/create-checkout`, `/api/customer-portal`, `/api/referral/me`.
- **Middleware UA guard** (`middleware.ts`): short-UA guard 403s non-browser fetches by default. New API endpoints called from Railway cron must be added to `PUBLIC_API_PATHS`.
- **Gateway premium check** (`server/gateway.ts`): accepts either Clerk `publicMetadata.plan === 'pro'` role OR Convex `entitlements.tier >= 1 && validUntil >= now`. Both signals must agree for a request to be treated as paid.
- **CORS**: Cloudflare Worker `api-cors-preflight` is the source of truth for `api.worldmonitor.app`. Overrides `api/_cors.js` + `vercel.json`.
- **HMAC identity bridge**: Dodo metadata `wm_user_id` is signed with a server-side key (`convex/lib/identitySigning.ts`) so webhooks can trust the user association without an additional lookup.

## Known gaps & active work

See [`docs/plans/2026-04-21-002-feat-harden-auth-checkout-flow-ux-plan.md`](../plans/2026-04-21-002-feat-harden-auth-checkout-flow-ux-plan.md) for the 14-PR rollout covering:

- Explicit Sign Up entry + Settings button next to header avatar (PR-1)
- Checkout attempt lifecycle + failed-return banner with retry (PR-2)
- Error taxonomy + inline error surfaces (PR-3)
- Reload ownership + extended "still unlocking" state (PR-4)
- Referral propagation through all entry paths (PR-14)
- Billing portal tab-behavior unification (PR-7)
- Declined-payment retry UX
- First-login welcome flow (deferred — needs server-side `users.welcomeSeenAt`)

See also the complementary plan [`2026-04-18-001-fix-pro-activation-race-and-duplicate-checkout-guard-plan.md`](../plans/2026-04-18-001-fix-pro-activation-race-and-duplicate-checkout-guard-plan.md) for the entitlement-activation race fix that PR-4 hard-depends on.

## File index (quick reference)

```
src/services/
├── clerk.ts                  # Clerk init + token cache
├── auth-state.ts             # Central auth session
├── billing.ts                # Subscription watch + openBillingPortal
├── entitlements.ts           # Reactive entitlement state
├── checkout.ts               # Dodo overlay orchestration
├── checkout-return.ts        # Post-checkout URL param handling
└── referral.ts               # Share-link fetch + Web Share API

src/components/
├── AuthHeaderWidget.ts       # Signed-in/out header UI
├── AuthLauncher.ts           # Clerk modal launcher
├── UnifiedSettings.ts        # Settings modal (Manage Billing lives here)
└── payment-failure-banner.ts # on_hold red banner

convex/payments/
├── checkout.ts               # createCheckout + internalCreateCheckout
├── subscriptionHelpers.ts    # Webhook → subscription lifecycle
├── webhookMutations.ts       # Idempotent webhook event processing
└── billing.ts                # getSubscriptionForUser + getCustomerPortalUrl

api/
├── create-checkout.ts        # Edge gateway → Convex relay
├── customer-portal.ts        # Edge gateway → Dodo portal session
└── referral/me.ts            # Clerk-auth'd share-link endpoint

pro-test/src/                 # React marketing page
├── App.tsx                   # /pro landing
├── components/PricingSection.tsx
└── services/checkout.ts      # /pro-origin Clerk + Dodo
```
