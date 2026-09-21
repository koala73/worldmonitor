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
progress returns `pending` without creating another worker chain. If the row is
`failed`, inspect `lastError`, correct the provider configuration or failure, and
run the same command to resume from its saved progress. Provider calls use at
most five attempts with exponential backoff; permanent failures stop immediately.

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
- Invoice-linked payment evidence stays without email or a live `userId`.

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
