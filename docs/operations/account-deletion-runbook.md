---
title: "Account deletion runbook"
description: "Operator steps for fulfilling a World Monitor account-deletion request after the Clerk subject is confirmed. Public Mintlify docs never publish this command."
---

# Account deletion runbook

Use this after a requester writes from the account email and you have confirmed
the Clerk user in the Clerk Dashboard. **Email is not identity.** Do not start
erasure from an email match alone.

Related: [Authorization-failure signal](./authz-failure-signal.md).

## Confirm the Clerk subject

1. Ask the person to write from the account email.
2. Open the user in the Clerk Dashboard.
3. Copy the Clerk user id (`user_...`). That subject is the only accepted
   identifier for erasure.
4. If more than one Clerk user shares the email, stop. Confirm which subject
   the requester controls before running anything.

## Run the same engine support and self-serve use

From a trusted checkout, with production Convex credentials:

```bash
npx convex run accountDeletion/erase:eraseConfirmedUser '{"userId":"user_...","source":"support"}'
```

Then wait until `accountDeletions.status === "complete"` for that `userId`.
A second run after completion returns `already_deleted`. A request already in
progress returns `pending` without creating another worker chain.

To read the row — including `lastError` — use the operator query. `eraseConfirmedUser`
only ever answers `pending` / `complete` / `already_deleted`, so it cannot tell you
that a deletion failed or why:

```bash
npx convex run accountDeletion/erase:getDeletionStatusForOperator '{"userId":"user_..."}'
```

It returns `status`, `step`, `lastError`, `emailKeyedSkipped`, `externalAttempts`,
`batchAttempts`, and timestamps, or `null` when no deletion was ever requested for
that subject.

### `emailKeyedSkipped: true` — finish the email-keyed cleanup

A deletion that started from the Clerk `user.deleted` webhook has no verified proof
of the account's email address: Clerk had already destroyed the subject before it
told us. Waitlist rows, contact-form messages, and Business grants keyed on the
invitee's email are therefore left alone rather than matched on a cached address we
cannot trust — and no later re-run repairs that, because every entry point skips the
Clerk lookup once a deletion row exists.

Confirm the address out of band, the same way you confirm the Clerk subject, then:

```bash
npx convex run accountDeletion/batches:completeEmailKeyedErasure \
  '{"userId":"user_...","verifiedEmail":"person@example.com"}'
```

Do **not** pass an address read from our own cached profile — that is exactly the
proof this engine refuses, and a stale or attacker-influenced value would delete a
third party's records. The command is idempotent and reschedules itself until both
the grant sweep and the email-keyed sweep report done; re-run
`getDeletionStatusForOperator` afterwards to confirm `emailKeyedSkipped` is gone.

If the row is `failed`, inspect `lastError` **with that command first**, correct the
provider configuration or failure, then re-run `eraseConfirmedUser` to resume from
its saved progress. Resuming clears `lastError` and both attempt counters so the
retry ladders start fresh — the previous error is written to the logs as
`account_deletion_resumed_after_failure` before it is cleared, but the row itself
will no longer show it. Provider calls use at most five attempts with exponential
backoff; permanent failures stop immediately.

Do **not** pass an email argument. Extra fields are rejected.

## What the engine does

- Cancels covering Dodo subscriptions. Remaining prepaid time is not refunded.
- Revokes API keys, embed keys, and Pro MCP tokens and deletes their Redis
  caches / negative-cache sentinels.
- Deletes or anonymizes personal Convex rows per the account-deletion registry.
  A durable fence rejects new personal writes from stale sessions and callbacks.
- Reads the current verified primary email from Clerk before email-keyed cleanup.
  Cached profile emails and email-only token claims are never ownership proof.
- Delegates Company Monitoring to `markOwnerDeleted`.
- Deletes the Clerk user if it is still present (404 is success).
- Billing evidence is retained for accounting, disputes, and lawful requests:
  customer contact data (email, name, phone, billing address) stays in the
  customers, subscriptions, paymentEvents, webhookEvents, and dunningEmails
  rows; the live `userId` link is replaced by the `deleted:<sha256>`
  tombstone on customers, subscriptions, paymentEvents, and
  deletedSubscriptionCustomers, and signed identity markers are stripped from
  the payloads stored on those rows.
- `webhookEvents` is the exception, and it is deliberate. The raw provider
  archive is keyed by `webhookId` with no per-user index, so rows written
  **before** a deletion request keep the `wm_user_id` / `wm_login_email`
  identity bridge Dodo echoed back to us; only events processed **after** the
  deletion row exists are redacted on the way in. Treat the tombstone as
  "these billing rows no longer name the account", not as an assertion that no
  record anywhere can be re-joined to the original Clerk subject. The
  `accountDeletions` row itself also keeps the plaintext `userId` indefinitely,
  because `billingDeletionForUser` needs that reverse map. If a lawful erasure
  request requires the webhook archive too, that is a manual operation — see
  the registry entry for `webhookEvents`.

## After the row is complete

- The requester cannot sign back into that Clerk user.
- Tell them to sign out on other devices and clear local site data (dashboard
  preferences and desktop keychain secrets are not wiped remotely).
- Self-serve steps live in the public accounts doc. Do not publish this Convex
  command in Mintlify.

## Clerk Dashboard webhook

Subscribe `user.deleted` to the Convex HTTP route `/clerk-webhook` only after
this change is deployed. Unsigned deliveries 401. A payload for an unknown
Clerk user still 200s after a tombstone insert so Clerk does not retry forever.

A webhook that starts erasure after Clerk has removed the user cannot establish
current email ownership. It erases subject-linked records but skips email-only
records unless the engine captured verified ownership before deletion. Use the
self-serve control or the support command before deleting the Clerk user when
email-keyed cleanup is required.

Do not enable Clerk hosted user-delete as the primary product control.
