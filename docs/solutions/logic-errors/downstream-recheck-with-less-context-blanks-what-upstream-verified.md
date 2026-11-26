---
title: A downstream re-check with less context blanks what the upstream check verified
date: 2026-11-17
category: logic-errors
module: notifications
problem_type: logic_error
component: background_job
symptoms:
  - "A critical realtime alert email arrives with no article link, only an Open dashboard button"
  - "The digest serves a link for the same story, and the dashboard shows it"
  - "Alert links survive only for publishers listed in the relay's hand-kept family table"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components: [email_processing, service_object]
tags: [alerts, relay, feed-digest, publisher-link-gate, defense-in-depth, fail-closed, proto]
---

# A downstream re-check with less context blanks what the upstream check verified

## Problem

The Feed Digest checks every story link at ingest against the feed's own host,
the feed's catalog `linkHosts`, the curated publisher family domains and a
trusted aggregator's origin, and serves a failing link as empty (#8398). The
relay then checked the same link again against its own copy of the family
table. The relay sees only the feed label, never the feed URL, so its check
could pass only for publishers in that table. Every other publisher lost its
link in every alert.

## Symptoms

- 2026-11-17: a critical alert for an Egypt Independent story had no link.
- On the live digest, the relay kept 6 of 71 alert links that the digest had
  already verified (2 of 15 inside the relay's six-hour candidate window).
- Nothing logged it. A blanked link looks the same as a story with no link.

## What Didn't Work

- **Growing the relay table.** The table is a hand-kept mirror of
  `shared/publisher-families.js`, already 500 lines of labels. It can never
  hold the feed host, which is the signal that authorises most links, so the
  loss returns with every new feed.
- **Treating a non-empty digest link as verified.** True today, because the
  digest blanks a failing link. It stops being true the day another code path
  serves an item, and it gives the relay nothing to fail closed on.

## Solution

Pass the upstream verdict downstream as an explicit field, and let the
downstream check trust it (PR #10917, unmerged as of this writing).

- `NewsItem.link_verified` (proto field 15) is stamped in `parseRssXml`, at the
  gate, and nowhere else. `toProtoItem` serves `true` only for that stamp with
  a non-empty link.
- `candidateLinkFor` in `scripts/lib/digest-stale-gate.cjs` keeps a link when
  `linkVerified === true` and the link is http(s). Anything else goes through
  the family table as before.

```js
if (item.linkVerified === true) return isHttpLink(link) ? link : '';
// no stamp: the relay's own table decides, and fails closed
return gateRelayStoryLink(link, family);
```

The table stays as the fallback. An item has no stamp when the digest or a
cached feed row predates the field, or when the relay deploys ahead of the
API. The watchlist story alerts read `story:track` rows, not the digest, and
still gate on the table.

## Why This Works

The second check was meant as defence in depth, but it had strictly less
information than the first. A check that cannot see what the first check saw
does not add a layer: it replaces the first verdict with a weaker one. The
stamp carries the verdict instead of asking the relay to re-derive it.

The threat model holds because the stamp is computed by the server and never
read from the feed. An attacker-controlled item is blanked and left unstamped
at ingest, and an unstamped link from a publisher outside the table is blanked
at the relay.

## Prevention

- Before adding a second gate downstream, list the inputs each gate sees. If
  the downstream gate sees a subset, carry the upstream verdict as a field
  instead of repeating the check.
- Make the verdict explicit and strict: only the literal boolean counts, and
  absence means "not verified", so older producers and caches fail closed.
- Measure a fail-closed gate on live data. Count how many items it blanks and
  for which sources; a gate that blanks most of its input is broken, not safe.
- Test the spoof end to end, from the parser to the consumer, including a feed
  that writes the verdict field into its own item
  (`tests/news-publisher-delivery-hosts.test.mts`).
