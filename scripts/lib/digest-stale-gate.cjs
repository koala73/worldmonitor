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

// #8398: the relay needs the publisher FAMILY of a digest item to gate its
// link, but the digest response carries only the feed label
// (`item.source`). The curated label->family map is ESM-only
// (shared/publisher-families.js), unreachable from this CJS module — so the
// gate resolves the label itself through publisher-link-relay-gate.cjs,
// which mirrors that table (sync-guarded by test). When no resolver is
// provided the gate fails closed (blank link).
function candidateLinkFor(item, resolveFamily) {
  const link = typeof item?.link === 'string' ? item.link : '';
  if (!link) return '';
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

function buildClassifyCandidateMap(digest, xCandidates, variant, now, recencyMs, resolveFamily) {
  const candidates = new Map();
  const oldestAllowedAt = now - recencyMs;

  if (!isStaleDigestReplay(digest) && digest?.categories) {
    for (const bucket of Object.values(digest.categories)) {
      for (const item of bucket?.items ?? []) {
        if (!item?.title) continue;
        if (item.publishedAt && item.publishedAt < oldestAllowedAt) continue;
        if (!candidates.has(item.title)) {
          candidates.set(item.title, {
            source: item.source ?? variant,
            publishedAt: item.publishedAt ?? now,
            corroborationCount: item.corroborationCount ?? 1,
            // #8398: relay-emitted rss_alert events must not carry a link
            // outside the item's registered publisher set. The gate blanks
            // hostile links; the title still classifies and alerts.
            link: candidateLinkFor(item, resolveFamily),
          });
        }
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
      });
    }
  }

  return candidates;
}

module.exports = { buildClassifyCandidateMap, isStaleDigestReplay, candidateLinkFor };
