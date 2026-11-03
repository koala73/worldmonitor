// Retrieval helpers: matching a spoken headline to a WorldMonitor cluster.
// They find the story; they never grade it (lib/wm.mjs does that).

const TOKENIZE_RE = /[̀-ͯ]/g;
const TOKENIZE_RE_2 = /[’']s\b/g;
const TOKENIZE_RE_3 = /[^a-z0-9.%$-]+/;
const TOKENIZE_RE_4 = /^[.\-$]+|[.\-]+$/g;
const STEM_RE = /(ing|ed|es|s)$/;
const PROPER_NOUNS_RE = /\b([A-Z][a-zA-Z\-]{2,}(?:\s+[A-Z][a-zA-Z\-]{2,})*)\b/g;
const WORDS_RE = /^\d/;

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
    .replace(TOKENIZE_RE, '')
    .replace(TOKENIZE_RE_2, '')
    .split(TOKENIZE_RE_3)
    .map((t) => t.replace(TOKENIZE_RE_4, ''))
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
    const stem = t.replace(STEM_RE, '');
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
  const properNouns = [...raw.matchAll(PROPER_NOUNS_RE)]
    .map((m) => m[1])
    .filter((p, i) => !(i === 0 && STOPWORDS.has(p.toLowerCase())));
  const words = tokenize(raw).filter((t) => !WORDS_RE.test(t)).sort((a, b) => b.length - a.length);
  const out = [];
  for (const term of [...properNouns, ...words]) {
    const key = term.toLowerCase();
    if (STOPWORDS.has(key) || out.some((o) => o.toLowerCase() === key)) continue;
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}
