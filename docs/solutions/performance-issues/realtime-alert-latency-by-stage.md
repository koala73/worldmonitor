---
title: "Realtime news alert latency: measure by stage before changing a cadence"
date: 2026-11-17
category: performance-issues
module: news alerts
problem_type: performance_issue
component: background_job
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [alerts, relay, classify, digest, latency, google-news]
---

# Realtime news alert latency by stage

CNN published an exclusive at 22:59 UTC on 2026-11-16. Digest story tracking
first saw it at 23:34 and the relay queued the alert at 23:45: 46 minutes.

## Measure it

`shadow:score-log:v5` holds every dequeued `rss_alert` with its queue time and
the publisher's timestamp. `story:track:v1:<sha256(normalizeTitle)>` `firstSeen`
is when a digest build first carried the headline, in any edition or language.
Joining the two splits the delay. Seven days to 2026-11-17, in minutes:

| Stage | n | p50 | p90 |
|---|---|---|---|
| Publisher timestamp to queue | 1,261 | 32.2 | 191.5 |
| Publisher timestamp to digest first sight | 1,063 | 16.1 | 155.4 |
| Digest first sight to queue | 1,063 | 13.6 | 28.2 |

`node scripts/report-alert-latency.mjs --hours 168` prints the first row, and
the per-stage rows once the relay has recorded samples.

## What each stage was

- **Feed polling was not the delay in the main edition.** Feed caches
  (`rss:feed:v11`) are refreshed in the background once they are five minutes
  old, by whichever digest build reads them. The main edition has 62 language
  digests, so of its 907 cached feeds 884 had been fetched within five minutes.
  A single-language edition refetches a feed only when its own build reads it,
  so its build can serve feed data one build old; that was not measured
  separately.
- **Google News was.** 368 of the 931 feeds the English main edition reads are
  Google News searches, among them CNN, AP and Reuters. Alerts from those
  feeds reached the digest a median 45.0 minutes after publication (p90
  217.7), against 8.3 (p90 59.1) for publishers' own feeds. Polling the live
  feeds every two minutes showed why: Google listed new CNN items 10, 42 and 52
  minutes after their timestamps and a Reuters item 107 minutes after, at
  positions 63 to 99 of 100, while the digest keeps a feed's first five items
  in document order. CNN's own news sitemap listed new items within 3 minutes.
- **The relay waited for a timer.** It read each edition's digest once per
  15-minute cycle, so a headline waited up to 15 minutes after the build that
  carried it. Queue times sat exactly on those read times. The digest body is
  itself cached for 900 seconds, which is the rest of the 13.6 minutes.
- **Restarts stretched the wait.** The relay was redeployed at least 50 times
  in 43 hours. A restart abandons the cycle in progress, so the editions it had
  not reached wait for the next one.

## Fix

The digest handler writes `news:coverage-ledger:v1:<edition>:<lang>` at the end
of every build. The relay now reads those six keys every 20 seconds and
classifies an edition as soon as its build time moves, `full` first. A
restarted relay reads every edition on its first check. The 15-minute cycle
still runs: it owns the threat summary and is the fallback.

The same headlines are classified, once each, so LLM cost does not change.

## Rules that came out of it

- Read the cadence from the running system. The loop's interval constant said
  15 minutes; Railway logs showed one 725-second cycle per 15 minutes, with
  each edition read exactly once.
- A faster timer is the wrong lever when something already says "new data
  exists". Watch that signal and keep the timer as the fallback.
- Keep alarms on the stage the code owns. Publisher timestamp to queue includes
  Google's lag and publishers who stamp an item before they list it; digest
  build to queue is the relay's alone, and that is the one with a budget.
- An alert is published by whichever edition classifies a headline first, and a
  rule receives only its own edition. Any change to classify order has to keep
  `full` first.
- Do not shorten the digest cache to speed alerts without handling
  `mentionCount`: it counts digest builds, and story phase (breaking,
  developing, sustained) is derived from it.

## Still open

Google News lag is upstream of everything here. A direct source for the wires
is the next step: CNN's news sitemap needs a sitemap dialect in the feed
parser, and AP and Reuters refused an unauthenticated sitemap request (403 and
401).
