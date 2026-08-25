'use strict';

// #7084: should the relay's digest-driven alert pass run against this digest
// response?
//
// A stale replay carries content that already went through the pass when it
// was served fresh — its titles were classified and any qualifying rss_alert
// already published. Re-running the pass re-emits alerts for hours-old events
// (the 15-minute relay recency gate bounds but does not close this for young
// replays), so a replay skips the whole cycle and the next fresh digest
// resumes it.
//
// Lives in scripts/lib rather than inline in ais-relay.cjs for the same
// reason as x-poll-cycle.cjs: the relay file boots on import, so anything
// only reachable there can only ever get regex-on-source "coverage" — see
// the comment above createXPollCycle for what that shipped.
function isStaleDigestReplay(digest) {
  return digest?.coverage?.servedStale === true;
}

module.exports = { isStaleDigestReplay };
