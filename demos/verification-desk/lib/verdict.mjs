// The verdict rule. Deterministic on purpose: the model narrates the verdict,
// it never decides it. Corroboration states come straight from WorldMonitor
// (server/_shared/corroboration.ts) and describe coverage, not accuracy.

export const VERDICTS = {
  CORROBORATED: 'Corroborated',
  SINGLE_SOURCE: 'Single-source',
  CONTRADICTED: 'Contradicted',
  UNVERIFIABLE: 'Unverifiable',
};

export const MATCH_THRESHOLD = 0.5;

/**
 * @param {object} input
 * @param {{score:number}|null} input.match         best cluster match, or null
 * @param {{state:string, publishers:number|null}|null} input.corroboration
 * @param {{figure:string, found:boolean, sourcesSay:string|null}[]} input.figures
 * @param {{stance:string, quote:string|null}|null} input.judge  quote already verified verbatim
 */
export function computeVerdict({ match, corroboration, figures = [], judge = null, sourcesUnreachable = false }) {
  const reasons = [];
  if (!match && sourcesUnreachable) {
    // An outage is not evidence of absence: never say "nobody carried it" when we could not look.
    reasons.push('The desk could not reach its sources, so it cannot check this claim.');
    return { verdict: VERDICTS.UNVERIFIABLE, reasons };
  }
  if (!match || match.score < MATCH_THRESHOLD) {
    reasons.push('No monitored publisher carried this story in the window WorldMonitor holds.');
    return { verdict: VERDICTS.UNVERIFIABLE, reasons };
  }

  if (judge?.stance === 'contradicts' && judge.quote) {
    reasons.push(`The sources say otherwise: “${judge.quote}”`);
    return { verdict: VERDICTS.CONTRADICTED, reasons };
  }
  const conflicting = figures.filter((f) => !f.found && f.sourcesSay);
  if (conflicting.length && figures.every((f) => !f.found)) {
    for (const f of conflicting) reasons.push(`The headline says ${f.figure}; the sourced text says ${f.sourcesSay}.`);
    return { verdict: VERDICTS.CONTRADICTED, reasons };
  }

  const unproven = figures.filter((f) => !f.found);
  const figureNote = unproven.length
    ? `Figure${unproven.length > 1 ? 's' : ''} ${unproven.map((f) => f.figure).join(', ')} not found in the sourced text: unproven.`
    : null;

  const state = corroboration?.state ?? 'unknown';
  if (state === 'corroborated') {
    reasons.push(`${corroboration.publishers} independent publisher families carried it.`);
    if (figureNote) reasons.push(figureNote);
    // The event is corroborated; a number in it may still rest on one newsroom.
    const lone = figures.filter((f) => f.found && f.statedBy?.length === 1);
    for (const f of lone) reasons.push(`But the figure ${f.figure} comes from one publisher only: ${f.statedBy[0]}.`);
    const caveat = figureNote ? 'Story corroborated, figure unproven' : lone.length ? 'Story corroborated, figure single-source' : null;
    return { verdict: VERDICTS.CORROBORATED, reasons, caveat };
  }
  if (state === 'single-publisher') {
    reasons.push('Every copy traces to one publisher family.');
    if (figureNote) reasons.push(figureNote);
    return { verdict: VERDICTS.SINGLE_SOURCE, reasons };
  }
  if (state === 'tier4-only') {
    reasons.push(`${corroboration.publishers} publishers carried it, but every one is an aggregator or blog. No primary outlet.`);
    if (figureNote) reasons.push(figureNote);
    return { verdict: VERDICTS.UNVERIFIABLE, reasons };
  }
  reasons.push('WorldMonitor has no publisher evidence it can count for this story.');
  return { verdict: VERDICTS.UNVERIFIABLE, reasons };
}

/** Evidence gate for the model's contradiction call: the quote must be verbatim in the evidence. */
export function gateJudge(judge, evidenceText) {
  if (!judge || !['supports', 'contradicts', 'insufficient'].includes(judge.stance)) return { stance: 'insufficient', quote: null };
  if (judge.stance === 'insufficient') return { stance: 'insufficient', quote: null };
  const quote = typeof judge.quote === 'string' ? judge.quote.trim() : '';
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');
  if (quote.length < 8 || !norm(evidenceText).includes(norm(quote))) return { stance: 'insufficient', quote: null, rejected: judge.stance };
  return { stance: judge.stance, quote };
}
