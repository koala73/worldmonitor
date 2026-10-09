// The verdict card. Nothing here is a new rule: it arranges WorldMonitor's
// own judgments (lib/wm.mjs) into what the stage shows.
//
//   headline word  WorldMonitor's coverage state, in its own UI wording
//   grade          WorldMonitor's credibility score and band (CRED n)
//   flags          the brief corroboration bar, the seeder's entity gate,
//                  the fact-grounding gate, state affiliation
//
// WorldMonitor is explicit that coverage is not accuracy ("This describes
// coverage, not accuracy."), so the card says so too.

import { MIN_CORROBORATING_PUBLISHERS, WM_TEXT, coverageFlag } from './wm.mjs';

export const MATCH_THRESHOLD = 0.5;

export const VERDICT_WORDS = {
  'not-found': 'Not in WorldMonitor’s sources',
  unreachable: 'Sources unreachable',
  'single-publisher': WM_TEXT.singlePublisher,
  'tier4-only': WM_TEXT.tier4Only,
  corroborated: 'Corroborated',
  unknown: 'Unverifiable',
};

export function computeVerdict({ found, sourcesUnreachable = false, coverage, summary = null, credibility = null, rated = [], figures = null, seeder = null }) {
  if (!found) {
    const key = sourcesUnreachable ? 'unreachable' : 'not-found';
    return {
      key,
      word: VERDICT_WORDS[key],
      reasons: [sourcesUnreachable
        ? 'The desk could not reach WorldMonitor, so it cannot check this claim.'
        : 'No publisher WorldMonitor monitors carried this story in the window it holds.'],
      hint: null,
      band: null,
    };
  }
  const state = coverage?.state ?? 'unknown';
  const reasons = [];
  if (summary) reasons.push(`${summary}.`);
  if (credibility) reasons.push(`WorldMonitor credibility ${credibility.score}/100 (${credibility.band}), from ${credibility.source}.`);
  const publishers = coverage?.publishers ?? 0;
  reasons.push(publishers >= MIN_CORROBORATING_PUBLISHERS
    ? `Clears WorldMonitor's corroboration bar (${MIN_CORROBORATING_PUBLISHERS} independent publishers).`
    : `Below WorldMonitor's corroboration bar of ${MIN_CORROBORATING_PUBLISHERS} independent publishers.`);
  for (const r of rated.filter((x) => x.stateAffiliated)) reasons.push(`${r.name}: state-affiliated (${r.stateAffiliated}).`);
  if (seeder?.entityCorroboration === false) reasons.push('WorldMonitor’s entity-corroboration gate did not fire for this story.');
  if (seeder?.entityCorroboration === true) reasons.push('WorldMonitor’s entity-corroboration gate fired: named entities match across outlets.');
  for (const f of figures?.facts ?? []) {
    if (!f.grounded) reasons.push(`The figure ${f.label} is not grounded in any source text.`);
    else if (f.statedBy?.length === 1) reasons.push(`The figure ${f.label} is stated by one publisher only: ${f.statedBy[0]}.`);
  }
  return {
    key: state,
    word: VERDICT_WORDS[state] ?? VERDICT_WORDS.unknown,
    reasons,
    hint: coverageFlag(state)?.hint ?? `${WM_TEXT.rosterLegend} Coverage, not accuracy.`,
    band: credibility?.band ?? null,
  };
}
