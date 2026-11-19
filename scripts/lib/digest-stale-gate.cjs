'use strict';

const { gateRelayStoryLink } = require('./publisher-link-relay-gate.cjs');

// #7084: should the relay's digest-derived candidates participate in this
// classification pass?
//
// A stale replay carries RSS content that already went through the pass when
// it was served fresh — its titles were classified and any qualifying
// rss_alert already published. Re-running those candidates can re-emit alerts
// for hours-old events (the 15-minute relay recency gate bounds but does not
// close this for young replays). Fresh X candidates are independent inputs and
// must remain eligible during the same pass.
//
// Lives in scripts/lib rather than inline in ais-relay.cjs for the same
// reason as x-poll-cycle.cjs: the relay file boots on import, so anything
// only reachable there can only ever get regex-on-source "coverage" — see
// the comment above createXPollCycle for what that shipped.
function isStaleDigestReplay(digest) {
  return digest?.coverage?.servedStale === true;
}

// #8398: a relay-emitted rss_alert must not carry a link that leaves the
// item's publisher. The digest makes that check at ingest, where it knows the
// feed (its registered host, its catalog linkHosts, the curated family
// domains, a trusted aggregator's origin), and stamps `linkVerified: true` on
// each item whose link passed. The relay trusts that stamp.
//
// The stamp is computed by the digest server and never read from the feed, so
// an RSS item cannot set it. Only the literal boolean counts, and the link
// must still be http(s).
//
// An item without the stamp goes through the relay's own family table
// (publisher-link-relay-gate.cjs), which fails closed for any publisher it
// does not list. That covers a digest or cached feed row built before the
// stamp shipped, and a relay deployed ahead of the API. The table only sees
// the feed label, so on its own it blanked the link of every publisher
// outside its hand-kept list.
function isHttpLink(link) {
  return /^https?:\/\//i.test(link);
}

function candidateLinkFor(item, resolveFamily) {
  const link = typeof item?.link === 'string' ? item.link : '';
  if (!link) return '';
  if (item.linkVerified === true) return isHttpLink(link) ? link : '';
  const source = typeof item?.source === 'string' ? item.source : '';
  let family = '';
  try {
    family = typeof resolveFamily === 'function' ? resolveFamily(source) : source;
  } catch {
    family = '';
  }
  if (typeof family !== 'string' || family.length === 0) return '';
  return gateRelayStoryLink(link, family);
}

// `poolItems` are fresh items the digest's category cap kept off the
// dashboard (#10978). They follow the served items, so a title in both keeps
// the served copy and its story tracking. Pool candidates carry `fromPool`.
function buildClassifyCandidateMap(digest, xCandidates, variant, now, recencyMs, resolveFamily, poolItems = []) {
  const candidates = new Map();
  const oldestAllowedAt = now - recencyMs;

  if (!isStaleDigestReplay(digest) && digest?.categories) {
    // Spread, so a bucket whose items are not a list still throws.
    const served = Object.values(digest.categories).flatMap(bucket => [...(bucket?.items ?? [])]);
    const pool = Array.isArray(poolItems) ? poolItems : [];
    for (const [index, item] of [...served, ...pool].entries()) {
      if (!item?.title) continue;
      if (item.publishedAt && item.publishedAt < oldestAllowedAt) continue;
      if (!candidates.has(item.title)) {
        candidates.set(item.title, {
          // #10977: score on the publisher a topic feed carries, not the feed.
          source: item.originPublisher || item.source || variant,
          publishedAt: item.publishedAt ?? now,
          corroborationCount: item.corroborationCount ?? 1,
          // #8398: relay-emitted rss_alert events must not carry a link
          // outside the item's registered publisher set. An unverified
          // link is blanked; the title still classifies and alerts.
          link: candidateLinkFor(item, resolveFamily),
          // When digest story tracking first saw the headline, in any
          // edition or language. Only for the latency log.
          ...(item.storyMeta?.firstSeen > 0 ? { firstSeen: Number(item.storyMeta.firstSeen) } : {}),
          ...(index >= served.length ? { fromPool: true } : {}),
        });
      }
    }
  }

  for (const candidate of xCandidates) {
    if (!candidates.has(candidate.title)) {
      candidates.set(candidate.title, {
        source: candidate.source,
        publishedAt: candidate.publishedAt,
        corroborationCount: candidate.corroborationCount,
        link: candidate.link,
        // No digest build behind it. A title in both inputs keeps the digest
        // candidate above, and with it the build stage of the latency log.
        fromX: true,
      });
    }
  }

  return candidates;
}

module.exports = { buildClassifyCandidateMap, isStaleDigestReplay, candidateLinkFor };
