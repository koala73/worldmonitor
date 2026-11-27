---
title: Tagging an outbound link changes its identity for exact-URL blocklists
date: 2026-11-17
category: logic-errors
module: notifications
problem_type: logic_error
component: background_job
symptoms:
  - "An operator's exact-URL suppression entry stops matching a link once the relay appends tracking parameters to it"
  - "An entry pasted from a delivered alert does not match the untagged link in the event payload"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [email_processing, service_object]
tags: [alerts, utm, link-suppression, service-worker, normalisation, blocklist]
---

# Tagging an outbound link changes its identity for exact-URL blocklists

## Problem

Alerts now append a referrer tag to article links
(`utm_source=worldmonitor&utm_medium=alert&utm_campaign=<channel>`, PR #10917,
unmerged as of this writing). Operator link suppression (#8401) matches exact
URLs in three places: the relay matcher, the edge endpoint that publishes
SHA-256 digests of the entries, and the service worker that hashes the click
target of a delivered push. A tagged URL and the URL the feed published are
different strings, so an exact entry for one misses the other.

## Symptoms

Found by test before shipping, in both directions:

- A raw entry did not block the tagged link a push carried.
- An entry pasted from a delivered email (tagged `utm_campaign=email`) did not
  block the raw payload link, or the same link tagged for another channel.

## What Didn't Work

- **Dropping every `utm_*` parameter in the normalisers.** Publisher feeds
  carry their own UTM values (RT ships `utm_source=rss`). The endpoint would
  hash the stripped entry while a service worker that has not updated yet
  hashes the full URL, so raw entries for those links would stop matching on
  stale workers.
- **Tagging before suppression runs.** The relay matches the payload link, so
  tagging has to happen at render time, after the match.

## Solution

Treat the tag as not part of the link's identity, and remove exactly the
parameters the relay adds, in all three normalisers:

```js
const kept = search.slice(1).split('&').filter((part) => !ALERT_REFERRER_PARAMS.has(part));
return kept.length > 0 ? `?${kept.join('&')}` : '';
```

- `scripts/shared/notification-link-suppression.cjs` derives the list from
  `NOTIFY_ALERT_CHANNELS` in `scripts/shared/notify-fields.cjs`.
- `api/notification-suppressions.js` and `public/link-suppression-check.js`
  are self-contained and keep literal copies.
- The tagger appends with `&` whenever the query is non-empty, so removing the
  tag always gives back the original query string.

## Why This Works

Both sides of every comparison reduce to the same string whether the tag is
present or not, and nothing else about the URL changes. A link that never had
the tag normalises exactly as before, so entries and workers from before the
change keep matching each other.

One gap remains by design: a service worker that has not loaded the new script
hashes the full tagged push URL, so an exact entry misses a tagged push on that
device until the worker updates. `host:` entries are unaffected.

## Prevention

- Any code that rewrites a URL on its way out (tracking parameters, click
  wrappers, canonicalisation) must be checked against every place that
  compares URLs by string: blocklists, dedup keys, caches, digests.
- Test both directions: an entry in the original form against the rewritten
  link, and an entry in the rewritten form against the original
  (`tests/notification-link-suppression.test.mjs`,
  `tests/notification-sw-link-suppression.test.mjs`).
- Keep the tag vocabulary closed. The tagger accepts only listed channels, so
  the set of strings it can add equals the set the normalisers remove.
