# Security repair release acceptance (#7902)

This packet covers #7907–#7911, #7913 and #7914. It is a release-owner
checklist, not deployment or message authorization. Keep acceptance separate
from merge and CI. Use synthetic accounts and owned destinations; keep account
identifiers, addresses, chat IDs and credentials out of public evidence.

## Decisions before live acceptance

1. Approve email re-verification and Telegram re-pairing for existing connections.
   Old unproven rows stop delivering. Do not backfill ownership markers from old
   flags, billing data or account email. Use the existing settings flow and the
   [email procedure](notification-email-ownership.md) and
   [Telegram procedure](telegram-recipient-proof.md).
2. Designate one test account, an owned verified mailbox and a private test chat.
   Explicitly approve a welcome, one realtime alert, one due digest and the
   deactivation check for these destinations. Reused/expired pairing links and
   an unrelated synthetic email destination must cause no delivery.
3. Verify that Convex can use the matching Clerk instance's backend credential.
   Record only instance alignment and success/failure, never credential values.
   Missing credentials must fail closed. Deployment metadata alone cannot prove
   Clerk configuration, recipient proof or delivery.

## Refresh before taking action

Record exact revisions and status for the Vercel production deployment, the
`convex-deployed` tag and its successful deploy job, and each Railway worker's
latest successful deployment. A skipped worker build is not a new deployment.
Compare the revisions with the relevant fixes using commit ancestry. Do not
redeploy already-current services merely because old PR prose says deployment
is pending. Historical activation order cannot be inferred from creation times.

For any separately approved rollout, deploy Convex before relay and digest.
Retain delivery guards if recovery is needed. Never restore unproven delivery.
For Docker, record the immutable image digest, source revision and operator
rollout separately. A successful image publication does not prove an operator
has replaced a running container.

## Required runtime evidence

| Surface | Acceptance evidence | Limits of local proof |
| --- | --- | --- |
| Docker administration | Public nginx rejects `/api/local-*`; health and ordinary data routes work. Native credentials cannot override Docker mode. | A rebuilt runtime fixture does not prove the full published image or production exposure. |
| Docker RSS and sidecar fetch | RSS HTML/SVG remains inert through nginx; mapped private addresses and string/URL/Request private fetch targets are blocked before transport. Allowed requests still work. | Synthetic transport and loopback fixtures establish guard behavior, not an attacker-controlled production caller. |
| Gateway | Authorized test identity reaches the daily limit through both GET and normalized POST; no provider call follows denial. | Local quota-store fixtures do not prove deployed Redis state. Live quota tests require separate approval and must avoid paid provider calls. |
| Email and Telegram | Fresh proof permits only the owned destination; old/unproven, reused/expired and deactivated connections cannot deliver welcome, queued, realtime or digest messages. | Mock transport cannot establish provider delivery. |
| Waitlist | Approved synthetic signup crosses the edge-to-Convex bridge; direct public backing mutation is unavailable; retries expose no membership/referral data. | Local tests cannot prove deployed bridge-secret alignment; a live signup is a production write and needs separate approval. |
| DOM | Promoted descendants are sanitized and allowed formatting survives in the released browser bundle. | Local DOM proof does not establish attacker-input reachability or deployed bundle behavior. |

The retained #7892 URL-object lead was reproduced through a real local sidecar
handler: `fetch(new URL(loopbackFixture))` returned 200 before repair, while
string and Request inputs returned 502. Normalize URL inputs through the same
address validation and pinned transport. This confirms a wrapper defect; it does
not establish a public attacker-controlled route to a private target.

## Stop conditions and owner

The release owner records the approved account/destination references privately,
exact revisions, UTC timestamps and each result. Observe email for 24 hours and
at least one due digest. Watch `EMAIL_OWNERSHIP_REQUIRED`,
`EMAIL_VERIFICATION_UNAVAILABLE`, provider failures and `No deliverable channels`
without publishing recipient data. Unexpected delivery or failure of verified
recipient delivery blocks acceptance. Retain guards and repair configuration or
roll forward. Keep #7902 and operationally incomplete child acceptance open.
