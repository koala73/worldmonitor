// Shared shape rules for the frozen "Recent developments" rows (#7615), used
// by the freeze on the way in (scripts/freeze-crawlable-live-pulse.mjs) and by
// the corpus build on the way out (scripts/build-crawlable-corpus.mjs), so a
// snapshot frozen before a rule existed renders under the same rule as one
// frozen after it.
//
// Plain .mjs importing only plain-JS shared modules: the freeze runs under
// bare `node`.

import { countPublisherFamilies } from '../shared/publisher-families.js';
import {
  BRIEF_SECTION_HEADERS,
  isBriefBullet,
  isBriefOutlookRow,
  isBriefSectionHeader,
  stripBriefBullet,
} from '../shared/brief-format.js';

export {
  BRIEF_SECTION_HEADERS,
  isBriefBullet,
  isBriefOutlookRow,
  isBriefSectionHeader,
  stripBriefBullet,
};

// Briefs need grounding from at least this many DISTINCT PUBLISHERS before
// the freeze requests one and before the corpus publishes one (#7748 item
// 3). A 24/48/72h outlook synthesised from one outlet is a confident
// multi-horizon forecast off one source — a trust liability on a YMYL page —
// and three articles from one newsroom are still one outlet: the count reads
// publisher families (shared/publisher-families.js, #6428), never raw source
// labels. Below the floor the page keeps its dated headlines and drops the
// brief.
export const MIN_BRIEF_GROUNDING_PUBLISHERS = 2;

/** Distinct publisher families across a list of frozen rows (headlines or brief sources). */
export function briefGroundingPublisherCount(rows) {
  if (!Array.isArray(rows)) return 0;
  return countPublisherFamilies(rows.map((row) => row?.source));
}

/** True when the rows ground a brief: at least MIN_BRIEF_GROUNDING_PUBLISHERS distinct publishers. */
export function hasBriefGrounding(rows) {
  return briefGroundingPublisherCount(rows) >= MIN_BRIEF_GROUNDING_PUBLISHERS;
}

// "WHAT THIS MEANS FOR NO" — the server interpolated the ISO code where the
// name belongs (#7738). Repaired only when the code is this page's own code,
// so a brief that genuinely discusses another country is left alone.
const BARE_CODE_HEADING_RE = /^(WHAT THIS MEANS FOR)\s+([A-Z]{2})\s*:?$/;
// Markdown the model emits and the corpus injects as text: bold/italic
// marker pairs and ATX heading hashes. Kept as a list so the next marker is
// one entry, not a new guard (the first round pinned `**` alone).
const MARKDOWN_MARKERS_RE = /\*\*|__/g;
const MARKDOWN_HEADING_RE = /^#{1,6}\s+/;

/**
 * Plain-text form of a generated brief:
 * - markdown emphasis markers and heading hashes removed (the model writes
 *   `**entity**`; the corpus injects text, so the markers rendered literally
 *   — #7738);
 * - any preamble before the first contract section dropped ("INTELLIGENCE
 *   BRIEF: GE (GEORGIA) / CLASSIFICATION: CONFIDENTIAL" is model theatre, not
 *   content, and must not reach a public page);
 * - the "WHAT THIS MEANS FOR <CODE>" heading repaired to the country name.
 * Idempotent: normalizing normalized text is a no-op.
 */
export function normalizeBriefText(text, { countryCode = '', countryName = '' } = {}) {
  const code = String(countryCode || '').trim().toUpperCase();
  const name = String(countryName || '').trim();
  const lines = String(text || '')
    .replace(MARKDOWN_MARKERS_RE, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, '').replace(MARKDOWN_HEADING_RE, ''));
  const firstHeader = lines.findIndex((line) => isBriefSectionHeader(line));
  // Theatre carries no citations. A lead the model wrote under its own
  // header name ("CURRENT SITUATION ... [1]") is content, so a preamble with
  // a [n] citation anywhere is kept whole rather than guessed at.
  const preambleIsTheatre = firstHeader > 0
    && !lines.slice(0, firstHeader).some((line) => /\[\d+\]/.test(line));
  const body = preambleIsTheatre ? lines.slice(firstHeader) : lines;
  const repaired = body.map((line) => {
    const match = line.trim().match(BARE_CODE_HEADING_RE);
    if (!match || !code || !name || match[2] !== code) return line;
    return `${match[1]} ${name.toUpperCase()}`;
  });
  return repaired.join('\n').trim();
}

/** Non-empty trimmed lines of a brief, the unit both the renderer and the render guard work in. */
export function briefTextLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// True when the frozen developments carry at least one dated, sourced item:
// a headline, a brief, or a timeline event. The dated-absence shape
// (headlines: [], brief: null, timeline: [] or null) does not count. One
// predicate for the freeze's coverage counters and the corpus's tripwire.
export function developmentsHasDatedItem(developments) {
  if (!developments || typeof developments !== 'object') return false;
  if (Array.isArray(developments.headlines) && developments.headlines.length > 0) return true;
  if (developments.brief && typeof developments.brief.text === 'string' && developments.brief.text.trim()) return true;
  return Array.isArray(developments.timeline) && developments.timeline.length > 0;
}

/** Markdown emphasis markers removed from one published display string; non-strings pass through. */
export function stripMarkdownMarkers(value) {
  return typeof value === 'string' ? value.replace(MARKDOWN_MARKERS_RE, '') : value;
}

function stripRowMarkers(row, fields) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const field of fields) out[field] = stripMarkdownMarkers(out[field]);
  return out;
}

/**
 * Apply the publish-time rules to one frozen developments row. Returns a new
 * object; the input is never mutated. Every string the page renders is
 * cleared of markdown markers — headline and source titles, timeline titles
 * and summaries — not only the brief, because the build guard reads the
 * whole <main> and one marker in a timeline summary would otherwise fail a
 * complete weekly capture. Rows without a brief keep their shape.
 */
export function normalizeFrozenDevelopments(developments, { countryCode = '', countryName = '' } = {}) {
  if (!developments || typeof developments !== 'object') return developments;
  const cleaned = {
    ...developments,
    headlines: Array.isArray(developments.headlines)
      ? developments.headlines.map((row) => stripRowMarkers(row, ['title']))
      : developments.headlines,
    timeline: Array.isArray(developments.timeline)
      ? developments.timeline.map((row) => stripRowMarkers(row, ['title', 'summary']))
      : developments.timeline,
  };
  const brief = developments.brief && typeof developments.brief === 'object' ? developments.brief : null;
  if (!brief) return cleaned;
  // A malformed sources field is not thin grounding, it is a broken row:
  // hand it back untouched so the renderer's shape validation reds the build
  // instead of this rule quietly withholding it.
  const malformedSources = !Array.isArray(brief.sources)
    || brief.sources.some((row) => typeof row?.source !== 'string' || !row.source.trim());
  if (malformedSources) return { ...cleaned, brief };
  if (!hasBriefGrounding(brief.sources)) {
    return { ...cleaned, brief: null, briefSkipped: 'thin-grounding' };
  }
  return {
    ...cleaned,
    brief: {
      ...brief,
      text: normalizeBriefText(brief.text, { countryCode, countryName }),
      sources: Array.isArray(brief.sources)
        ? brief.sources.map((row) => stripRowMarkers(row, ['title']))
        : brief.sources,
    },
  };
}
