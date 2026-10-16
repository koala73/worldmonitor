# TARGET-002 — Webhook Signature Verification Review

## Scope

Audited all webhook endpoints in `worldmonitor-main` across two distinct functional categories:

1. **Inbound Third-Party Webhook Receivers** (`convex/resendWebhookHandler.ts`, `convex/payments/webhookHandlers.ts`, `convex/http.ts`)
2. **Authenticated Webhook Management APIs** (`api/v2/shipping/webhooks/[subscriberId].ts`, `api/v2/shipping/webhooks/[subscriberId]/[action].ts`)

---

## Webhook Inventory

| Endpoint Path | Category | Source File | Handler Function | Purpose | Auth / Protection |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `POST /resend-webhook` | Inbound Receiver | `convex/resendWebhookHandler.ts` | `resendWebhookHandler` | Processes Resend email bounce/complaint & broadcast delivery events | Standard Webhooks / Svix HMAC-SHA256 (`svix-id`, `svix-timestamp`, `svix-signature`) |
| `POST /dodopayments-webhook` | Inbound Receiver | `convex/payments/webhookHandlers.ts` | `webhookHandler` | Processes Dodo Payments checkout/subscription events | Standard Webhooks HMAC-SHA256 (`webhook-id`, `webhook-timestamp`, `webhook-signature`) |
| `GET /api/v2/shipping/webhooks/{id}` | Management API | `api/v2/shipping/webhooks/[subscriberId].ts` | `default export` | Queries shipping webhook configuration status | API Key + Pro Subscription + Owner Hash Check |
| `POST /api/v2/shipping/webhooks/{id}/{action}` | Management API | `api/v2/shipping/webhooks/[subscriberId]/[action].ts` | `default export` | Pause, resume, or delete a shipping webhook subscription | API Key + Pro Subscription + Owner Hash Check |

---

## Authentication / Signature Flow (Inbound Webhooks)

### 1. Resend Inbound Receiver (`convex/resendWebhookHandler.ts`)

- **Headers Required**: `svix-id`, `svix-timestamp`, `svix-signature`
- **Secret**: `RESEND_WEBHOOK_SECRET` environment variable (retrieved via `requireEnv()`)
- **Verification Logic**:
  - Rejects request immediately (`HTTP 401`) if any signature header is missing.
  - Parses timestamp and enforces strict 300-second (5 minute) tolerance window against current system time (`Math.abs(Date.now() / 1000 - ts) > 300`).
  - Re-constructs signature payload string: `${msgId}.${timestamp}.${rawBody}`.
  - Decodes `whsec_` secret bytes and computes expected HMAC-SHA256 using `crypto.subtle.sign("HMAC", ...)`.
  - Splits `svix-signature` header on spaces, iterates through `v1,` versions, and compares signatures via `timingSafeEqualStrings()`.

### 2. Dodo Payments Inbound Receiver (`convex/payments/webhookHandlers.ts`)

- **Headers Required**: `webhook-id`, `webhook-timestamp`, `webhook-signature`
- **Secret**: `DODO_PAYMENTS_WEBHOOK_SECRET` environment variable
- **Verification Logic**:
  - Rejects request (`HTTP 401`) if required headers are absent or signature verification fails.
  - Enforces 5-minute timestamp freshness tolerance window (`WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300`).
  - Constructs payload string: `${webhookId}.${timestamp}.${body}`.
  - Computes HMAC-SHA256 signature using `crypto.subtle` and validates version `v1` matches using `timingSafeEqualStrings()`.

---

## Signature Verification Analysis

- **Raw Request Body**: Verification in both inbound handlers (`verifySignature` in Resend and `verifyDodoSignature` in Dodo) operates on the **raw unparsed HTTP request body string** (`request.text()`). Body parsing (`JSON.parse()`) occurs strictly **after** signature validation succeeds.
- **Timing Safety**: Both handlers utilize Web Crypto API `crypto.subtle` HMAC signatures and compare values using an explicit `timingSafeEqualStrings()` implementation that executes XOR bitwise comparison (`diff |= aArr[i] ^ bArr[i]`) across fixed-length buffers.

---

## Replay Protection

- **Timestamp Windows**: Both receivers enforce strict 300-second (5-minute) maximum drift windows (`Math.abs(now - ts) <= 300`).
- **Event Deduplication / Idempotency**:
  - Resend metrics recording passes `webhookEventId: svixId` into `internal.broadcast.metrics.recordBroadcastEvent` to enforce at-most-once processing on retries.
  - Dodo webhook mutation `processWebhookEvent` tracks `webhookId` in Convex storage to eliminate duplicate execution on replayed deliveries.

---

## Fail-Closed Behavior

Both inbound receivers enforce strict **Fail-Closed** execution:

- Missing `RESEND_WEBHOOK_SECRET` or `DODO_PAYMENTS_WEBHOOK_SECRET` causes `requireEnv()` to abort server startup.
- Missing headers, malformed signatures, or expired timestamps immediately return `HTTP 401 Invalid signature` / `HTTP 401 Invalid webhook signature`.
- Unauthenticated payloads never reach JSON schema parsing or business logic mutations.

---

## Security Controls Summary

1. **Raw Body Integrity**: Signature verification operates on raw request text prior to JSON parsing.
2. **Cryptographic Verification**: Web Crypto API (`crypto.subtle`) HMAC-SHA256 calculation.
3. **Timing-Attack Resistance**: Custom `timingSafeEqualStrings()` bitwise XOR comparison.
4. **Replay Window Limits**: 300-second maximum timestamp drift enforcement.
5. **Idempotent Mutations**: Unique message ID tracking (`svix-id`, `webhook-id`) prevents duplicate state mutations.

---

## Potential Weaknesses

No security flaws or bypass conditions were discovered.

---

## Safe Local Validation Plan

Static source inspection conclusively demonstrates robust signature verification and fail-closed handling in both handlers. Runtime testing against production or local endpoints is **unnecessary**.

For reference, unit test suites (`convex/__tests__/`) validate signature rejection for invalid headers without making external network calls.

---

## Classification

**SOURCE-PROTECTED**

---

## Conclusion

**No vulnerability established.**

All inbound third-party webhook receivers in `worldmonitor-main` correctly enforce HMAC-SHA256 signature verification over raw request bodies, check timestamp freshness windows, perform timing-safe comparisons, and fail closed before executing database state mutations.
