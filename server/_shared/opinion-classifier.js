// Brief-exclusion classifier for the WorldMonitor pipeline.
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
// Tiering (conservative — a false negative ships one non-event piece;
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

// ── STRONG: source-domain allowlist ──────────────────────────────────
// Publications whose entire output is commentary / analysis. Different
// signal from STRONG #1: those catch op-ed SECTIONS inside hard-news
// outlets (NYT/opinion/, BBC/views/). This catches publications where
// the WHOLE SITE is analysis and they don't use opinion-style URL
// paths. On 2026-05-19 the Bulletin of Atomic Scientists' "How nuclear
// war would impact the global food system" shipped as CRITICAL story
// #6 in a Pro brief — STRONG #1 missed it (no /opinion/ path), STRONG
// #2 missed it (no "Opinion:" prefix), CORROBORATING missed it
// (no quote-wrap, hard-news-shaped description).
//
// SELECTION CRITERIA (read before adding to this list):
//   1. Publication's editorial mission is analysis / commentary / op-ed.
//   2. They do NOT publish breaking-news wires or event coverage.
//   3. Dropping every piece they publish is editorially safer than
//      including any single piece as a brief "event."
//
// MAINTENANCE: this list is a permanent editorial commitment. Quarterly
// review against `droppedOpinion` telemetry to catch (a) new commentary
// publishers that should be added, (b) listed publishers that launched
// a hard-news section. Owner: brief on-call author.
//
// ROLLBACK: if a Doomsday-Clock-style EVENT from one of these publishers
// is unfairly dropped, remove the publisher from this Set. Do NOT add
// ad-hoc URL exceptions — they accumulate into cruft.
const COMMENTARY_HOSTNAMES = new Set([
  'thebulletin.org',          // Bulletin of the Atomic Scientists — entirely commentary/analysis
  'project-syndicate.org',    // Project Syndicate — op-eds from world leaders / academics
  'foreignaffairs.com',       // Foreign Affairs — CFR's analysis quarterly; long-form essays
  'warontherocks.com',        // War on the Rocks — defense analysis blog
  // NOTE: foreignpolicy.com is INTENTIONALLY NOT here. FP runs hard-news
  // surfaces — World Brief, Situation Report, Morning Brief — that
  // publish event coverage (e.g., "G-7 Finance Ministers Discuss
  // Economic Fallout of Iran War"). Allowlisting the whole hostname
  // would silently drop those events. FP's commentary pieces still get
  // caught by the existing /opinion/ path segment OR the "Opinion:" /
  // "Analysis:" headline prefix; that's the right granularity for
  // mixed-content publishers. PR #3835 review caught this.
]);

// ── CORROBORATING: description framing ───────────────────────────────
// Columnist/argument framing in the body. Alone these false-positive
// on quoted-statement hard news ("the minister argues that…"), so they
// only count toward a 2-signal threshold.
const CORROBORATING_DESCRIPTION_RE = /\b(?:columnist|op-?ed|opinion piece|our columnist|argues that|posits that|makes the case|the case for|guest essay|editorial board)\b/i;

// ── STRONG: historical explainer framing ─────────────────────────────
//
// A daily brief is an event feed, not an anniversary explainer. Some
// publishers do not mark these pieces as opinion in either their URL or RSS
// metadata, but their headline has a distinctive explanatory shape:
// "How <past event> changed/became/shaped …". Require BOTH that shape and a
// clearly historical anchor so ordinary current explainers (or ordinary
// reporting that merely references an old year) keep flowing. The anchor is
// deliberately conservative: a false positive silently removes a live event.
// This caught the July 2026 DW ten-year Turkey coup retrospective.
const HISTORICAL_EXPLAINER_HEADLINE_RE =
  /^(?:how|why)\b[\s\S]{0,180}\b(?:changed|(?:re)?shaped|transformed|altered|became|remade|defined)\b/i;
// Duration-led anniversary explainers use a different headline shape from the
// How/Why form above: "10 years on from <past event>". That shape alone is not
// enough because publishers also use it for live commemorations and new
// enforcement actions. Require explicit legacy/lasting-impact framing in the
// title or description as the second, retrospective signal; ordinary analytic
// verbs and current-state language are deliberately insufficient.
const HISTORICAL_ANNIVERSARY_HEADLINE_RE =
  /^(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:years?|decades?)|a\s+decade)\s+(?:on(?:\s+from)?|after|since)\b/i;
const HISTORICAL_ANNIVERSARY_CONTEXT_RE =
  /\b(?:legacy|(?:lasting|long[-\s]?term)\s+(?:impact|effects?|consequences?))\b/i;
const HISTORICAL_EXPLAINER_TITLE_TIME_RE =
  /\b(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:years?|decades?)\s+(?:ago|after|later|on(?:\s+from)?|since)|anniversary|retrospective|(?:a|this)\s+look back)\b/i;
const HISTORICAL_EXPLAINER_DESCRIPTION_LOOKBACK_RE = /\b(?:a|this)\s+look[-\s]?back\b/i;
const HISTORICAL_EXPLAINER_LIVE_EVENT_RE = /\b(?:today|overnight|this morning|an?\s+hour ago|hours ago|breaking)\b/i;
// A four-digit number alone is not an event year: it can be a troop count,
// dollar amount, or capacity. Require a nearby historic-event noun instead.
const HISTORICAL_EVENT_YEAR_RE =
  /\b((?:19|20)\d{2})\s+(?:coup(?:\s+attempt)?|war|invasion|election|referendum|uprising|protests?|crackdown|attack|crisis|conflict|earthquake|disaster)\b/gi;

function publishedYear(publishedAt) {
  if (typeof publishedAt !== 'number' && typeof publishedAt !== 'string') return null;
  const timestamp = typeof publishedAt === 'string' && /^\d+$/.test(publishedAt)
    ? Number(publishedAt)
    : publishedAt;
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  return Number.isNaN(date.getTime()) ? null : year;
}

function hasHistoricalEventYear(title, publishedAt) {
  const storyYear = publishedYear(publishedAt);
  if (storyYear === null) return false;
  for (const match of title.matchAll(HISTORICAL_EVENT_YEAR_RE)) {
    // Preserve the prior one-calendar-year grace, but derive it from the
    // article's persisted publication time rather than read-time Date.now().
    if (Number.parseInt(match[1], 10) < storyYear - 1) return true;
  }
  return false;
}

function isHistoricalExplainer(title, description, publishedAt) {
  const headline = title.trim();
  const fullText = `${headline} ${description}`;
  if (HISTORICAL_EXPLAINER_LIVE_EVENT_RE.test(fullText)) return false;
  if (
    HISTORICAL_ANNIVERSARY_HEADLINE_RE.test(headline) &&
    HISTORICAL_ANNIVERSARY_CONTEXT_RE.test(fullText)
  ) return true;
  if (!HISTORICAL_EXPLAINER_HEADLINE_RE.test(headline)) return false;
  if (HISTORICAL_EXPLAINER_TITLE_TIME_RE.test(headline)) return true;
  // Descriptions can corroborate only an explicit look-back label. Broad
  // anniversary wording in article copy is common in live coverage.
  if (HISTORICAL_EXPLAINER_DESCRIPTION_LOOKBACK_RE.test(description)) return true;
  return hasHistoricalEventYear(headline, publishedAt);
}

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
 * Parse URL pathname and hostname defensively. Malformed URL → empty parts
 * (skip URL signals entirely; do not throw). Closes the tracking-param
 * injection vector — aggregator tracking params (?utm=/opinion/promo)
 * and URL fragments (#/opinion/footer) live OUTSIDE the pathname and
 * must not trigger STRONG (or CORROBORATING) via raw-string includes()
 * matching on the full link. Backport of the same helper added in
 * feelgood-classifier.js (PR #3748 / adv-002).
 */
function safeUrlParts(link) {
  if (typeof link !== 'string' || link.length === 0) return { pathname: '', hostname: '' };
  try {
    const url = new URL(link);
    return { pathname: url.pathname.toLowerCase(), hostname: url.hostname.toLowerCase() };
  } catch {
    return { pathname: '', hostname: '' };
  }
}

function matchesCommentaryHost(hostname) {
  if (!hostname) return false;
  for (const entry of COMMENTARY_HOSTNAMES) {
    if (hostname === entry || hostname.endsWith('.' + entry)) return true;
  }
  return false;
}

/**
 * Classify a story as non-event brief content vs hard news.
 *
 * @param {{ title?: unknown; link?: unknown; description?: unknown; publishedAt?: unknown }} story
 * @returns {boolean} true = opinion/analysis or historical explainer
 *   (exclude from the brief)
 */
export function classifyOpinion(story) {
  const title = typeof story?.title === 'string' ? story.title : '';
  const link = typeof story?.link === 'string' ? story.link : '';
  const description = typeof story?.description === 'string' ? story.description : '';
  const publishedAt = story?.publishedAt;

  // Non-event historical explainers share the brief-exclusion contract with
  // opinion/analysis: do not let a retrospective rank like a live crisis.
  if (isHistoricalExplainer(title, description, publishedAt)) return true;

  // Parse once; path and host signals share the same defensive URL boundary.
  const { pathname, hostname } = safeUrlParts(link);

  // STRONG #1 — URL section. Matches a path segment on the parsed
  // pathname (NOT raw link), so tracking params / fragments can't
  // spoof a section match. Every STRONG_URL_SEGMENTS entry is
  // slash-delimited on both sides.
  if (pathname && STRONG_URL_SEGMENTS.some((seg) => pathname.includes(seg))) return true;

  // STRONG #2 — explicit headline prefix.
  if (STRONG_HEADLINE_PREFIX_RE.test(title.trim())) return true;

  // STRONG #3 — source-domain allowlist. Catches commentary-only
  // publishers whose WHOLE SITE is analysis (Bulletin of Atomic
  // Scientists, Project Syndicate, Foreign Affairs, …) — they don't
  // use /opinion/-style URL paths because they have no hard-news
  // section to distinguish from. Hostname match on the parsed URL
  // only, suffix-anchored to permit `newsletter.<host>` and `m.<host>`
  // while rejecting typo-domains.
  if (matchesCommentaryHost(hostname)) return true;

  // CORROBORATING — need at least TWO.
  let corroborating = 0;
  if (isWholeHeadlineQuoted(title)) corroborating += 1;
  if (CORROBORATING_DESCRIPTION_RE.test(description)) corroborating += 1;
  // `/analysis/` in the URL is corroborating, not strong. Parsed
  // pathname only (same injection-vector reasoning as STRONG #1).
  if (pathname && (pathname.includes('/analysis/') || pathname.includes('/analyses/'))) corroborating += 1;

  return corroborating >= 2;
}
