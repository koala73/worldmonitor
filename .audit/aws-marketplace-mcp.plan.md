# AWS Marketplace API and remote MCP contract integration

Date: 2026-10-26. Baseline: `393709bffcf8bf97e43073293cd3bc0ca2cd05c1`.

Status: Implementation plan. The coordinator accepted the API plus MCP product boundary and the three worker assignments on this date. This file does not claim implementation, deployment, listing approval, or live acceptance.

## Outcome and product boundary

An AWS buyer purchases a SaaS contract, follows Marketplace account setup, signs in with Clerk, and binds the purchased license to that account. The buyer creates a dedicated API key, connects to the existing remote MCP server, sees the license allowance, and can revoke or rotate the key. Contract expiry and AWS entitlement changes stop the affected license's access. Other AWS licenses and the owner's retail subscription remain independent.

The first product is **API and MCP access through a SaaS contract with no usage overages**. Direct API access is intentional. The configured AWS dimension maps to an existing API plan and its published request limits. This avoids giving an API key MCP rights while pretending it has no API rights. The owner receives no retail dashboard subscription from this purchase. The listing must describe both API and MCP rights.

One configured dimension and one API plan are sufficient. Require a positive integer entitlement quantity. One unit buys one license allowance; if multiple units are offered, daily request allowances scale by quantity with checked integer arithmetic. Burst limits and capabilities remain those of the configured plan. The listing must describe this quantity rule. Operator configuration selects the actual dimension, supported plan, and listing price. The code supplies no price or seller identity.

No `BatchMeterUsage` implementation is necessary for this contract-only product. No PAYG, overage, QuickLaunch, retail billing migration, team administration, or data-source expansion belongs in this change. Machine OAuth and direct AgentCore Gateway opt-in are deferred. A customer-managed API-key connection is the delivered remote MCP route. Existing operator-secret `client_credentials` does not meet the deferred buyer credential requirement.

## Current architecture and constraints

`convex/schema.ts`, `convex/entitlements.ts`, and `convex/payments/` own durable retail billing and features. Clerk owns human identity. `userApiKeys` stores SHA-256 hashes, never plaintext. The Edge key validators return a `userId`, and the API gateway and MCP use that identity for entitlements and usage counters. `api/mcp/auth.ts` supports a `user_key` context and signs downstream MCP requests with that principal. The current main branch already preserves user-key identity through OAuth.

Reuse this enforcement path with a dedicated service principal for each AWS license. Do not change the owner's Clerk identity or write AWS purchases into Dodo subscription rows. The prefix `aws-marketplace:` is reserved for service principals. Public key creation continues to derive a real Clerk subject; only trusted Marketplace operations can create a key for this reserved principal.

Existing key validation has a 60-second positive cache. Existing entitlement caching can last 900 seconds. The latter is unsuitable for the AWS lifecycle. Marketplace principals must bypass the retail entitlement cache and use the authoritative Convex license projection, including its freshness deadline. Key revoke must invalidate existing key caches. Document the maximum 60-second residual key-cache window if cache deletion fails. No fresh authorization can outlive a license's validity or the freshness deadline.

Existing `start_upgrade` and retail upgrade hints can route `user_key` callers to Dodo. Block checkout for Marketplace principals and direct their billing actions to AWS Marketplace. Keep `get_mcp_allowance` and the account allowance resource because their counters are correctly scoped to the license principal. Review other account-mutating tools and reject operations that require a human retail account. Do not classify an unavailable entitlement service as an invalid credential.

## Architecture alternatives and decision

| Candidate | Responsibilities | Decision |
|---|---|---|
| Convex owns licenses and human ownership. AWS delivers events through SQS. Existing API keys and quotas use a license service principal. | New durable AWS state sits beside existing identity, keys, and entitlements. One Edge projection connects it to current enforcement. | Selected. Preserves one authorization store and existing quota semantics. Adds no cross-database ownership transaction. |
| DynamoDB owns AWS customers and credentials. An AWS authorization service bridges every MCP call to Vercel. | AWS owns lifecycle, identity mapping, keys, and quotas. Convex remains separate retail state. | Rejected for this change. Requires another key issuer, quota authority, account-binding protocol, and live authorization dependency. |

Model the Domain shaped the selected design. A license is the billing and quota unit. The human account owns licenses, but is not the billing unit. Concurrent agreements cannot be represented by one row per AWS account.

## Current AWS requirements

These requirements were checked against official AWS documentation on the plan date.

- New SaaS integrations must support Concurrent Agreements. Store `CustomerAWSAccountId` and `LicenseArn`; do not require `CustomerIdentifier`, which new `ResolveCustomer` responses omit. [ResolveCustomer](https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-metering_ResolveCustomer.html).
- Exchange the registration POST token promptly and verify entitlements before access. Contract changes require entitlement rechecks. Sellers registered after July 15, 2026 use EventBridge, rather than SNS. [SaaS contract integration](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-integrate-contract.html).
- Filter entitlement reads by `LICENSE_ARN`. Follow every `NextToken`, including one returned with an empty page. Validate product, account, license, dimension, quantity, and expiry in each accepted row. [GetEntitlements](https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-entitlements_GetEntitlements.html).
- Use `aws.agreement-marketplace` events, particularly `License Updated - Manufacturer` and `License Deprovisioned - Manufacturer`. AWS documents the event schemas separately. [SaaS EventBridge integration](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-eventbridge-integration.html).
- Buyers need usable credentials, self-service rotation or invalidation, and credential invalidation when access ends. [API-based AI products](https://docs.aws.amazon.com/marketplace/latest/userguide/integrating-api-ai-agents-tools.html).
- Remote MCP needs discovery, tool schemas, authentication, errors, and tested client instructions. [MCP requirements](https://docs.aws.amazon.com/marketplace/latest/userguide/integrating-mcp.html).
- Optional direct AgentCore MCP integration requires two-legged OAuth. Do not advertise that option for this API-key-only release. [AgentCore Gateway requirements](https://docs.aws.amazon.com/marketplace/latest/userguide/bedrock-agentcore-gateway.html).
- SaaS listings can run outside AWS. The existing Vercel, Railway, Convex, and Upstash topology cannot be described as entirely deployed on AWS without separate evidence. Seller security, customer-information, operational, and listing requirements remain external review gates. [SaaS guidelines](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-guidelines.html).

## Durable data model

Core worker owns these validators and DTOs in `shared/aws-marketplace.ts` and the Convex schema. Names can be adjusted once by the coordinator before the other workers consume them.

```ts
type MarketplaceIdentity = {
  productCode: string;
  customerAWSAccountId: string;
  licenseArn: string;
  customerIdentifier?: string;
  agreementId?: string;
};

type MarketplaceLicense = MarketplaceIdentity & {
  ownerUserId?: string;
  principalId: string; // aws-marketplace:<Convex license id>
  status: 'pending' | 'active' | 'inactive';
  planKey?: string;
  quantity: number;
  validUntil: number;
  checkedAt: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

type MarketplaceEntitlement = {
  dimension: string;
  quantity: number;
  expirationDate: number; // epoch milliseconds
};
```

`awsMarketplaceLicenses` has indexes for product plus license, principal, owner, and reconciliation due time. License identity is unique transactionally. Two licenses for one account remain distinct. `awsMarketplaceRegistrations` contains a random registration-secret hash, browser-binding hash, license identity or ID, expiry, and the claimed user. It never stores the AWS token. A short TTL limits unclaimed registration retention. A cleanup job removes expired rows in bounded batches.

Reuse `userApiKeys` for API credentials owned by the license principal. Keep `keyKind: 'api'`. Add a license association only if necessary for indexed owner management; the principal already provides an indexed lookup. A Marketplace mutation checks human ownership and active fresh license state before insertion. Ordinary key mutations cannot act as a service principal. A secret is generated using Web Crypto, returned once, and stored only as a hash and display prefix.

An event receipt records event ID, license, claim or completion status, and a bounded retention expiry. Store normalized audit facts, never registration tokens or keys. Infrastructure retains delivery failures in a DLQ. The operator runbook specifies log retention and the handling of failed events. Do not assert legal audit retention or S3 compliance without a specified requirement.

## Internal HTTP contract

All operations use `POST /api/internal/aws-marketplace` on the configured Convex HTTP origin. Authenticate with the existing `X-Convex-Shared-Secret` convention using constant-time comparison. Reject missing server configuration. Limit request size. Return `Cache-Control: no-store` on all responses. Caller `userId` comes only from a verified server session; it is never taken from an unverified browser field.

The JSON request is a discriminated union keyed by `operation`.

| Operation | Remaining request fields | Success response |
|---|---|---|
| `stageRegistration` | `registrationHash`, `browserBindingHash`, identity fields, `expiresAt` | `{ registrationId }` |
| `claimRegistration` | `registrationHash`, `browserBindingHash`, `userId` | `{ licenseId, principalId }` |
| `account` | `userId` | `{ licenses: [{ id, productCode, licenseArn, status, planKey, quantity, validUntil, checkedAt, keys }] }` |
| `createKey` | `userId`, `licenseId`, `name`, `keyHash`, `keyPrefix` | `{ keyId }` |
| `revokeKey` | `userId`, `licenseId`, `keyId` | `{ ok: true }` |
| `beginRefresh` | `productCode`, `customerAWSAccountId`, `licenseArn`, optional `eventId`, optional `eventTime` | `{ licenseId, revision, duplicate }` |
| `applyRefresh` | `licenseId`, `revision`, `checkedAt`, `entitlements`, optional `eventId` | `{ applied }` |
| `listDue` | optional `cursor`, bounded `limit` | `{ licenses: [identity], cursor? }` |

Each listed key exposes only `id`, `name`, `keyPrefix`, `createdAt`, and optional `revokedAt`. No endpoint lists credential hashes. Error responses have `{ error: CODE }`, with 400 for malformed input, 401 for missing trusted authentication, 403 for foreign ownership, 409 for claimed registration or refresh conflict, and 503 for configuration or dependency unavailability. The public adapter converts these into user-safe messages without copying provider error payloads.

`beginRefresh` increments the local revision atomically. `applyRefresh` only commits the matching revision. A request that loses this race cannot acknowledge an uncommitted event as complete. Retry it, or prove a newer completed refresh supersedes it. An AWS failure leaves the last successful projection intact and does not mark an event completed. Freshness expiry still stops authorization. An event receipt is completed only after the matching projection commits. Duplicate completed event IDs are idempotent successes.

`stageRegistration` and refresh operations can create an unowned license. They cannot transfer ownership. `claimRegistration` verifies both hashes, expiry, and existing owner in one transaction. The same owner can repeat a completed claim safely. Another owner receives an opaque conflict. One buyer can own several licenses.

## Public adapters and browser flow

Service worker owns `api/marketplace/register.ts`. It accepts the AWS form POST containing `x-amzn-marketplace-token`, enforces a small body limit, and calls `ResolveCustomer` immediately. It checks the configured product and resolved identifiers. It reads and normalizes all license entitlements, and persists the license before sending the browser onward.

Create two independent random values. Put the registration continuation and browser-binding secret in separate HttpOnly, Secure, SameSite=Lax cookies scoped to `/api/marketplace`. Persist only hashes. Redirect with HTTP 303 to `/marketplace?setup=1`. Neither secret nor the AWS token appears in a URL. Use a short expiry, `Referrer-Policy: no-referrer`, and no-store. The claim adapter reads both cookies server-side and requires a verified Clerk session and an allowed Origin. A missing or expired cookie requires the buyer to restart AWS Setup Account. This prevents a copied page URL from linking a purchase to another account.

Buyer worker owns the standalone `/marketplace` page and `src/marketplace-main.ts`. Service worker owns all four public API adapters under `api/marketplace/`. Follow the existing `mcp-grant.html` entry pattern for Clerk loading and the existing build configuration. The page supports sign-in, registration completion, pending entitlement verification, active licenses, expired licenses, key creation, key copying, revocation, and replacement. Show the selected license, its plan, quantity, expiry, service limits, API plus MCP scope, and AWS billing-management instructions. Preserve the owner’s ordinary account plan separately.

The public routes are `GET /api/marketplace/account`, `POST /api/marketplace/claim`, and `POST` or `DELETE /api/marketplace/keys`. The account response contains the internal `licenses` array plus `pendingRegistration: boolean`. Claim reads both cookies and accepts no user identity or secret from the body. Create accepts `{ licenseId, name }` and returns `{ keyId, key }`. Revoke accepts `{ licenseId, keyId }` and returns `{ ok: true }`. Use the existing session helper. For create, generate the raw `wm_` credential on the server, hash it, call the internal operation, and return it once. For mutation requests, require same-origin JSON and a verified Clerk session. No client can provide a trusted owner ID or AWS entitlement snapshot. Point MCP management hints to `https://www.worldmonitor.app/marketplace`; the page explains AWS Marketplace subscription management.

Machine OAuth is explicitly deferred. The page provides the existing `X-WorldMonitor-Key` remote MCP configuration and a direct API example. Future buyer client credentials need a registered client ID bound to a hashed secret, a short-lived token, revocation, entitlement checks, correct discovery, and real AgentCore testing. Adding `client_credentials` to existing discovery alone is insufficient.

## AWS API transport and event infrastructure

Service worker owns `server/_shared/aws-marketplace.ts`, the registration adapter, `workers/aws-marketplace/`, and a deployable CloudFormation template. Reuse the existing `aws4fetch` dependency for Edge SigV4 requests, or use the AWS SDK inside a Node worker where the runtime permits it. Do not import Node-only transports into Edge code. Use explicit service names, configured supported regions, timeouts, bounded retries, session-token support, and `User-Agent` headers. Never log credential values or provider registration tokens.

Required deployed settings include the AWS product code, dimension, plan mapping, AWS region, seller-account credentials or assumed role configuration, Convex HTTP URL, existing trusted server secret, and the canonical registration and buyer page origins. Missing or inconsistent settings fail closed. Credentials must be configured by the operator. No credentials are fabricated or committed.

The template creates an EventBridge rule, SQS queue, DLQ, Lambda consumer, scheduled reconciliation trigger, least-privilege execution role, and bounded log retention. Filter the documented Marketplace source and license event types. Validate the expected seller account, region, and product identity before processing. Event payloads are notifications to reconcile, never direct grants. Fetch current entitlements before applying state. For license deprovisioning, deny access according to current authoritative license state; do not apply the PAYG final-metering grace to this contract product.

The Lambda consumer uses SQS partial batch failures. A failed entitlement read, internal HTTP failure, or conflicting incomplete refresh retains the record for retry. Duplicate delivery is safe. The queue policy admits only the named EventBridge rule. The DLQ alarm and replay procedure belong in the runbook. Never fetch an event-supplied URL.

Scheduled reconciliation uses `listDue` and bounded pagination so a missed notification cannot preserve access indefinitely. The AWS scheduled worker runs every five minutes. The coordinator selected a maximum projection age of fifteen minutes to tolerate bounded retry. The internal entitlement projection has `validUntil = min(contractExpiry, checkedAt + 15 minutes)`. AWS owns network reconciliation; do not add a second Convex network cron. Once the projection is too old, return a retryable authorization-unavailable result. A confirmed empty or expired entitlement set returns denied access. Keep these outcomes distinct.

The template is an inspectable deployment artifact. This task does not deploy it, create a seller listing, purchase a test contract, or submit a public listing.

## Worker ownership and throughput checkpoint

Three Sol workers implement against this plan. They own separate worktrees. The coordinator integrates and owns the final test and PR claims. There is no recursive delegation.

| Worker | Exclusive responsibilities |
|---|---|
| A. Core | `shared/aws-marketplace.ts`, `convex/awsMarketplace.ts`, any necessary focused Convex helper, `convex/schema.ts`, `convex/entitlements.ts`, Marketplace route registration in `convex/http.ts`, relevant `convex/crons.ts` entries, Marketplace key-cache invalidation integration, core tests. |
| B. Service | `server/_shared/aws-marketplace.ts`, `api/marketplace/register.ts`, `api/marketplace/claim.ts`, `api/marketplace/account.ts`, `api/marketplace/keys.ts`, `workers/aws-marketplace/`, CloudFormation template, transport and worker tests. Owns the typed `callMarketplaceBackend()` adapter used by its public route handlers. |
| C. Buyer and access | `marketplace.html`, `src/marketplace-main.ts`, page styles or local service if necessary, `vite.config.ts`, `vercel.json`, `api/api-route-exceptions.json`, Marketplace-principal entitlement-cache bypass in `server/_shared/entitlement-check.ts`, MCP checkout/hint guards, buyer/access tests, customer/operator docs, `ARCHITECTURE.md`, and documentation navigation if needed. |

Before writing cross-worker callers, A publishes the internal DTOs and B publishes the public route response types. Heavy tests run sequentially. The first useful integration check is an in-process flow from registration through owner claim, key creation, MCP quota admission, entitlement removal, and denial. The longest external dependency is an AWS restricted-listing test account, so live acceptance remains a separate gate. Avoid adding a fourth architecture or optional auth feature while those core paths remain incomplete.

The adapter signature is `callMarketplaceBackend(request: MarketplaceOperation): Promise<MarketplaceOperationResult>`. Production binds its Convex origin and shared secret from server configuration. Tests inject fetch and configuration. The actual request/result union should preserve operation-specific types rather than an unchecked generic cast.

## Acceptance and verification

1. Registration exchanges the real form-token shape and rejects an unexpected product. The token never appears in a URL, stored record, response body, or log.
2. A registration link without its binding cookie cannot claim a license. A different user cannot claim an owned license. Duplicate same-owner claims are safe. Two concurrent contracts on one AWS account remain separate.
3. Positive integer entitlement quantity, configured dimension, correct license/account/product, expiry, and every pagination page are validated. Invalid and exhausted pagination fails closed.
4. Fresh active licenses permit API and MCP calls with the same intended quota rules as the configured API plan. Multiple keys share one license allowance. Different licenses have separate counters. No credential class grants a higher allowance.
5. The owner’s retail plan and Dodo history stay unchanged after AWS activation, renewal, key creation, and cancellation. A retail cancellation cannot revoke an AWS license. A license cancellation cannot revoke another license.
6. Revoked keys stop authenticating within the documented cache bound. Expired and inactive licenses stop protected API and MCP execution. A stale projection or failed entitlement backend produces a retryable failure, not free access.
7. Duplicate and reordered events, concurrent refreshes, AWS throttling, an empty page with a next token, worker retry, poison messages, and missed notifications have focused tests. Failed records are not acknowledged before state commits.
8. Marketplace users cannot initiate retail checkout through MCP. Their allowance and billing messages identify the correct license and AWS billing route.
9. The rendered buyer page works at desktop and mobile sizes. Capture actual sign-in, active license, key-created, and error/recovery states with labeled test data. Inspect screenshots and attach relevant images to the PR.
10. Required local gates pass on the integrated tree. Run focused Convex and handler tests first, then `npm run typecheck`, `npm run typecheck:api`, `npm run lint:boundaries`, `npm run lint:api-contract`, relevant Edge bundle checks, `npm run docs:check`, and `git diff --check`. Broaden tests only to cover changed behavior or unresolved failures.

## External acceptance checklist

| Gate | Evidence required | Initial state |
|---|---|---|
| Seller and product | Actual seller account, restricted listing, configured product code and contract dimension, approved plan/price/quantity terms. | BLOCKED until operator supplies or configures them. |
| Infrastructure | Deployed template outputs, configured secrets, queue target and role permissions, successful event delivery and reconciliation logs. | Not deployed by this task. |
| Real purchase | Allowed buyer completes a test contract, registration, Clerk link, key issuance, MCP discovery, and one paid tool call. | Requires restricted listing and authorized test purchase. |
| Lifecycle | Real renewal or entitlement update, expiry/deprovisioning, key rotation, duplicate event, and worker recovery evidence. | Requires AWS environment. |
| Product review | Seller policies, support contact, source redistribution rights, security review, architecture submission, and AWS acceptance. | External review. Do not infer approval from tests. |
| AgentCore | Buyer-bound machine OAuth and tested Gateway target. | Explicitly outside this release. |

Record locally verified, PR ready, deployed, observed in AWS, and listing accepted as separate states. The final report must name the remaining external gates without calling the integration AWS-approved.
