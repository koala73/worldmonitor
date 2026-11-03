# Unmapped payment product investigation (#7900)

## Checkout admission follow-up (2026-09-10)

New checkouts now require an exact catalog product ID with both
`currentForCheckout` and `selfServe` enabled. Both public and internal actions
reject legacy aliases, Enterprise, unknown and malformed IDs before billing
queries, Terms writes, signing or provider calls. The pending-payment bypass
cannot skip this check. The relay and edge return `INVALID_CHECKOUT_PRODUCT`
with HTTP 400.

Legacy resolution and subscription processing are unchanged. The investigation
below records the behavior before this admission fix; merchant reachability and
the existing unknown-product webhook fallback remain separate questions.

## Result and evidence boundary

**Fallback confirmed; buyer reachability blocked on merchant evidence.** This is
not a confirmed enterprise-access vulnerability and does not justify closing
#7900 as rejected. Investigated against main
`62fe6abf655bdfb567f517e230e0f0cac09f8fb6` on 2026-09-08.

An unmapped product in an authenticated active-subscription event grants the
Enterprise feature set. A buyer-supplied product ID reaches checkout's provider
transport without a catalog allowlist. These facts do not establish that the
provider will sell an unmapped product in the configured merchant account.
No merchant catalog snapshot, purchase, product creation, live webhook delivery,
customer mutation, or production exploitation was performed.

## Product classes and decision path

| Class in repository | Checkout admission | Accepted subscription event |
| --- | --- | --- |
| Eight current checkout products: Pro, Pro Business, API Starter and API Business, each monthly and annual | Forwarded with plan metadata | Exact catalog features and quotas |
| Enterprise catalog product, not current for checkout | Direct ID still forwarded with plan metadata | Enterprise features |
| Seven documented legacy aliases, including education and five-seat annual products | Forwarded with mapped plan metadata | Exact aliased features, including when unseeded |
| Unknown synthetic ID | Forwarded without plan metadata | Enterprise fallback |
| Malformed synthetic string | Forwarded without plan metadata | Enterprise fallback if accepted as an authenticated event |
| Retired merchant product with no surviving mapping | Cannot identify retirement from an ID alone; provider availability unverified | Same unknown branch if an event reaches it |

Free has no provider product ID. A hidden or legacy catalog entry does not prove
that Dodo has retired it. The repository has no authoritative current merchant
availability list.

`convex/payments/checkout.ts` accepts a string, applies identity and billing
guards, signs buyer metadata, and forwards the ID in `product_cart`.
`currentForCheckout` controls catalog selection, not admission at this action.
`convex/lib/dodo.ts` supplies the configured merchant API key and environment.
Checkout success returns a URL; it does not write a subscription or entitlement.
Provider rejection also leaves both tables empty in the fixtures.

`convex/payments/webhookHandlers.ts` checks the signed body and timestamp before
schema validation and internal event processing. The product is taken from the
provider event, not checkout's optional `wm_plan_key`. Resolution in
`convex/payments/subscriptionHelpers.ts` is: database mapping, legacy alias,
code catalog, then the intentional Enterprise fallback with an error log.
Customer attribution remains a separate requirement. Billing reconciliation
uses the same mapping and already has an unknown-product regression fixture.

## Verification

Node 24.20.0; repository repair preflight passed, including test readiness.
Before additions, billing, checkout and webhook-failure suites passed 208 tests.
After additions, the command below passed 262 tests across four files:

```sh
npm run test:convex -- convex/__tests__/billing.test.ts convex/__tests__/checkout.test.ts convex/__tests__/checkoutProductAdmission.test.ts convex/__tests__/webhookFailures.test.ts
```

The full `npm run test:convex` suite passed 1,888 tests across 93 files.
`npm run typecheck:api` passed, including the Convex string-call audit.

- `checkout.test.ts`: all nine catalog product IDs and seven aliases, seeded
  and unseeded, pass through the real internal event processor and entitlement
  query. Full features are compared to the unchanged canonical catalog,
  including quotas. Synthetic unknown and malformed IDs characterize fallback.
- `checkoutProductAdmission.test.ts`: real public checkout action, guards and
  storage with only provider transport mocked. Checks forwarded IDs and metadata,
  success and rejection, and absence of entitlement/subscription writes. Mock
  success is not evidence of provider acceptance.
- `webhookFailures.test.ts`: strengthens the existing signed HTTP retry fixture
  to assert Enterprise features for its unmapped product. Existing invalid-signature
  coverage returns 401. A synthetic signing secret proves local authentication
  behavior, not the ability of a buyer to sign production events.
- `billing.test.ts`: existing reconciliation fallback proof used unchanged.

These are characterization tests, not a red-to-green repair: production code and
catalog contracts are unchanged. They prove mapping fidelity to current catalog
values, not independent validation of commercial pricing or merchant availability.

## Remaining decision

To confirm buyer reachability, obtain a read-only inventory from the exact merchant
account and environment used by checkout, compare it with deployed `productPlans`
and aliases, and establish whether any unmapped product is purchasable by a normal
buyer. Provider acceptance must be established independently of mock success.
If all purchasable products map correctly, reject reachability for that dated
snapshot only. If an existing purchasable unmapped product is found, assess its
price and event mapping before choosing a fail-closed repair that preserves legacy
subscriptions. Do not create an invalid merchant product to claim attacker reachability.

No runtime change requires deployment. Merchant reachability and production
acceptance remain unresolved; green CI alone does not resolve them.
