---
title: "Lifecycle emails addressed to the Dodo checkout email, not the Clerk login email, look like scams and failed sends"
module: billing-identity
date: 2026-08-08
category: architecture-patterns
problem_type: architecture_pattern
component: payments
severity: medium
applies_when:
  - "Triaging a \"paid but can't log in\" support ticket, especially from an email address the product has no account for"
  - "The billing provider (Dodo Payments) and the auth provider (Clerk) can each hold a different email address for the same customer"
  - "A lifecycle or welcome email is addressed from the payment provider's checkout email rather than the auth provider's login email"
  - "Searching an email platform (e.g. Resend) by a customer's login email returns no results, which looks like a send failure but is actually an identity mismatch"
  - "Confirming which account a payment reached: use the checkout session's linked user id in metadata, not any email address, as the source of truth"
symptoms:
  - "Customer email claims 'paid for Pro and can't log in' from an address that has no Clerk account"
  - "Convex entitlement lookup for the correct userId already shows valid, paid coverage, contradicting the ticket"
  - "Searching the email platform by the customer's stated login email returns zero sends, which looks like a missing welcome email"
  - "The welcome email was delivered and clicked, but to a third address: the checkout billing email, not the login email"
related_components:
  - authentication
  - email_processing
tags:
  - dodo-payments
  - clerk
  - resend
  - entitlements
  - identity-mismatch
  - support-triage
  - welcome-email
  - checkout-vs-login-email
---

# Lifecycle emails addressed to the Dodo checkout email, not the Clerk login email, look like scams and failed sends

## Context

A support email arrived on 2026-08-08 with the subject energy of a chargeback: *"URGENT! Account not working after payment! … I hope this is not a scam!"* The customer had paid, and the login screen told them the account was not known.

Nothing was broken. The payment succeeded, the entitlement was written correctly, and the welcome email was delivered and clicked. What failed was identity: the buyer received a "your subscription is now active" email at one address, tried to sign in with that address, and World Monitor had never heard of it. Their actual account was registered under a different address entirely.

This is not a regression, and no amount of staring at the entitlement pipeline finds it — the pipeline is green the whole way through. It is a design seam between the billing provider's notion of a customer (an email typed at checkout) and Clerk's notion of a user (an email that owns a sign-in). Any user who keeps aliases — and privacy-minded users keep many — can land on the wrong side of it.

The recipe below is the reusable part: it separates "our billing is broken" from "this person is signed in as someone else" in about five API calls, and it names the three ops traps that make the healthy case look like a failure.

## Guidance

### The diagnosis recipe for any "paid but can't log in" / "paid but no Pro" ticket

Run these in order. The point of the order is that each step narrows the failure class, and by step (d) you can already tell a real regression from an identity mix-up.

**(a) Resolve the Dodo customer.** Look them up by `cus_…` id if the ticket carries one, or by `?email=` using every address in the thread. Note that the billing email here is whatever the buyer typed into the checkout form — it is *not* authenticated and it is *not* an account.

**(b) Read `metadata.wm_user_id` on the subscription and payment records.** This is the ground truth for "who bought this," and it is independent of any email. WorldMonitor stamps the signed Clerk identity onto the checkout session at `convex/payments/checkout.ts:201-202`:

```ts
metadata.wm_user_id = user.userId;
metadata.wm_user_id_sig = await signUserId(user.userId);
```

The webhook side trusts it only when the HMAC verifies — `tryResolveUserId` in `convex/payments/subscriptionHelpers.ts:667-680` returns the metadata userId on a valid signature, warns and falls through on an invalid or unsigned one, and only then drops to a `customers`-table lookup by `dodoCustomerId` (`convex/payments/subscriptionHelpers.ts:682-689`). So a signed `wm_user_id` tells you exactly which Clerk account was logged in at the moment of purchase, no matter what the buyer typed.

**(c) Look up that Clerk user's login email — and search Clerk for *every* address in the ticket.** Both halves matter. The first tells you where the account actually lives; the second proves whether the other addresses are accounts at all, or just inboxes. A ticket where the support-sender address, the checkout address, and the login address are three different aliases of one person is the signature of this failure mode.

**(d) Query Convex entitlements for that userId** (`POST $CONVEX_SITE_URL/api/internal-entitlements` with the shared secret). Check `planKey`, `validUntil`, and `tier`. This is the decision point.

**(e) List Resend sends** to see where the lifecycle email actually went, and read `last_event`. A `clicked` event on the checkout address is positive proof the buyer read the welcome mail — and therefore proof of which address they will try to sign in with.

### The decision point

| Entitlement for `wm_user_id` | Login email vs checkout email | Verdict |
| --- | --- | --- |
| Correct plan and expiry | Different addresses | Identity mix-up. Not a regression. Reply with the real login address. |
| Missing, wrong plan, or downgraded | Any | Real pipeline defect. Escalate to the webhook/entitlement path. |
| Correct | Same address | Look elsewhere — Clerk sign-in method, deliverability, or a genuinely different account. |

Do not skip step (d) because the ticket sounds urgent. "Entitlement is correct" is what converts a possible P0 into a reply-and-close, and it is one call.

### Ops traps that make a healthy system look broken

Three separate false negatives, all encountered in this investigation:

**Searching Resend for the login email finds nothing.** It looks exactly like a send failure. It is not — the email was addressed to the *checkout* email, which is the whole bug. Always search Resend for every alias, not just the one the account uses.

**The `RESEND_API_KEY` in `.env.local` is a restricted, send-only key.** Any list/search call returns `401 restricted_api_key`, which reads like an outage or a revoked key. Use `RESEND_BROADCASTS_API_KEY` to enumerate sent emails.

**Dodo's API sits behind Cloudflare and rejects default client user-agents.** A Python `urllib` default UA gets `403` with body `error code: 1010`, which looks like an auth failure against the billing provider during a billing incident. Set a browser User-Agent header.

One more environment note that costs time if unknown: the Clerk secret key lives in the **Convex environment**, not in `.env.local`. Looking for it locally and failing is not evidence that Clerk access is broken.

### The design seam itself (fix pending)

Subscription lifecycle emails address the Dodo checkout email, never the account's login email. `convex/payments/subscriptionHelpers.ts:1011`:

```ts
// Upsert customer record so portal session creation can find dodoCustomerId
const email = data.customer?.email ?? "";
```

That single value feeds both customer-facing sends — `sendReactivationEmail` at line 1046 and `sendSubscriptionEmails` at line 1061 — as `userEmail`, and it is also what gets written into the `customers` row (lines 1016-1031). The dunning and winback path inherits the same order of preference: `getDunningContext` in `convex/payments/subscriptionEmails.ts:479-488` reads the subscription's `rawPayload.customer.email` first and only falls back to the `customers` row for the same userId. Every lifecycle email in the system therefore addresses the checkout inbox.

What lands in that inbox is an invitation to sign in. `userWelcomeHtml` renders "Your subscription is now active. Here's what's unlocked:" (`convex/payments/subscriptionEmails.ts:197`) above a CTA that for Pro plans reads "Open My Brief" and points at `https://worldmonitor.app/brief` (`convex/payments/subscriptionEmails.ts:175-176`, rendered at line 205) — an auth-gated route. A buyer who checked out under an alias reads "active," clicks through, types the address the email arrived at, and is told the account does not exist. From the buyer's seat that is indistinguishable from being scammed.

Filed as issue **#6330** ("fix(payments): welcome email targets Dodo checkout email, steering alias buyers to a nonexistent login (\"account not known\")") — filed, unmerged as of this writing. Until it merges, expect this ticket class to recur, and diagnose it with the recipe above rather than re-deriving it.

### A useful inference: the admin email is a receipt for the user email

`sendSubscriptionEmails` sends the user welcome **first** (`convex/payments/subscriptionEmails.ts:326-333`), then the admin notification (lines 345-359), as two sequential `await`s in one action. The shared `sendEmail` helper throws on any non-OK Resend response (`convex/payments/subscriptionEmails.ts:63-68`). Therefore: **if the admin "New User Subscribed" email arrived, the user welcome was accepted by Resend** — a throw on the first send would have prevented the second from ever running. When triaging "the customer says they never got the welcome email," an admin notification in your own inbox already rules out a send failure and points you at addressing or deliverability instead.

## Why This Matters

The expensive failure here is misdiagnosis, in both directions.

Treating it as a billing regression sends an engineer into the webhook and entitlement code for hours, where everything is correct and nothing explains the symptom. The known Dodo one-row-per-user multi-subscription hazard was explicitly checked in this case — the customer had a *failed* API Starter attempt three minutes before the successful Pro Business Yearly purchase, exactly the shape that could silently downgrade an entitlement — and it did not fire. The recompute-from-all-subs guard held. Confirming that took one entitlement query; guessing at it would have taken an afternoon.

Treating it as "user error" and replying with a password-reset link is equally wrong: there is nothing to reset, because there is no account at that address. The correct reply names the actual login address and the sign-in method.

And the customer-facing cost is disproportionate. This is the worst possible moment for a paying customer's first post-purchase experience to say "account not known" — they have just been charged several hundred francs by a company they do not yet trust, and the system's own welcome email is what steered them into the wall. Every hour this ticket class stays open is an hour a paying customer believes they were defrauded.

## When to Apply

- Any support ticket of the form "I paid but can't log in," "I paid but I don't have Pro," or "my account doesn't exist after payment."
- Before opening a P0 on the entitlement pipeline off the back of a single customer report — run step (d) first.
- When a customer says they never received a welcome, renewal, dunning, or winback email: check where it was actually addressed before assuming a send failure.
- When any billing-provider record and any auth-provider record disagree about who a person is. The recipe generalizes past Dodo and Clerk: the durable move is to resolve identity from the *signed* metadata the checkout carried, never from a typed email.

## Examples

The 2026-08-08 case, end to end, as the recipe runs:

**(a)** Dodo customer `cus_0Nkt…`, billing email `webapps_wsr@…` — an address that appears nowhere in the ticket's From header.

**(b)** Two subscriptions created 2026-08-07, both carrying `wm_user_id=user_3HK…` plus a valid `wm_user_id_sig`: API Starter at 20:17 UTC whose payment **failed** (card declined, €93.49), and Pro Business Yearly at 20:20 UTC whose payment **succeeded** (408.56 CHF), status `active`, next billing 2027-08-07. The signed metadata makes the "who bought" question answerable without touching an email at all.

**(c)** Clerk `user_3HK…` signs in with `crypto_wsr@…` via email code (`password_enabled` false, no OAuth). Searching Clerk for the checkout address and for the support-sender address returns **nothing** — neither is an account. Three aliases of one person, in three different roles: `wsr2021@…` sent the ticket, `webapps_wsr@…` bought the subscription, `crypto_wsr@…` owns the login.

**(d)** Convex entitlement for `user_3HK…`: `planKey` `pro_business_annual`, `validUntil` ≈ 2027-08-07, tier 1. Correct — and notably *not* downgraded by the failed API Starter attempt.

**(e)** Resend shows "Welcome to World Monitor Pro Business (Annual)" delivered 2026-08-07 20:21:05 to `webapps_wsr@…`, `last_event=clicked` (the Resend dashboard row is findable by recipient + subject + timestamp). The click is the missing link in the story: the buyer read the mail at the checkout alias, followed its sign-in CTA, and tried that alias at the login screen.

Verdict in one line: entitlement correct + login email ≠ checkout email → identity mix-up, not a regression. The reply names `crypto_wsr@…` as the login address and explains the email-code sign-in. The product fix is issue #6330.

## Related

- Issue **#6330** — welcome email targets the Dodo checkout email instead of the account's login email (open, unmerged as of 2026-08-08).
- `convex/payments/checkout.ts:201-202` — where the signed `wm_user_id` identity is stamped onto the checkout session.
- `convex/payments/subscriptionHelpers.ts:667-689` — `tryResolveUserId` trust order: HMAC-verified metadata, then `customers` lookup.
- `convex/payments/subscriptionHelpers.ts:1011` — the checkout email that feeds every customer-facing lifecycle send.
- `convex/payments/subscriptionEmails.ts:479-488` — `getDunningContext`, same recipient resolution for dunning and winback.
- The Dodo one-row-per-user multi-subscription silent-downgrade hazard (checked here, did not fire) — see the `entitlement-billing-gotchas` skill.
