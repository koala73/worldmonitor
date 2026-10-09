// Pure text helpers: matching a spoken headline to a cluster, and the
// number-evidence check. No I/O here so every rule is unit-testable.

const STOPWORDS = new Set(`a an and are as at be been but by can could did do does for from had has have he her his how
i if in into is it its just more most new news no not now of on or our out over says said say she so than that the their
them then there these they this those to up us was we were what when where which while who why will with would you your
after amid ahead against about all also any back before being between both during each few first get gets got here last
like many may might much must next off once only other own same should since some still such through under until very
week weeks year years day days today yesterday report reports reported reportedly breaking live update updates latest
claim claims claimed`.split(/\s+/));

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']s\b/g, '')
    .split(/[^a-z0-9.%$-]+/)
    .map((t) => t.replace(/^[.\-$]+|[.\-]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Share of the headline's content words that the candidate text contains (0..1). */
export function overlapScore(headline, candidateText) {
  const h = [...new Set(tokenize(headline))];
  if (!h.length) return 0;
  const c = new Set(tokenize(candidateText));
  let hit = 0;
  for (const t of h) {
    if (c.has(t)) { hit += 1; continue; }
    // crude stem: "strikes" ~ "strike", "sanctioned" ~ "sanction"
    const stem = t.replace(/(ing|ed|es|s)$/, '');
    if (stem.length >= 4 && [...c].some((w) => w.startsWith(stem))) hit += 0.75;
  }
  return hit / h.length;
}

/**
 * Search terms for a substring-matching tool. Proper nouns and rare words
 * first, because get_news_clusters matches `query` as a literal substring.
 */
export function heuristicSearchTerms(headline, max = 4) {
  const raw = String(headline || '');
  const properNouns = [...raw.matchAll(/\b([A-Z][a-zA-Z\-]{2,}(?:\s+[A-Z][a-zA-Z\-]{2,})*)\b/g)]
    .map((m) => m[1])
    .filter((p, i) => !(i === 0 && STOPWORDS.has(p.toLowerCase())));
  const words = tokenize(raw).filter((t) => !/^\d/.test(t)).sort((a, b) => b.length - a.length);
  const out = [];
  for (const term of [...properNouns, ...words]) {
    const key = term.toLowerCase();
    if (STOPWORDS.has(key) || out.some((o) => o.toLowerCase() === key)) continue;
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

const SCALE = { thousand: 1e3, k: 1e3, million: 1e6, mn: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9, trillion: 1e12, tn: 1e12 };
const NUMBER_RE = /(\$|€|£)?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(%|percent|per cent|thousand|million|billion|trillion|bn|mn|tn|[kmb](?![a-z]))?/gi;

const CONTEXT_SKIP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'by', 'and', 'or', 'for', 'from', 'with', 'as', 'than', 'about', 'some', 'nearly', 'over', 'least', 'more', 'up', 'down', 'per']);

function contextWords(text, start, end) {
  const before = text.slice(Math.max(0, start - 40), start).toLowerCase().match(/[a-z]+/g) ?? [];
  const after = text.slice(end, end + 40).toLowerCase().match(/[a-z]+/g) ?? [];
  const pick = (arr) => arr.filter((w) => !CONTEXT_SKIP.has(w)).slice(0, 1);
  return [...pick(before.reverse()), ...pick(after)].map((w) => w.replace(/(ing|ed|es|s)$/, ''));
}

/** Every figure in a text, with its numeric value (scale words applied) and the words around it. */
export function extractFigures(text) {
  const out = [];
  const str = String(text || '');
  for (const m of str.matchAll(NUMBER_RE)) {
    const digits = m[2].replace(/,/g, '');
    const base = Number(digits);
    if (!Number.isFinite(base)) continue;
    const unit = (m[3] || '').toLowerCase();
    const isPercent = unit === '%' || unit.startsWith('per');
    const value = isPercent ? base : base * (SCALE[unit] ?? 1);
    out.push({ raw: m[0].trim(), digits, value, percent: isPercent, context: contextWords(str, m.index, m.index + m[0].length) });
  }
  return out;
}

function sameFigure(a, b) {
  if (a.percent !== b.percent) return false;
  if (a.digits === b.digits) return true;
  if (a.value === 0 || b.value === 0) return a.value === b.value;
  return Math.abs(a.value - b.value) / Math.max(a.value, b.value) < 0.005;
}

/** Two figures measure the same thing only when they share a neighbouring word ("75 basis" / "50 basis"). */
function sameQuantity(a, b) {
  return a.percent === b.percent && a.context.some((w) => b.context.includes(w));
}

/**
 * The extraction evidence gate, applied to a headline: each figure the
 * headline states must appear in the sourced text, or it is unproven.
 * A different figure is only a conflict when it measures the same thing:
 * "kills 200" is not contradicted by "magnitude 7.7".
 * With `bySource` ([{publisher, text}]) each figure also lists which
 * publishers state it, so a corroborated story with a one-publisher number
 * is visible.
 */
export function checkFigures(headline, evidenceText, bySource = []) {
  const claimed = extractFigures(headline);
  const available = extractFigures(evidenceText);
  return claimed.map((figure) => {
    const match = available.find((a) => sameFigure(figure, a));
    const conflict = match ? null : available.find((a) => !sameFigure(figure, a) && sameQuantity(figure, a)) ?? null;
    const statedBy = [...new Set(bySource
      .filter((s) => extractFigures(s.text).some((a) => sameFigure(figure, a)))
      .map((s) => s.publisher))];
    return { figure: figure.raw, found: Boolean(match), matchedAs: match?.raw ?? null, sourcesSay: conflict?.raw ?? null, statedBy };
  });
}

// Headlines that hang the claim on someone else's reporting.
const ATTRIBUTION_PATTERNS = [
  /\baccording to (?:a |an |the )?([A-Z][\w&.\- ]{1,40}?)(?:[,:;]|\s+(?:report|reports|sources|said)\b|$)/,
  /\bciting (?:a |an |the )?([A-Z][\w&.\- ]{1,40}?)(?:[,:;]|\s+(?:report|sources)\b|$)/,
  /\b(?:reports?|reported|tells?|told) ([A-Z][\w&.\-]{1,30}(?: [A-Z][\w&.\-]{1,30})?)\b/,
  /^([A-Z][\w&.\-]{1,30}(?: [A-Z][\w&.\-]{1,30})?):\s/,
  /[-–—|]\s*([A-Z][\w&.\-]{1,30}(?: [A-Z][\w&.\-]{1,30})?) (?:report|reports|says)\b/,
  /\b([A-Z][\w&.\-]{1,30}(?: [A-Z][\w&.\-]{1,30})?) (?:reports|reported|says|said|has learned)\b/,
];
const UNNAMED = /\b(?:sources say|officials say|report says|reports say|reportedly|unconfirmed|unverified|claims?)\b/i;
const NOT_A_PUBLISHER = new Set(['The', 'A', 'An', 'President', 'Officials', 'Police', 'Ministry', 'Army', 'Government', 'Minister', 'He', 'She', 'They', 'It']);

export function attributionOf(title) {
  for (const re of ATTRIBUTION_PATTERNS) {
    const m = String(title || '').match(re);
    if (m && m[1] && !NOT_A_PUBLISHER.has(m[1].trim().split(' ')[0])) return m[1].trim();
  }
  return UNNAMED.test(String(title || '')) ? '(unnamed sources)' : null;
}

/**
 * How many member headlines lean on one named origin. A cascade is several
 * outlets carrying a claim whose only stated origin is the same newsroom.
 */
export function attributionCascade(memberTitles) {
  const counts = new Map();
  let attributed = 0;
  for (const t of memberTitles || []) {
    const who = attributionOf(t);
    if (!who) continue;
    attributed += 1;
    const key = who.toLowerCase();
    counts.set(key, { name: who, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  const top = [...counts.values()].sort((a, b) => b.count - a.count)[0] ?? null;
  return { attributed, total: (memberTitles || []).length, origin: top?.name ?? null, originCount: top?.count ?? 0 };
}
