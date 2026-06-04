// Ephemeral live-coverage classifier for the WorldMonitor brief pipeline.
//
// The daily digest/brief is delivered after a delay and often read hours
// later. "Watch live" programming invites and live event previews are not
// durable intelligence items: once the livestream/briefing/hearing has passed, the
// headline is stale even if it contains conflict terms that score as HIGH.
//
// Keep this deliberately narrower than stripHeadlinePrefix("Watch:"/"Live:").
// A "Watch: tornadoes swirl through Oklahoma" video can still describe a
// concrete event; "WATCH LIVE: White House briefing..." is an expiring viewing
// instruction.

const WATCH_LIVE_PREFIX_RE = /^\s*(?:watch\s+live|watch\s*:\s*live)\b[\s:;\-–—]*/i;
const WATCH_PREFIX_WITH_LIVE_RE = /^\s*watch\s*:\s*.*\blive\b/i;

const LIVE_PREFIX_RE = /^\s*live\s*:\s*/i;
const LIVE_EVENT_NOUN_RE =
  /\b(?:briefing|press\s+briefing|press\s+conference|conference|hearing|testimony|remarks|speech|address|town\s+hall|livestream|live\s+stream)\b/i;
const LIVE_PROGRAMMING_VERB_RE =
  /\b(?:watch|broadcast|airs?|airing|listen|tune\s+in|follow\s+live)\b/i;

/**
 * Classify whether a story is an expiring live-programming teaser rather than
 * a durable event suitable for a delayed digest/brief.
 *
 * @param {{ title?: unknown; link?: unknown; description?: unknown }} story
 * @returns {boolean} true = ephemeral live coverage (exclude from the brief).
 */
export function classifyEphemeralLiveCoverage(story) {
  const title = typeof story?.title === 'string' ? story.title.trim() : '';
  if (!title) return false;

  if (WATCH_LIVE_PREFIX_RE.test(title)) return true;
  if (WATCH_PREFIX_WITH_LIVE_RE.test(title)) return true;

  if (LIVE_PREFIX_RE.test(title)) {
    const afterPrefix = title.replace(LIVE_PREFIX_RE, '').trim();
    if (LIVE_EVENT_NOUN_RE.test(afterPrefix)) return true;
    if (LIVE_PROGRAMMING_VERB_RE.test(afterPrefix)) return true;
  }

  return false;
}
