/**
 * Internal link suggestions for the English docs and the blog.
 *
 * Code does the search, Jev does the judging (after stas4000/jev-linkmap):
 * TF-IDF picks the pages a source does not link to yet, and for each one the
 * phrases already in the source's prose that could carry the link. Jev answers
 * one yes/no and one multiple choice per candidate. Nothing is ever written
 * except `[phrase](href)` around words the author already wrote.
 *
 * Pure: file reading, HTTP and writes belong to scripts/internal-links.mjs.
 */

export const SITE_ORIGIN = 'https://www.worldmonitor.app';
export const JEV_MODEL = 'jev-1.13.0';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Observed rate on the scan that prompted this tool: 5.44M input tokens billed $0.2285.
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1e6;

export const RUBRIC = {
  link:
    'Should the SOURCE page link to this TARGET page? Yes when the source spends a sentence or passage on the main subject '
    + "named in the target's title (a dataset, panel, API operation, methodology, country, chokepoint or concept), so a reader "
    + 'there would want the target next. Yes for the API operation that serves data the source describes, and for the methodology '
    + 'that explains a score the source uses. No when only a generic word, the brand or a navigation label overlaps, or when the '
    + 'target covers a different dataset that happens to share words with the source.',
  anchor:
    "Pick the phrase that names this TARGET's subject. Drop fragments: a phrase containing a verb, or cut mid-clause, or ending "
    + "on a dangling word. Prefer the short complete noun phrase that repeats the target's title words. Answer none when no "
    + 'option is a phrase a reader would expect to lead to the target.',
  lessons: [
    "A phrase with a verb in it ('X turns Y', 'enqueues a job', 'partners receive derived facts') is a sentence fragment, never an anchor.",
    "A name that belongs to a different page is a wrong anchor even when the words overlap: 'Country Instability Index' does not lead to the Country Resilience Index.",
    "A phrase that stops before its noun phrase ends ('premium stock' in 'premium stock analysis', 'military flight' in 'military flight tracking') is a fragment: pick the complete phrase when it is offered.",
    'An API operation is the right target when the sentence describes the data that operation returns, not when it only mentions the API in general.',
  ],
  linkThreshold: 0.65,
  anchorConfidence: 0.4,
  maxLinksPerPage: 3,
};

const STOP = new Set((
  'a an the and or but if then else for to of in on at by with from as is are was were be been being it its this that these those '
  + 'you your we our us they their them he she his her i me my not no yes do does did done can could should would will may might must '
  + 'have has had having more most less least very much many few some any all each every other another such than too also just only '
  + 'about into over under again once here there when where why how what which who whom whose so up out off down own same both '
  + 'new best top guide complete vs versus using use used get make made way ways need needs like one two three '
  + 'world monitor worldmonitor docs doc page api reference list'
).split(' '));
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\-+.#]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu;

export function stem(w) {
  for (const [suf, cut] of [['ies', 3], ['sses', 2], ['ing', 3], ['es', 1], ['s', 1]]) {
    if (w.endsWith(suf) && w.length - cut >= 4 && !w.endsWith('ss')) return w.slice(0, -cut) + (suf === 'ies' ? 'y' : '');
  }
  return w;
}

const words = (text) => [...String(text).matchAll(WORD)].map((m) => ({ w: m[0], start: m.index, end: m.index + m[0].length }));
const termOf = (w) => {
  const low = w.toLowerCase();
  return STOP.has(low) || low.length < 2 ? '' : stem(low);
};
export const tokens = (text) => words(text).map(({ w }) => termOf(w)).filter(Boolean);

// `GetAirportOpsSummary` -> `Get Airport Ops Summary`.
export const splitCamel = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

// Spans on one markdown line that must never hold or cross an inserted link:
// a bold lead-in ('**Errors**:', '- **Desktop App:**', a bold FAQ question),
// inline code, links and images (the whole construct), autolinks, bare URLs,
// HTML/JSX tags and emphasis markers.
const PROTECTED = /^\s*(?:[-*+]\s+|\d+\.\s+)?\*\*[^*]+\*\*|`[^`]*`|!?\[[^\]]*\]\([^)]*\)|!?\[[^\]]*\]\[[^\]]*\]|<https?:[^>]*>|https?:\/\/\S+|<\/?[A-Za-z][^>]*>|\{[^}]*\}|\*+|~~/g;

/** The stretches of `line` a link may wrap, with their offsets in the raw line. */
export function plainSegments(line) {
  const out = [];
  let at = 0;
  for (const m of line.matchAll(PROTECTED)) {
    if (m.index > at) out.push({ start: at, text: line.slice(at, m.index) });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ start: at, text: line.slice(at) });
  return out;
}

const LINK = /!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/**
 * One markdown/MDX file: its frontmatter fields, the prose lines a link may
 * go in, the plain text for similarity, and every link target it already has.
 */
export function parseMarkdown(text) {
  const lines = String(text).split('\n');
  const front = {};
  let i = 0;
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      const m = lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (m) front[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
    i++;
  }
  const prose = [];
  const headings = [];
  const hrefs = [];
  let fence = null;
  let closer = null; // a multi-line JSX tag or comment: its attribute lines are not prose
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    const f = t.match(/^(```+|~~~+)/);
    if (fence) {
      if (f && t.startsWith(fence)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    if (closer) {
      for (const m of raw.matchAll(/\bhref=["']([^"']+)["']/g)) hrefs.push(m[1]);
      if (closer.test(raw)) closer = null;
      continue;
    }
    if (/^<!--/.test(t) && !/--!?>/.test(t)) closer = /--!?>/;
    else if (/^\{\/\*/.test(t) && !t.includes('*/}')) closer = /\*\/\}/;
    else if (/^<[A-Za-z]/.test(t) && !/>\s*$/.test(t) && !/>/.test(t.replace(/"[^"]*"|'[^']*'/g, ''))) closer = />/;
    for (const m of raw.matchAll(LINK)) if (!m[0].startsWith('!')) hrefs.push(m[2]);
    for (const m of raw.matchAll(/\bhref=["']([^"']+)["']/g)) hrefs.push(m[1]);
    if (/^#{1,6}\s/.test(t)) {
      headings.push(t.replace(/^#+\s*/, ''));
      continue;
    }
    if (!t || /^(import|export)\s/.test(t) || /^[<{|]/.test(t) || /^[-*_]{3,}$/.test(t)) continue;
    // A label that introduces a list ('Common errors:') names no subject of its own.
    if (/^[^.]{0,40}:$/.test(t)) continue;
    prose.push({ line: i, text: raw });
  }
  const plain = prose.map((p) => p.text.replace(LINK, '$1').replace(/<[^>]*>|[`*_]/g, ' ')).join('\n');
  return { front, headings, prose, plain, hrefs };
}

/**
 * Canonical absolute URL for an href found in a source page, or null when it
 * points off-site. Docs pages link Mintlify-relative (`/methodology/x`), so a
 * bare path from a docs page resolves under /docs.
 */
export function canonicalHref(href, sourceKind) {
  let h = String(href).trim();
  if (h.startsWith('#') || /^(mailto|tel):/i.test(h)) return null;
  if (/^https?:\/\//i.test(h)) {
    const u = new URL(h);
    if (!/(^|\.)worldmonitor\.app$/i.test(u.hostname)) return null;
    h = u.pathname;
  } else {
    h = h.split(/[?#]/)[0];
    if (!h.startsWith('/')) return null;
    if (sourceKind === 'docs' && !/^\/(docs|blog)(\/|$)/.test(h)) h = `/docs${h}`;
  }
  h = h.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
  return `${SITE_ORIGIN}${h || ''}`;
}

/**
 * How `source` writes a link to `target`, following each surface's existing
 * convention: Mintlify-relative inside the docs, root-relative inside the
 * blog, the canonical absolute URL (its own trailing-slash form) across them.
 */
export function hrefFor(source, target) {
  const path = new URL(target.url).pathname;
  if (source.kind === 'docs' && target.kind === 'docs') return path.slice('/docs'.length);
  if (source.kind === 'blog' && target.kind === 'blog') return path;
  return target.url;
}

/**
 * A page never links to itself or to a page it already links to, and the
 * reference docs link to reference and product pages, not to blog posts: a
 * docs sentence about the Scenario Engine should lead to its docs page.
 */
export const mayLink = (source, target) =>
  target.key !== source.key && !source.outbound.has(target.key) && !(source.kind === 'docs' && target.kind === 'blog');

// Share of the target's topic weight a phrase must carry to be offered as its anchor.
const MIN_ANCHOR_COVER = 0.3;

const topicText = (p) => [p.title, p.h1 ?? '', new URL(p.url).pathname.replace(/[-_/%]+/g, ' ')].join(' ');

export class LinkIndex {
  /** @param {Array<{key:string,url:string,kind:'docs'|'blog'|'site',title:string,name?:string,about:string,headings:string[],plain:string,prose:Array<{line:number,text:string}>,outbound:Set<string>,editable:boolean}>} pages */
  constructor(pages) {
    this.pages = pages;
    const docs = pages.map((p) => {
      const c = new Map();
      for (const t of tokens(p.plain)) c.set(t, (c.get(t) ?? 0) + 1);
      // What a page says it is about outweighs what it happens to mention.
      for (const t of tokens(`${topicText(p)} ${p.headings.join(' ')}`)) c.set(t, (c.get(t) ?? 0) + 4);
      return c;
    });
    const df = new Map();
    for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const n = docs.length;
    this.idf = new Map([...df].map(([t, c]) => [t, Math.log((1 + n) / (1 + c)) + 1]));
    this.vecs = docs.map((d) => {
      const v = new Map([...d].map(([t, c]) => [t, (1 + Math.log(c)) * this.idf.get(t)]));
      const norm = Math.hypot(...v.values()) || 1;
      for (const [t, x] of v) v.set(t, x / norm);
      return v;
    });
    this.postings = new Map();
    this.vecs.forEach((v, i) => {
      for (const [t, x] of v) {
        if (!this.postings.has(t)) this.postings.set(t, []);
        this.postings.get(t).push([i, x]);
      }
    });
    // A term on more than 15% of pages ('global', 'real time', 'country') names
    // no page in particular, so it cannot make a phrase an anchor.
    this.topics = pages.map((p) => {
      const terms = new Map();
      for (const t of tokens(topicText(p))) if ((df.get(t) ?? 0) <= 0.15 * n) terms.set(t, this.idf.get(t) ?? 1);
      return terms;
    });
  }

  similar(i, k, accept = () => true) {
    const scores = new Map();
    for (const [t, x] of this.vecs[i]) {
      for (const [j, y] of this.postings.get(t)) if (j !== i) scores.set(j, (scores.get(j) ?? 0) + x * y);
    }
    const src = this.pages[i];
    return [...scores]
      .filter(([j]) => mayLink(src, this.pages[j]) && accept(this.pages[j]))
      .sort((a, b) => b[1] - a[1])
      .slice(0, k);
  }

  /**
   * Phrases of up to six words already in page i's prose that speak page j's
   * topic: both ends are topic terms and at least two distinct terms hit, or
   * the phrase is the target's whole name (a country, a chokepoint).
   */
  anchors(i, j, limit = 5) {
    const terms = this.topics[j];
    if (!terms.size) return [];
    const total = [...terms.values()].reduce((a, b) => a + b, 0);
    // Only a generated page's name (a country, a chokepoint) may be a one-word anchor.
    const name = (this.pages[j].name ?? this.pages[j].title).toLowerCase();
    const found = new Map();
    for (const { line, text } of this.pages[i].prose) {
      for (const seg of plainSegments(text)) {
        for (const sentence of seg.text.split(/(?<=[.!?:;])\s+|[,()"“”|/]/)) {
          const ws = words(sentence);
          const ts = ws.map(({ w }) => termOf(w));
          const cap = (k) => /^\p{Lu}/u.test(ws[k].w) && ((ws[k].w.length > 1 && ws[k].w === ws[k].w.toUpperCase()) || !STOP.has(ws[k].w.toLowerCase()));
          const joined = (k) => sentence.slice(ws[k].end, ws[k + 1].start) === ' ';
          const offer = (lo, hi, score, family) => {
            const span = sentence.slice(ws[lo].start, ws[hi].end);
            const key = span.toLowerCase();
            if (!found.has(key) || found.get(key).score < score) {
              found.set(key, { phrase: span, line, sentence: text.trim().slice(0, 320), score: Math.round(score * 1e4) / 1e4, family });
            }
          };
          for (let a = 0; a < ws.length; a++) {
            if (!terms.has(ts[a])) continue;
            for (let z = a; z < Math.min(a + 6, ws.length); z++) {
              if (!terms.has(ts[z])) continue;
              const hit = new Set(ts.slice(a, z + 1).filter((t) => terms.has(t)));
              const named = this.pages[j].kind === 'site' && sentence.slice(ws[a].start, ws[z].end).toLowerCase() === name;
              if (hit.size < 2 && !named) continue;
              const cover = [...hit].reduce((s, t) => s + terms.get(t), 0) / total;
              if (cover < MIN_ANCHOR_COVER && !named) continue;
              const score = cover * (0.5 + (0.5 * hit.size) / (z - a + 1));
              // A capitalized span inside a longer name ('FAO Food Price' of
              // 'FAO Food Price Index') is offered as the whole name only.
              let lo = a;
              let hi = z;
              if (cap(hi)) while (hi + 1 < ws.length && joined(hi) && cap(hi + 1)) hi++;
              if (cap(lo)) while (lo > 0 && joined(lo - 1) && cap(lo - 1)) lo--;
              if (hi - lo >= 6) continue;
              const family = `${line}:${lo}`;
              offer(lo, hi, score, family);
              // 'premium stock' may be the head of 'premium stock analysis':
              // offer the next word too and let the judge pick the complete phrase.
              const next = ws[hi + 1]?.w;
              if (!named && next && hi - lo < 5 && joined(hi) && /^\p{Ll}+$/u.test(next) && !STOP.has(next)) offer(lo, hi + 1, score, family);
            }
          }
        }
      }
    }
    const picked = [];
    for (const c of [...found.values()].sort((x, y) => y.score - x.score || x.phrase.length - y.phrase.length)) {
      const low = c.phrase.toLowerCase();
      if (picked.some((p) => p.family !== c.family && (p.phrase.toLowerCase().includes(low) || low.includes(p.phrase.toLowerCase())))) continue;
      picked.push(c);
      if (picked.length === limit) break;
    }
    return picked;
  }
}

/**
 * One job per editable page: of its `k` most similar unlinked pages, the
 * first `perPage` that have at least one anchor phrase in its prose.
 */
export function buildQueue(pages, { k = 40, perPage = 15, anchors = 5, minWords = 120 } = {}) {
  const idx = new LinkIndex(pages);
  const queue = [];
  pages.forEach((p, i) => {
    if (!p.editable || tokens(p.plain).length < minWords) return;
    const targets = [];
    for (const [j, sim] of idx.similar(i, k)) {
      if (targets.length === perPage) break;
      const opts = idx.anchors(i, j, anchors);
      if (!opts.length) continue;
      const t = pages[j];
      targets.push({ id: `t${targets.length + 1}`, key: t.key, url: t.url, title: t.title, about: t.about.slice(0, 240), similarity: Math.round(sim * 1e4) / 1e4, anchors: opts });
    }
    if (targets.length) queue.push({ source: p.key, targets });
  });
  return queue;
}

export function buildJevRequest(job, page, { copyWords = 1500, model = JEV_MODEL, rubric = RUBRIC } = {}) {
  const questions = {};
  for (const t of job.targets) {
    questions[`${t.id}_link`] = { type: 'noul', instructions: `TARGET ${t.id}: ${t.title}. ${rubric.link}` };
    const criteria = Object.fromEntries(t.anchors.map((a, n) => [`a${n + 1}`, `"${a.phrase}" in the sentence: ${a.sentence}`]));
    criteria.none = 'none of these phrases is an honest anchor for this target';
    questions[`${t.id}_anchor`] = { type: 'choice', instructions: `TARGET ${t.id}: ${t.title}. ${rubric.anchor}`, criteria };
  }
  return {
    model,
    state: {
      source: { url: page.url, title: page.title, copy: page.plain.split(/\s+/).slice(0, copyWords).join(' ') },
      targets: job.targets.map((t) => ({ id: t.id, title: t.title, about: t.about })),
      lessons: rubric.lessons,
    },
    questions,
  };
}

/** Verdict per target id; a missing or malformed answer is a "no". */
export function parseJevAnswers(body, job) {
  const answers = body?.answers ?? {};
  const verdicts = {};
  for (const t of job.targets) {
    const link = Number(answers[`${t.id}_link`]?.noul);
    const anchor = answers[`${t.id}_anchor`];
    const choice = anchor?.type === 'choice' && /^a\d+$/.test(anchor.choice) && t.anchors[Number(anchor.choice.slice(1)) - 1] ? anchor.choice : 'none';
    verdicts[t.id] = { link: Number.isFinite(link) ? link : 0, anchor: choice, anchorConfidence: Number(anchor?.confidence) || 0 };
  }
  return verdicts;
}

export const RELATED_RUBRIC = {
  instructions:
    "Would a reader of this PAGE want to read the TARGET next? Yes only when the target is about the page's own subject: "
    + 'the same country, the same crisis, or the same product choice the comparison helps with. '
    + 'No when the target names the subject only in passing, in a list or table, or as one example among many; '
    + 'no for general methodology, data-source or product overview pages that would suit any page of this kind.',
  threshold: 0.7,
  max: 3,
};

/** One request per generated page: a yes/no probability per candidate reading. */
export function buildRelatedRequest(page, candidates, { copyWords = 800, model = JEV_MODEL } = {}) {
  return {
    model,
    state: {
      page: { url: page.url, title: page.title, about: page.about, copy: page.plain.split(/\s+/).slice(0, copyWords).join(' ') },
      targets: candidates.map((c, n) => ({ id: `t${n + 1}`, title: c.title, about: c.about.slice(0, 240) })),
    },
    questions: Object.fromEntries(candidates.map((c, n) => [
      `t${n + 1}`,
      { type: 'noul', instructions: `TARGET t${n + 1}: ${c.title}. ${RELATED_RUBRIC.instructions}` },
    ])),
  };
}

/** The candidates Jev is sure about, most probable first, at most RELATED_RUBRIC.max. */
export function pickRelated(body, candidates, rubric = RELATED_RUBRIC) {
  const answers = body?.answers ?? {};
  return candidates
    .map((c, n) => ({ c, p: Number(answers[`t${n + 1}`]?.noul) }))
    .filter(({ p }) => Number.isFinite(p) && p >= rubric.threshold)
    .sort((a, b) => b.p - a.p)
    .slice(0, rubric.max)
    .map(({ c, p }) => ({ candidate: c, p }));
}

/** Sure enough about the link, an anchor that exists, best first, each target and phrase once. */
export function placeLinks(job, verdicts, rubric = RUBRIC) {
  const ranked = job.targets
    .map((t) => ({ t, v: verdicts[t.id] }))
    .filter(({ v }) => v && v.link >= rubric.linkThreshold && v.anchor !== 'none' && v.anchorConfidence >= rubric.anchorConfidence)
    .sort((a, b) => b.v.link - a.v.link);
  const placed = [];
  const used = [];
  for (const { t, v } of ranked) {
    const a = t.anchors[Number(v.anchor.slice(1)) - 1];
    const low = a.phrase.toLowerCase();
    if (used.some((u) => u.includes(low) || low.includes(u))) continue;
    used.push(low);
    placed.push({ source: job.source, target: t.key, targetTitle: t.title, anchor: a.phrase, line: a.line, sentence: a.sentence, link: v.link, anchorConfidence: v.anchorConfidence });
    if (placed.length === rubric.maxLinksPerPage) break;
  }
  return placed;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Wraps each link's anchor, on its recorded line, in `[anchor](href)`. Only a
 * whole-word occurrence inside a plain segment qualifies, so an anchor inside
 * code, an existing link or a tag is never touched. Returns the new text and
 * the links that could not be placed (the file changed since the proposal).
 */
export function applyLinks(text, links) {
  const lines = String(text).split('\n');
  const skipped = [];
  for (const l of links) {
    const raw = lines[l.line];
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(l.anchor)}(?![\\p{L}\\p{N}])`, 'u');
    let done = false;
    if (raw !== undefined) {
      for (const seg of plainSegments(raw)) {
        const m = seg.text.match(re);
        if (!m) continue;
        const at = seg.start + m.index;
        lines[l.line] = `${raw.slice(0, at)}[${l.anchor}](${l.href})${raw.slice(at + l.anchor.length)}`;
        done = true;
        break;
      }
    }
    if (!done) skipped.push(l);
  }
  return { text: lines.join('\n'), skipped };
}
