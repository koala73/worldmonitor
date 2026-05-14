// Opinion / analysis classifier for the WorldMonitor brief pipeline.
//
// The brief is event-driven intelligence — an op-ed column is not an
// event. On 2026-05-14 a Le Monde opinion column ("'Russia's invasion
// of Ukraine could have warned Trump…'", by columnist Gilles Paris)
// shipped as story #1, tagged Critical, ahead of a nuclear ICBM test.
// See plan docs/plans/2026-05-14-001-fix-brief-pipeline-parity-grounding-opinion-plan.md
// (F3, Phase 3).
//
// This module is the SINGLE classifier, imported by BOTH the ingest
// path (server/worldmonitor/news/v1/list-feed-digest.ts — stamps
// `isOpinion` onto the story:track:v1 row) AND the read path
// (scripts/seed-digest-notifications.mjs buildDigest — re-classifies
// to catch residue rows ingested before the ingest stamp shipped).
//
// Available signals at BOTH layers are the same: title, link (URL),
// description. story:track:v1 does not persist byline or feed-section
// metadata, and the parsed RSS item does not carry them either — so
// there is no richer ingest-time signal to exploit.
//
// Tiering (conservative — a false negative ships one opinion piece;
// a false positive silently drops a real event):
//   STRONG       — sufficient alone to classify as opinion
//   CORROBORATING — needs a STRONG signal OR two CORROBORATING signals

// ── STRONG: URL path / feed-section segments ─────────────────────────
// A dedicated opinion/commentary section in the URL is an unambiguous
// publisher signal. Every entry is SLASH-DELIMITED on both sides — a
// real path segment, not a substring. An unbounded `/opinion-` prefix
// was rejected on review: it false-positives on hard-news article
// slugs like `/world/opinion-polls-tighten-election` (PR #3690
// review). `/analysis/` is deliberately NOT here either — many
// outlets file hard-news explainers under /analysis/ (it is a
// CORROBORATING signal below).
const STRONG_URL_SEGMENTS = [
  '/opinion/',
  '/opinions/',
  '/views/',
  '/commentary/',
  '/editorial/',
  '/editorials/',
  '/op-ed/',
  '/op-eds/',
  '/columnists/',
  '/columnist/',
  '/columns/',
];

// ── STRONG: explicit headline prefix ─────────────────────────────────
// "Opinion: …", "Analysis: …", "Commentary: …", "Op-Ed: …" — an
// explicit editorial label the publisher chose. Mirrors the prefix
// set stripHeadlinePrefix removes for display, but here it CLASSIFIES
// rather than strips. Trailing colon required so a bare-noun headline
// ("Opinion polls tighten…") is not caught.
const STRONG_HEADLINE_PREFIX_RE = /^(?:opinion|analysis|commentary|op-?ed|editorial|perspective|viewpoint)\s*:/i;

// ── CORROBORATING: description framing ───────────────────────────────
// Columnist/argument framing in the body. Alone these false-positive
// on quoted-statement hard news ("the minister argues that…"), so they
// only count toward a 2-signal threshold.
const CORROBORATING_DESCRIPTION_RE = /\b(?:columnist|op-?ed|opinion piece|our columnist|argues that|posits that|makes the case|the case for|guest essay|editorial board)\b/i;

// ── CORROBORATING: whole-headline quote wrap ─────────────────────────
// An entire headline wrapped in quotation marks is the classic op-ed
// headline format (the May 14 Le Monde column). But a hard-news
// headline can also lead with a quoted phrase, so this is corroborating
// only. Requires the FULL headline to be quote-wrapped — a headline
// that merely CONTAINS a quoted phrase does not count.
function isWholeHeadlineQuoted(title) {
  if (typeof title !== 'string') return false;
  const t = title.trim();
  if (t.length < 2) return false;
  const first = t[0];
  const last = t[t.length - 1];
  const opensQuote = first === '"' || first === '“' || first === "'" || first === '‘';
  const closesQuote = last === '"' || last === '”' || last === "'" || last === '’';
  return opensQuote && closesQuote;
}

/**
 * Classify a story as opinion/analysis vs hard news.
 *
 * @param {{ title?: unknown; link?: unknown; description?: unknown }} story
 * @returns {boolean} true = opinion/analysis (exclude from the brief)
 */
export function classifyOpinion(story) {
  const title = typeof story?.title === 'string' ? story.title : '';
  const link = typeof story?.link === 'string' ? story.link : '';
  const description = typeof story?.description === 'string' ? story.description : '';

  // STRONG #1 — URL section. Lowercased; matches a path segment.
  const lowerLink = link.toLowerCase();
  if (STRONG_URL_SEGMENTS.some((seg) => lowerLink.includes(seg))) return true;

  // STRONG #2 — explicit headline prefix.
  if (STRONG_HEADLINE_PREFIX_RE.test(title.trim())) return true;

  // CORROBORATING — need at least TWO.
  let corroborating = 0;
  if (isWholeHeadlineQuoted(title)) corroborating += 1;
  if (CORROBORATING_DESCRIPTION_RE.test(description)) corroborating += 1;
  // `/analysis/` in the URL is corroborating, not strong.
  if (lowerLink.includes('/analysis/') || lowerLink.includes('/analyses/')) corroborating += 1;

  return corroborating >= 2;
}
