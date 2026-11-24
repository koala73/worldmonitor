// Claim rules the evidence-grounded country brief applies on top of the
// name/number/qualifier validators in brief-llm-core.js. Shared by the server
// renderer (get-country-intel-brief.ts) and the corpus publish gate
// (scripts/crawlable-developments.mjs) so a claim the server publishes is the
// claim the page accepts.

import { AGGREGATOR_LINK_HOSTS } from './article-url.js';
import { extractNumericFacts } from './brief-llm-core.js';

const BYLINE_SEPARATORS = [' - ', ' \u2013 ', ' \u2014 ', ' | '];

function isAggregatorUrl(url) {
  try {
    return AGGREGATOR_LINK_HOSTS.has(new URL(String(url ?? '')).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Google News titles end in " - <Publisher>", and some feeds append their own
// name. A model reads that byline as part of the story ("Kuwait's compliance
// oversight body" from "... pension fund - Compliance Week", #11217), and the
// name check would accept the publisher as a name the story states.
export function headlineWithoutPublisher(title, url, source) {
  const text = String(title ?? '').trim();
  const sourceName = String(source ?? '').trim().toLowerCase();
  if (sourceName) {
    for (const separator of BYLINE_SEPARATORS) {
      const byline = separator + sourceName;
      if (text.length > byline.length && text.slice(-byline.length).toLowerCase() === byline) {
        return text.slice(0, -byline.length).trim();
      }
    }
  }
  // A clipped title may have lost its byline, leaving a dash inside the headline last.
  if (!isAggregatorUrl(url) || /(?:\.\.\.|\u2026)$/.test(text)) return text;
  const cut = text.lastIndexOf(' - ');
  return cut > 0 ? text.slice(0, cut).trim() : text;
}

// A claim citing one of these kinds must be that item's exact fact text, cited
// alone without a headline or another data point.
const exactFactGrounded = (kind) => (text, headlineCount, evidence) => {
  const matching = evidence.filter(item => item.kind === kind);
  if (matching.length === 0) return true;
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  return headlineCount === 0 && evidence.length === 1
    && normalize(text) === normalize(matching[0].factText);
};

export const sanctionsEvidenceGrounded = exactFactGrounded('sanctions');
export const energyEvidenceGrounded = exactFactGrounded('energy');
// A satellite imagery change states only that statistics changed at a named site
// on the named dates; any paraphrase could add a cause the data does not carry.
export const imageryEvidenceGrounded = exactFactGrounded('imagery');

// The date forms evidence fact texts use ("Sep 23, 2026", "Aug 29, 2026")
// plus ISO dates. Blanked before numbers are read, so a date's day or year
// can never license a score ("23 of 100" off an "as of Sep 23" as-of).
const DATE_TEXT_RE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\.?\s+\d{1,2}(?:,\s*\d{4})?\b|\b\d{4}-\d{2}-\d{2}\b/g;
// "62.3 of 100": the scale belongs to the value in front of it, not to the claim.
const SCALE_RE = /(\d[\d,]*(?:\.\d+)?)\s+of\s+100\b/g;

const numberFacts = (text) => [...extractNumericFacts(text)].filter((fact) => fact.startsWith('number:'));
const dateFacts = (text) => [...extractNumericFacts(text)].filter((fact) => fact.startsWith('date:'));

/**
 * True when every number and date in an evidence-citing claim is bound to the
 * data point it cites. Dates must appear in a cited fact text. Every other
 * number must be the cited item's own value (the first number in `value`),
 * and a numeric claim may cite only one item that carries a value: with two,
 * "28" and "62.3" could trade places between metrics and still pass.
 * Energy observations instead bind every number through their complete exact
 * fact text, including its provenance year.
 *
 * @param {string} claim
 * @param {Array<{ value: string, factText: string }>} cited
 */
export function evidenceNumbersGrounded(claim, cited) {
  // The complete energy atom also binds its provenance year, which is not
  // the metric value. Exact matching cannot license a spliced number.
  if (cited.some(item => item.kind === 'energy')) return energyEvidenceGrounded(claim, 0, cited);
  if (cited.some(item => item.kind === 'imagery')) return imageryEvidenceGrounded(claim, 0, cited);
  const citedDates = new Set(cited.flatMap((item) => dateFacts(item.factText)));
  const claimDates = (claim.match(DATE_TEXT_RE) || []).flatMap((date) => dateFacts(date));
  if (claimDates.some((fact) => !citedDates.has(fact))) return false;

  const numbers = numberFacts(claim.replace(DATE_TEXT_RE, ' ').replace(SCALE_RE, '$1'));
  if (numbers.length === 0) return true;
  const values = cited.map((item) => numberFacts(item.value)[0]).filter(Boolean);
  if (values.length !== 1) return false;
  return numbers.every((fact) => fact === values[0]);
}

// A sentence about the material rather than the country: "the headlines do
// not establish this", "no data is available". The model writes these when a
// section has nothing to say; they are the notices the brief no longer prints.
const EVIDENCE_NOUNS = String.raw`(?:supplied|provided|available|cited)?\s*(?:headlines?|titles?|sources?|data(?:\s+points?)?|reports?|information|evidence|material)`;
const EVIDENCE_LIMIT_RES = [
  new RegExp(String.raw`\b(?:the|these|this|available|world monitor)\s+${EVIDENCE_NOUNS}\s+(?:do(?:es)?\s+not|don't|doesn't|cannot|can't|fails?\s+to)\s+(?:establish|say|state|specify|mention|indicate|provide|confirm|show|support|address)\b`, 'i'),
  new RegExp(String.raw`^\s*no\s+${EVIDENCE_NOUNS}\s+(?:is|are)\s+(?:available|provided|supplied)\b`, 'i'),
  /\bis\s+not\s+(?:established|specified|provided|supported)\s+by\s+the\b/i,
  new RegExp(String.raw`\bunclear\s+(?:from|in)\s+the\s+${EVIDENCE_NOUNS}\b`, 'i'),
];

/** True when a claim describes the limits of the evidence instead of the country. */
export function isEvidenceLimitClaim(claim) {
  return typeof claim === 'string' && EVIDENCE_LIMIT_RES.some((re) => re.test(claim));
}
