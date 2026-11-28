# Black Friday 2026 email: operator runbook

The offer: 70% off Pro against paying monthly, $144 for the first year of Pro
Yearly, ending 4 December 2026 at 23:45 UTC.

Code: `blackFriday.ts` (audience and commands), `_blackFridayAudience.ts`
(eligibility rules), `blackFridayEmailContent.ts` (copy), and the shared wave
pipeline in `waveRuns.ts`.

## What is safe by default

- `startBlackFridayWave` and `releaseBlackFridayBroadcast` are **dry runs**
  unless called with `"dryRun": false`. A dry run returns counts, calls Resend
  zero times and writes nothing.
- `blackFridayAudience`, `blackFridayHealth` and `getBlackFridayStatus` are
  read-only.
- A real wave loads a Resend segment, creates the broadcast as a **draft** and
  stops. Nothing is emailed until that broadcast is released with
  `"dryRun": false`.
- No result or log line contains an email address. Do not paste addresses into
  commands or tickets either.

Run every command against production. `CONVEX_DEPLOYMENT` in `.env.local`
decides the target; add `--prod` if yours points at dev.

## How a wave works

One wave is one segment: a version, in a locale, for a recipient type.

| Send | Version | Recipient | Who |
|---|---|---|---|
| launch | `monthly-switch` | account | active Pro Monthly the in-place switch accepts |
| launch | `lapsed` | account | former subscribers with nothing covering now |
| launch | `new-buyer` | account | free accounts |
| launch | `new-buyer` | waitlist | registrations with no account |
| last-day | `last-day-switch` | account | as `monthly-switch` |
| last-day | `last-day` | account | free and lapsed accounts |
| last-day | `last-day` | waitlist | waitlist contacts the launch ramp reached |

Locales are `en`, `zh`, `fr`, `tr`, `es`, `de`. Accounts use the stored browser
locale (`users.localeTag`, else `localePrimary`); Traditional Chinese and every
other language get `en`. Waitlist contacts have no stored locale: the
email-domain heuristic (`_localeHeuristic.ts`) maps Chinese providers and `.cn`
to `zh`, and everyone else gets `en`. So the waitlist is `en` and `zh` only.

Excluded from every send: any `emailSuppressions` row (bounce, complaint,
manual, unsubscribe), API plans, Pro Yearly (paid or comped), Pro Business,
Enterprise and active enterprise members, any account with a subscription on
hold, Pro Monthly with a cancellation scheduled (Dodo's
`cancel_at_next_billing_date` flag or `cancelScheduledAt`), Pro at the
MCP-only monthly price, comped or still-entitled accounts with no live
subscription, accounts being deleted, and anyone whose Pro Yearly period
started during the offer.

That re-check happens at export, not at send. A large segment takes hours to
load and a draft can then wait up to 6 hours, so someone who buys after their
batch was exported still gets the email.

Eligibility is read from the live tables when the wave is picked, and again
for each batch as it is exported to Resend (see the note below the exclusions). Each contact is stamped as it
lands (`blackFridayLaunchWave` or `blackFridayLastDayWave`, on `users` or
`registrations`), so nobody gets the same send twice and re-running a segment
only picks up people who have not had it.

Unsubscribe uses Resend's per-contact link (`{{{RESEND_UNSUBSCRIBE_URL}}}`).
A broadcast is one body for a whole segment, so a per-user Convex link cannot
be injected, and waitlist contacts have no user id to sign one for. Resend
fills the link and its own List-Unsubscribe headers for every contact, and
the webhook writes the unsubscribe into `emailSuppressions`.

## 0. Before the first wave

1. This change is merged and deployed to Convex production (the schema fields
   and the functions below exist there).
2. The app side is live in production: `/dashboard?settings=account` opens
   Settings on Account, and the "Switch to yearly" button shows the translated
   labels quoted in the switch emails (`BLACK_FRIDAY_APP_LABELS`).
3. The PRO-launch ramp is not mid-wave. One wave runs at a time across both:

   ```sh
   npx convex run broadcast/rampRunner:getRampStatus '{}'
   ```

   `activeWaveRuns` must be empty. If the ramp is `active`, pause it for the
   week (`broadcast/rampRunner:pauseRamp '{}'`), or its daily tick will report
   a stalled wave whenever a Black Friday broadcast is held.
4. Create the campaign's config row (lease, thresholds, kill gate):

   ```sh
   npx convex run broadcast/blackFriday:initBlackFriday '{}'
   ```

   Defaults: bounce limit 4%, complaint limit 0.08%, the PRO-launch values.

## 1. Count the audience (read-only)

```sh
npx convex run broadcast/blackFriday:blackFridayAudience '{"send":"launch"}'
```

Reconcile `groups` with the planning snapshot of 27 November: free 48,691,
lapsed 361, monthly 191, waitlist 42,596. Small drift is expected (sign-ups,
purchases, unsubscribes). A large gap means the rules here differ from the
snapshot's: stop and compare `excluded` reason by reason before sending.
`segments` lists every `version/locale/recipient` with people to send.

The scan reads every account and every registration. It loads the small
tables (suppressions, subscriptions, entitlements, enterprise seats, account
deletions, customers) once, then walks `users` and `registrations` 1,000
rows a page with one indexed lookup per row. Expect well under two minutes per
table at the November sizes (about 50k accounts, 48k registrations). To read
one table only, add `"scope":"accounts"` or `"scope":"waitlist"`. A wave start
runs the same scan over its own table only.

## 2. Send one wave

The same four steps for every segment. Example: Pro Monthly, English.

```sh
# a. Dry run: counts, and whether a real run would be refused.
npx convex run broadcast/blackFriday:startBlackFridayWave \
  '{"version":"monthly-switch","locale":"en","recipient":"account"}'

# b. Real: pick, create the Resend segment, load contacts, create the draft.
npx convex run broadcast/blackFriday:startBlackFridayWave \
  '{"version":"monthly-switch","locale":"en","recipient":"account","dryRun":false}'

# c. Wait until the run shows "held": true (a large segment takes hours).
npx convex run broadcast/blackFriday:getBlackFridayStatus '{}'

# d. Open the draft in the Resend dashboard and read it. Then:
npx convex run broadcast/blackFriday:releaseBlackFridayBroadcast '{"runId":"<runId>"}'
npx convex run broadcast/blackFriday:releaseBlackFridayBroadcast '{"runId":"<runId>","dryRun":false}'
```

After step d, `getBlackFridayStatus` shows the run as `sent` and the lease
free. Only then start the next wave.

Release within 6 hours of the draft being created. After that the release is
refused: discard the run (section 6) and start the segment again.

`"count": N` caps a wave. To send a segment in several waves, pass
`"wave": 2`, `"wave": 3` and so on: a wave label is never reused.

## 3. Launch order

Account holders first, smallest and warmest first. Skip any segment whose dry
run shows `toSend: 0`.

1. `monthly-switch`, each locale. Send `en` first: it is the canary for the
   template and the deep link. Open the email, press the button, confirm
   Settings opens on Account.
2. `lapsed`, each locale.
3. `new-buyer` for `account`, each locale, `en` last (the largest).
4. Check health before touching the waitlist (section 5).

The order above is yours to keep. The code checks one thing: an account wave
of the send must be `sent` before any waitlist wave starts. It does not wait
for every account segment.

Then the waitlist, which has not been emailed in months, in ramped waves.
The checks the code enforces are shared by the whole waitlist, not kept per
locale: the first waitlist wave of all is capped at 500, and every later one
needs the settle window and trusted rates below. Sending `en` first, and the
wave sizes, are manual:

1. The canary: at most 500, `en`.

   ```sh
   npx convex run broadcast/blackFriday:startBlackFridayWave \
     '{"version":"new-buyer","locale":"en","recipient":"waitlist","count":500,"dryRun":false}'
   ```

2. Wait. The next waitlist wave is refused until 18 hours have passed since
   the last one (bounces and complaints arrive late) and the waitlist
   broadcasts have 100 delivered. `"settleHours"` lowers the wait, to 2 at the
   least; use it only after reading the health numbers. If the canary exported
   too few contacts to ever reach 100 delivered, a follow-up may go out inside
   what is left of the 500 allowance; the refusal message gives the number.
3. Larger waves, each after the same check:
   `"count":2000,"wave":2`, then `"count":10000,"wave":3`, then the rest
   (`"count":50000,"wave":4`).
4. `zh` waitlist once `en` is healthy. Start it small by hand (`"count":500`):
   the code's canary cap was already spent on `en`.

Launch waves stop 24 hours before the end. After that only the last-day
versions start.

## 4. The last day (4 December)

Last-day waves start no earlier than 24 hours before the end (3 December
23:45 UTC) and nothing starts or is released in the final 2 hours.

```sh
npx convex run broadcast/blackFriday:blackFridayAudience '{"send":"last-day"}'
```

The window is about 22 hours and one wave runs at a time, and the English
account wave alone loads for hours. Start when the window opens, largest
segments first once the small ones have proved the template.

Order: `last-day-switch` per locale, then `last-day` for `account` per locale,
then `last-day` for `waitlist`. Anyone who bought or switched since the first
send is excluded by the same rules. The waitlist reminder only goes to
contacts the launch ramp reached (`waitlistNotYetEmailed` counts the rest), so
it needs no second ramp; it does need a `last-day` account wave sent first.

## 5. Health and the kill gate

```sh
npx convex run broadcast/blackFriday:blackFridayHealth '{}'
```

Rates are bounces and complaints over delivered, summed across every campaign
broadcast, with `waitlist` and `accounts` shown separately. A rate counts once
that group has 100 delivered. Every real start and every real release
re-checks them; a rate over its limit trips the gate, and the command fails.

Stop everything by hand:

```sh
npx convex run broadcast/blackFriday:stopBlackFriday '{"reason":"<why>"}'
```

While the gate is tripped no wave starts and no draft is released. A broadcast
Resend is already sending is not recalled: cancel it in the Resend dashboard.
The gate never clears itself:

```sh
npx convex run broadcast/blackFriday:clearBlackFridayKillGate '{"reason":"<what you found>"}'
```

## 6. When something goes wrong

| What you see | What to do |
|---|---|
| The draft is wrong, or you decide not to send it | `broadcast/waveRuns:discardHeldCampaignRun '{"runId":"...","reason":"..."}'`. Contacts are unstamped and stay eligible. Delete the draft and segment in Resend. |
| Run stuck in `pushing` with no progress for 15 minutes | `broadcast/waveRuns:resumeStalledWaveRun '{"runId":"..."}'` |
| `failed` with `batch-failure-rate-exceeded`, `segment-create-failed` or `persist-failed` | `broadcast/waveRuns:discardWaveRun '{"runId":"...","reason":"..."}'`, then start the segment again with a new `wave` |
| `failed` with `create-broadcast-failed` | `broadcast/waveRuns:resumeFinalizeWaveRun '{"runId":"..."}'` (it holds again once the draft exists) |
| `send-broadcast-failed` after a release | Check the broadcast in Resend. Sent: `broadcast/waveRuns:markFinalizeRecovered '{"runId":"...","sentAt":<ms>,"reason":"..."}'`. Not sent: run `blackFridayHealth` first, then `broadcast/waveRuns:resumeFinalizeWaveRun '{"runId":"...","confirmedNotSent":true}'`. The retry sends nothing while the gate is tripped or inside the final 2 hours. |
| A real start timed out or threw after "claim", leaving a run in `picking` | `broadcast/waveRuns:discardWaveRun '{"runId":"...","reason":"..."}'`, then start again with a new `wave`. `"count"` does not shorten the scan: it always reads the whole table. If the scan itself timed out, run `blackFridayAudience` with that table's `"scope"` and report its duration before retrying. |
| "another wave holds the lease" | `getBlackFridayStatus` names the run. Release it, discard it or recover it as above. |

## Definitions used by the counts

- **free**: a `users` row with an email, no subscription rows, and no paid or
  comped entitlement.
- **lapsed**: a `users` row with subscription rows, none covering now, none on
  hold, and no remaining entitlement. Former subscribers of any plan count.
- **monthly**: the account passes the same check Settings uses for the switch
  (`selectPlanChangeCandidate("pro_annual", …)`): an active Pro Monthly at
  $39.99 with no cancellation scheduled and nothing at or above Pro Yearly.
- **waitlist**: a `registrations` row whose email has no `users` row, no
  `customers` row and no suppression.

A former subscriber with no `users` row (a customer record only) is in none of
these groups and gets no email.
