'use strict';

// Plain-text corroboration for alert and digest messages (#9213).
//
// The verdict itself comes from assessCorroboration in
// server/_shared/corroboration.ts. These CommonJS runtimes (the notification
// relay, the digest cron) cannot import that TypeScript module, so this file
// holds three small pieces, each tied to it by tests/corroboration-text.test.mts:
//   - corroborationFromItemCount: the verdict assessCorroboration gives a single
//     digest item, which depends only on the item's publisher count;
//   - parseCorroboration: reads the wire forms the server writes;
//   - corroborationText: one short token for a message.
//
// The token describes coverage, not accuracy: "3 independent publishers" means
// three publisher families carry the story, never that it is confirmed.

const KNOWN_STATES = new Set(['corroborated', 'single-publisher', 'tier4-only']);

function positiveCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}

/**
 * assessCorroboration(evidenceFromItem({ source, corroborationCount })), as
 * {state, publishers}, or null when the verdict is unknown (no count).
 */
function corroborationFromItemCount(count) {
  const publishers = positiveCount(count);
  if (publishers === null) return null;
  return publishers === 1
    ? { state: 'single-publisher', publishers: 1 }
    : { state: 'corroborated', publishers };
}

/**
 * A known verdict from `{state, publishers}` (the MCP and webhook form) or
 * `state|publishers` (the story-track form), else null. Unknown, malformed and
 * inconsistent values are null: a message never states a verdict it cannot read.
 */
function parseCorroboration(value) {
  let state;
  let publishers;
  if (typeof value === 'string') {
    const [rawState, rawCount, ...rest] = value.split('|');
    if (rest.length > 0 || !/^\d+$/.test(rawCount ?? '')) return null;
    state = rawState;
    publishers = Number(rawCount);
  } else if (value && typeof value === 'object') {
    state = value.state;
    publishers = value.publishers;
  } else {
    return null;
  }
  if (!KNOWN_STATES.has(state) || !Number.isInteger(publishers) || publishers < 1) return null;
  if (state === 'single-publisher' ? publishers !== 1 : publishers < 2) return null;
  return { state, publishers };
}

/** One short token for a message; '' when the verdict is unknown. */
function corroborationText(value) {
  const verdict = parseCorroboration(value);
  if (!verdict) return '';
  if (verdict.state === 'single-publisher') return 'single publisher';
  if (verdict.state === 'tier4-only') return `${verdict.publishers} publishers, all tier 4`;
  return `${verdict.publishers} independent publishers`;
}

/**
 * The verdict for one digest story, from the verdicts the server stored for
 * the story clusters the digest merged into it (one for an unmerged story).
 * `familyCount` is the number of publisher families among the story's listed
 * sources. Only conclusions that follow from the stored verdicts are drawn;
 * anything that would need source tiers this runtime does not hold is null:
 *   - any corroborated member: corroborated, since adding publishers to a
 *     corroborated story cannot make it less so; the largest member count is a
 *     floor;
 *   - every member tier4-only: tier4-only, with the largest count;
 *   - an unmerged story: its stored verdict, whatever its feed labels count;
 *   - every member single-publisher: single-publisher when the listed sources
 *     are one family, else null (several publishers of unknown tier, or
 *     sources that could not be read);
 *   - an unknown member, or a mix of single-publisher and tier4-only: null.
 */
function mergeCorroboration(values, familyCount) {
  const verdicts = (Array.isArray(values) ? values : []).map(parseCorroboration);
  if (verdicts.length === 0) return null;
  // An unmerged story keeps the server's verdict. Its feed labels can count
  // more families than the verdict, because the same-copy check folds reprints.
  if (verdicts.length === 1) return verdicts[0];
  const known = verdicts.filter(Boolean);
  const most = (state) => Math.max(...known.filter((v) => v.state === state).map((v) => v.publishers));
  if (known.some((v) => v.state === 'corroborated')) {
    return { state: 'corroborated', publishers: Math.max(...known.map((v) => v.publishers)) };
  }
  if (known.length !== verdicts.length) return null;
  if (known.every((v) => v.state === 'tier4-only')) return { state: 'tier4-only', publishers: most('tier4-only') };
  if (known.every((v) => v.state === 'single-publisher')) {
    // Several merged clusters are one publisher only if their listed sources
    // show one family; with no sources read, that is unknown.
    return Number(familyCount) === 1 ? { state: 'single-publisher', publishers: 1 } : null;
  }
  return null;
}

module.exports = {
  mergeCorroboration,
  corroborationFromItemCount,
  parseCorroboration,
  corroborationText,
};
