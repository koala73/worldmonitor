# Shared Dodo customer portal investigation (#7897)

Date: 2026-09-08. Source revision: `b2a45cbbb9f3bbdac6ca308de4b9f3e45a5dbded`.
Related: [issue #7897](https://github.com/koala73/worldmonitor/issues/7897).

## Conclusion: blocked on provider checkout evidence

Local characterization confirms that two separately signed Clerk subscription
owners can receive portal links for the same provider customer, **if the provider
assigns that customer ID to both subscriptions**. Documentation supports direct
magic-link access and customer-wide billing permissions. It does not establish
whether the hosted checkout requires mailbox proof before reusing a customer.
This is not a confirmed exploit, nor evidence that the path is safe.

No production code, customer records, provider settings, or migration changed.
No real checkout, portal session, email, cancellation, or purchase was performed.
Only synthetic fixtures, fake secrets, mocked provider calls, and public docs
were used. No authorized provider sandbox dataset was supplied or used.

## Identity boundaries

| Concept | Authority and observed behavior |
| --- | --- |
| Clerk subject | Authenticated identity supplied to the public checkout/portal action. |
| Login email | Checkout can stamp this separately with a signature; it does not lock the billing email. |
| Billing email | Entered at Dodo checkout; may legitimately differ from login email. |
| Subscription owner | New activation uses verified `wm_user_id` metadata; later activation retains the existing subscription owner. |
| Provider customer ID | Supplied by Dodo in webhook data and retained on the subscription. It is not a Clerk ownership proof. |
| Local customer owner | One `customers.userId` can move between Clerk subjects when a shared customer is activated. |
| Portal permission | Session creation takes the provider customer ID, not a subscription ID or Clerk subject. |

## Source trace

- `convex/payments/checkout.ts`, `_createCheckoutSession`: signs the authenticated
  user ID, optionally stamps signed login email, and omits the checkout `customer`
  block so billing fields remain editable.
- `convex/payments/subscriptionHelpers.ts`, `tryResolveUserId` and
  `handleSubscriptionActive`: verify the identity signature, keep existing
  subscription ownership, and preserve the provider customer ID. The
  `preferExistingCustomerOwner` exception covers anonymous-to-real ownership;
  it does not collapse two signed Clerk users into one owner.
- `convex/payments/billing.ts`, `getDodoCustomerIdForUserPortal`: reads the user's
  subscriptions, preferring their stable customer ID or raw payload, then a
  same-user customer row. It does not compare every other subscription owner for
  that provider customer.
- The public `getCustomerPortalUrl` action requires authentication. Its helper
  calls `customers.customerPortal.create(customerId, { send_email: false })`
  and returns the provider link. `internalGetCustomerPortalUrl` uses that same
  helper after the gateway supplies the verified subject.

## Reproducible local fixture

The existing shared-customer query fixture in `convex/__tests__/billing.test.ts`
now drives the production webhook mutation and authenticated public portal
action. It uses real identity signatures, Convex storage and lookup code; only
the Dodo SDK response is mocked. The two cases use the same billing alias and
different Clerk subjects/login emails:

| Provider assignment supplied by fixture | Observed local result |
| --- | --- |
| Both activations carry `cus_shared` | Two subscriptions retain A/B ownership; the single customer row points to B; both portal requests target `cus_shared`. |
| Activations carry `cus_A` and `cus_B` | Two customer rows; each portal request targets its owner's provider customer. |

Both cases assert exact SDK arguments and returned URLs. An unmapped third user
with the same email receives `NO_CUSTOMER`; an unauthenticated caller receives
`AUTH_REQUIRED`; neither causes another SDK call. Portal requests leave the
subscription and customer records unchanged.

`convex/__tests__/checkoutLoginEmailMetadata.test.ts` additionally asserts that
the authenticated checkout's provider payload omits `customer`, alongside its
existing real-signature assertions.

These tests do not prove hosted checkout customer reuse, mailbox verification,
Clerk token validation, webhook HTTP signature validation, SDK HTTP encoding,
portal rendering, or provider-side subscription access. Injecting a shared ID
is an explicit premise, not an observed provider result.

## Provider contract evidence

Public documentation was read on 2026-09-08. These are documented contracts,
not an observation of this merchant's sandbox or production configuration.

1. **Customer reuse: documented, verification prerequisite unknown.** The
   [v0.15.1 changelog](https://docs.dodopayments.com/changelog/v0.15.1) describes
   consistent customer IDs across payments and subscriptions for the same email.
   The current [Checkout Sessions guide](https://docs.dodopayments.com/developer-resources/checkout-session)
   documents existing/new customers but does not specify mailbox proof before
   reuse. The older changelog alone cannot establish current hosted-flow controls.
2. **Portal entry: direct magic link documented.** The
   [Customer Portal guide](https://docs.dodopayments.com/features/customer-portal)
   distinguishes email-delivered static login from direct dynamic links, valid
   for 24 hours. The [session API](https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session)
   accepts merchant bearer authentication, customer ID, optional `send_email`
   and `return_url`, and returns `link`. No subscription filter is documented.
3. **Scope: customer-wide permissions documented.** The portal guide lists all
   active subscriptions, billing history and invoices, payment methods, and
   cancellation controls. Some plan-change actions depend on merchant settings.
   Inference: if A/B subscriptions share the provider customer, this documented
   portal boundary does not separate them by Clerk subject. Actual visibility
   and enabled actions for the two-user case remain unobserved.

## Missing evidence and safe next step

A confirmed/rejected conclusion needs an authorized test-mode merchant/product,
two synthetic Clerk accounts, and controlled test mailboxes. Do not substitute
real customer records or live credentials. In a fresh browser context, record:

1. Whether a second hosted checkout using the first account's billing email
   requires mailbox proof **before** assigning/reusing the provider customer.
   Capture the point of verification and both resulting customer/subscription
   IDs. Stop if the flow requires real charges or real customer data.
2. Whether the resulting API-issued dynamic portal link requires another
   identity proof, and which synthetic subscriptions/invoices/actions it exposes.
   Record visible controls without executing cancellation or payment changes.

Alternatively, obtain provider confirmation of these exact controls after
separate authority to contact them. Absence of a documented control is not proof
that the control is absent. Keep the issue open while this evidence is missing.

## Repair constraints if the prerequisite is confirmed

Do not bind billing email to login email or reassign signed subscription owners.
Any repair must preserve legitimate aliases and multiple subscriptions. A
verified-customer binding needs a mailbox-proof record with provenance and
revocation rules. A subscription-scoped portal needs a provider-supported
permission boundary; hiding links in the browser is insufficient. Existing shared
customers require inventory and a migration decision that preserves subscription,
invoice, payment-method and refund associations. No provider-side customer split,
backfill or binding policy is proposed as a confirmed repair here.

## Verification

- Node `v24.20.0`; review and repair preflight ready on the recorded revision.
- Baseline: `npm run test:convex -- convex/__tests__/billing.test.ts convex/__tests__/checkout.test.ts`
  passed, 192 tests.
- Focused characterization: `npm run test:convex -- convex/__tests__/billing.test.ts -t 'characterizes signed owners'`
  passed, 2 cases. These are current-behavior characterization tests; no failing
  exploit regression or production repair is claimed.
- Final: `npm run test:convex -- convex/__tests__/billing.test.ts convex/__tests__/checkout.test.ts convex/__tests__/checkoutLoginEmailMetadata.test.ts`
  passed, 207 tests across 3 files. `git diff --check` passed.
- CI readiness, deployment and production acceptance are separate; none proves
  the missing provider behavior.
