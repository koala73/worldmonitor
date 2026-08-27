'use strict';

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

function buildClassifyCandidateMap(digest, xCandidates, variant, now, recencyMs) {
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
            link: item.link ?? '',
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

module.exports = { buildClassifyCandidateMap, isStaleDigestReplay };
