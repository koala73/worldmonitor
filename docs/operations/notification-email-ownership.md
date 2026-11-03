# Notification email ownership rollout (#7894)

Email notification destinations must match a verified account email. The public
Convex mutation requires the authenticated identity's `emailVerified === true`
and matching `email`. The existing HTTP route looks up the user's verified
primary email through Clerk's Backend API. Only this server result becomes the
internal mutation's `verifiedAccountEmail` argument; request-body proof is ignored.
The mutation checks the recipient and Pro entitlement before saving.

Newly proven rows carry `emailOwnership: "verified_account"`. An old
`verified: true` flag alone is not proof. Channel queries report such email rows
as `verified: false`; real-time, held-batch, welcome and digest workers also reject
email rows without the marker. Query masking does not modify stored records.

## Existing records and release decision

Do not bulk backfill the marker from the old flag, `users.email`, or billing email.
Those fields do not prove ownership of the stored destination. This PR contains
no migration and the coding task does not change customer records.

The release owner must approve the customer re-verification plan before deploying:
existing email channels without proof stop delivering after this repair. Users
can reconnect their verified primary account email through the existing settings
flow. Reconnection replaces that user's email row with a proven destination.
Other notification channel types remain unchanged. A future bulk re-verification
would require a separately approved plan using authoritative ownership proof.

## Deployment and acceptance (requires separate authorization)

1. Ensure `CLERK_SECRET_KEY` for the same Clerk instance is available to Convex.
   No key is copied or configured by this change. Missing credentials or failed
   lookup prevents email connection; no caller email is accepted as a fallback.
2. Deploy Convex schema/functions first, then the Railway relay and digest worker.
   The read-side mask protects old workers. New workers reject unmarked rows even
   with an old backend. The marker is optional in schema so old rows remain valid.
3. With an approved test account and owned mailbox, reconnect email and confirm
   the stored marker, one normal real-time alert and the next due digest. Test a
   rejected unrelated synthetic destination without sending to it. Verify old
   unproven rows remain unchanged and cannot send welcome or queued alerts.
4. For 24 hours and at least one due digest, the release owner watches Convex
   connection errors (`EMAIL_OWNERSHIP_REQUIRED`, `EMAIL_VERIFICATION_UNAVAILABLE`),
   relay provider failures, digest `No deliverable channels` logs and approved
   test-account delivery records. No inbox addresses or credentials go in logs.
5. Missing verified-account delivery or repeated verification failures blocks
   acceptance. Fix Clerk configuration or roll forward. Do not restore legacy
   delivery trust or backfill proof as a rollback workaround. If mitigation is
   needed, retain the read-side mask and pause email delivery until repaired.

Local fixture checks do not establish deployed configuration, real Clerk claims,
provider delivery or production acceptance. Keep #7894 open for that acceptance.
