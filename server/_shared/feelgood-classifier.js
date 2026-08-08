// Feel-good / lifestyle classifier for the WorldMonitor brief pipeline.
//
// The brief is event-driven intelligence — a vintage-warplane veterans'
// reunion in Peru, Illinois (population 9,800) is not an event. On
// 2026-05-17 the 08:02 brief shipped "Veterans reunite with their
// vintage war planes" at card #4 (HIGH severity), sitting alongside
// WHO's Ebola declaration, Israeli airstrikes in Lebanon, US-Cuba
// escalation, and Iran's war-readiness warnings. The upstream
// importance/severity classifier wrongly tagged a community
// human-interest feature as HIGH because "veterans"/"war"/"planes"
// register as conflict-relevant vocabulary. See plan
// docs/plans/2026-05-17-001-fix-feelgood-lifestyle-filter-plan.md.
//
// This module is the SINGLE classifier — sibling to classifyOpinion —
// imported by BOTH the ingest path (list-feed-digest.ts → stamps
// isFeelGood onto story:track:v1) AND the read path
// (seed-digest-notifications.mjs buildDigest → re-classifies residue
// rows ingested before the stamp shipped).
//
// Tiering (conservative-by-design — a false negative ships one
// feel-good piece; a false positive silently drops a real event):
//   HARD-NEWS VETO   — runs FIRST; overrides every other path
//   STRONG           — sufficient alone (URL pathname segment OR
//                      headline prefix), subject to veto
//   CORROBORATING    — needs THREE distinct group names (alternation
//                      group label, NOT raw matched substring, to
//                      collapse morphological echoes)

// ── HARD-NEWS VETO — runs FIRST, overrides every classification path ──
//
// Conservative-by-design: this list errs on the side of preserving
// real events. Adding generic "war" / "combat" / country names was
// considered and rejected as slippery (would veto legitimate feel-good
// content with crossover vocabulary). The current list covers
// active-conflict, accountability, restitution, and casualty markers
// with their natural morphological inflections so the veto fires on
// the words news writers actually use ("strike kills six" rather than
// requiring "airstrike" + "killed").
const HARD_NEWS_VETO_RE = /\b(?:ceasefire|hostages?|refugees?|tribunal|war\s+crimes|looted|testify|testimony|testifying|airstrikes?|kills?|killed|killing|strikes?|struck|attacks?|attacked|attacking|bombs?|bombed|bombing|bombings|massacres?|casualt(?:y|ies)|militants?|dead|d(?:ied|ies|ying)|wounded|evacuat(?:ed|ing|ion))\b/i;

// ── STRONG: URL pathname segments (sufficient alone, subject to veto) ─
//
// A dedicated feel-good / photo-essay / community section in the URL
// is an unambiguous publisher signal. Every entry is SLASH-DELIMITED
// on both sides (path segment, not substring) — same lesson as PR #3690
// (`/opinion-` unbounded prefix → false positives on hard-news slugs).
//
// /travel/, /style/, /local/, /photos/, /photo/ are deliberately NOT
// here. Major outlets file legitimate hard news under all five:
//   - BBC files travel advisories under /travel/
//   - FT/Bloomberg file business-of-style under /style/
//   - Regional papers file breaking-local-news under /local/
//   - Reuters/AP wire-photo desks file breaking-news photo essays
//     of strikes/disasters/conflicts under /photos/
// All five live in CORROBORATING_PATHNAME_RE below instead.
const STRONG_URL_PATHNAME_SEGMENTS = [
  '/lifestyle/',
  '/lifestyles/',
  '/feature/',
  '/features/',
  '/gallery/',
  '/in-pictures/',
  '/oddities/',
  '/human-interest/',
  '/community/',
];

// ── STRONG: explicit headline prefix (sufficient alone, subject to veto) ─
//
// "Photos:", "Gallery:", "In Pictures:" — an explicit
// photo-essay / gallery label the publisher chose. Mirrors how the
// opinion-classifier handles "Opinion:" / "Analysis:".
//
// "Watch:" and "See:" deliberately NOT in this set — they overlap
// with legitimate news-video coverage (the CBS "Watch tornadoes swirl
// through Oklahoma" pattern), so including them would false-positive
// on hard news.
const STRONG_HEADLINE_PREFIX_RE = /^(?:photos?|gallery|in pictures)\s*:/i;

// ── CORROBORATING: feel-good tokens (named capture groups) ──────────
//
// Named groups are the DEDUP IDENTITY (per adv-R2-002): raw-substring
// matching would treat "reunite" / "reunited" / "reuniting" as 3
// distinct tokens and trip the threshold on a single inflection echo.
// Collapsing morphological variants into one named group ("reunite_group")
// fixes that — the distinct-set keys on group name, not match text.
//
// `restored` removed (adv-001 / C2): false-positives on art-restitution
//   ("Restored Klimt painting returned to family decades later").
// `meet the` removed (adv-R2-004): function-word bigram false-positives
//   on diplomacy ("US officials meet the Russian delegation").
//
// Multi-word tokens use \bword1\s+word2\b (whitespace-tolerant outer
// boundaries only).
const CORROBORATING_TOKENS_RE = /(?<reunite_group>\breunit(?:e[ds]?|ing|ers?)\b|\breunions?\b)|(?<vintage>\bvintage\b)|(?<nostalgia>\bnostalgia\b)|(?<memories_group>\bmemor(?:y|ies|ial)\b)|(?<tribute_group>\btributes?\b)|(?<heartwarming>\bheartwarming\b)|(?<inspirational>\binspirational\b)|(?<feel_good>\bfeel[-\s]good\b)|(?<local_hero>\blocal\s+hero\b)|(?<unsung>\bunsung\b)|(?<decades_later>\bdecades\s+later\b)|(?<years_later>\byears\s+later\b)/gi;

// ── CORROBORATING: framing phrases (apply to title AND description) ──
//
// Description-style framing language that can also appear in headlines
// ("Visit Vienna: vintage tour evokes powerful connections"). Each
// alternative gets its own named group so the dedup-by-group-label
// rule applies uniformly across all signal sources.
const CORROBORATING_FRAMING_RE = /(?<evoking_memories>\bevoking\s+(?:powerful\s+)?memories\b)|(?<powerful_connections>\bpowerful\s+connections\b)|(?<feel_good_story>\bfeel[-\s]good\s+story\b)|(?<human_interest>\bhuman\s+interest\b)|(?<lifestyle_feature>\blifestyle\s+feature\b)|(?<gathered_to_remember>\bgathered\s+to\s+remember\b)/gi;

// ── CORROBORATING: URL pathname segments (demoted from STRONG per M5 + adv-R2-001) ──
//
// Major outlets file hard news under all four sections — see comment on
// STRONG_URL_PATHNAME_SEGMENTS above. As CORROBORATING signals each
// counts as 1 distinct group when matched; the two /photos?/ variants
// collapse into photos_pathname.
const CORROBORATING_PATHNAME_RE = /\/(?<travel_pathname>travel)\/|\/(?<style_pathname>style)\/|\/(?<local_pathname>local)\/|\/(?<photos_pathname>photos?)\//gi;

/**
 * Parse the URL pathname defensively. Malformed URL → empty string
 * (skip URL signal entirely; do not throw). Closes the adv-002 / C3
 * injection vector — aggregator tracking params (?utm=/local/promo)
 * and URL fragments (#/community/footer) live OUTSIDE the pathname
 * and must not trigger STRONG via raw-string includes() matching.
 */
function safePathname(link) {
  if (typeof link !== 'string' || link.length === 0) return '';
  try {
    return new URL(link).pathname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Iterate matches of `re` over `text` and add every fired named-group
 * label to `groupSet`. The fired group is the single named group whose
 * value is defined on each match (alternation guarantees exactly one).
 */
function collectGroups(text, re, groupSet) {
  if (typeof text !== 'string' || text.length === 0) return;
  for (const match of text.matchAll(re)) {
    const groups = match.groups;
    if (!groups) continue;
    for (const name of Object.keys(groups)) {
      if (groups[name] !== undefined) groupSet.add(name);
    }
  }
}

/**
 * Classify a story as feel-good / lifestyle vs hard news.
 *
 * @param {{ title?: unknown; link?: unknown; description?: unknown }} story
 * @returns {boolean} true = feel-good / lifestyle (exclude from the brief)
 */
export function classifyFeelGood(story) {
  const title = typeof story?.title === 'string' ? story.title : '';
  const link = typeof story?.link === 'string' ? story.link : '';
  const description = typeof story?.description === 'string' ? story.description : '';

  // Step 1: HARD-NEWS VETO. Runs FIRST. Overrides every classification
  // path (STRONG URL, STRONG headline prefix, CORROBORATING ≥3).
  if (HARD_NEWS_VETO_RE.test(title) || HARD_NEWS_VETO_RE.test(description)) {
    return false;
  }

  const pathname = safePathname(link);

  // Step 2: STRONG URL pathname segment.
  if (pathname && STRONG_URL_PATHNAME_SEGMENTS.some((seg) => pathname.includes(seg))) {
    return true;
  }

  // Step 3: STRONG headline prefix.
  if (STRONG_HEADLINE_PREFIX_RE.test(title.trim())) return true;

  // Step 4: CORROBORATING ≥3 DISTINCT named-group labels across all
  // signal sources. The group-label dedup ensures morphological echoes
  // (reunite/reunited) count once, not multiple times.
  const distinctGroups = new Set();
  collectGroups(title, CORROBORATING_TOKENS_RE, distinctGroups);
  collectGroups(description, CORROBORATING_TOKENS_RE, distinctGroups);
  collectGroups(title, CORROBORATING_FRAMING_RE, distinctGroups);
  collectGroups(description, CORROBORATING_FRAMING_RE, distinctGroups);
  collectGroups(pathname, CORROBORATING_PATHNAME_RE, distinctGroups);

  return distinctGroups.size >= 3;
}
