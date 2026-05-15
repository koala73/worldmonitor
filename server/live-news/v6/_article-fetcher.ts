/**
 * v6 article-body fetcher — fetches the publisher's article HTML for the
 * sole purpose of giving the embedder a richer, more consistent signal
 * to cluster on.
 *
 * # Why
 *
 * RSS-supplied content varies wildly by feed:
 *   • Some feeds expose `<content:encoded>` with the full article body
 *     (Intercept, ProPublica, Time, Postmedia papers).
 *   • Some expose only a 1-2 sentence `<description>` lede (BBC, Reuters,
 *     wire-style outlets).
 *   • Some expose almost nothing — just title + link.
 *
 * That heterogeneity is bad for clustering: a brief "BBC: Five Italians
 * die" embeds to a different region of vector space than a 600-char
 * tabloid retelling of the same event, even though they're the same
 * story. Equalising the input by fetching the actual article body and
 * extracting the lede lifts cluster precision and recall.
 *
 * # Scope guarantees
 *
 *   • This module is CLUSTERING-ONLY. The fetched body is fed to
 *     the embedder via `_cluster.ts:inputTextFor`. It NEVER appears
 *     on the wire that iOS reads — `pickSummary` reads only
 *     `RawRssItem.description`, which is the publisher's RSS-supplied
 *     brief.
 *   • We don't republish, paraphrase, or display the scraped content.
 *   • Cache TTL is 7 days for successful extracts, 2h for failures.
 *     We never persist the raw HTML — only the extracted plaintext
 *     (capped at MAX_BODY_LEN).
 *
 * # Budget
 *
 * 25s wall-clock cap with concurrency 20. Typical refresh sees most
 * items cache-hit after a few cycles, so steady-state has 50-200 fresh
 * fetches per run. Per-fetch timeout 8s. Items not reached this run
 * are simply attempted on the next refresh — no failure cascade.
 */

import { getCachedJsonBatch, setCachedJson } from '../../_shared/redis';
import { sha256Hex } from '../../_shared/hash';
import type { RawRssItem } from './_normalize';

const ARTICLE_CACHE_PREFIX = 'live-news:v6:article:v1:';
const ARTICLE_TTL_S = 7 * 24 * 60 * 60;   // 7 days for successful extracts
const ARTICLE_NEG_TTL_S = 2 * 60 * 60;     // 2 hours for failures
const FETCH_TIMEOUT_MS = 8_000;
const FETCH_CONCURRENCY = 20;
const TOTAL_BUDGET_MS = 25_000;
const MAX_BODY_LEN = 2000;
const MIN_BODY_LEN = 200;

/** Sentinel cached at the article cache key when extraction failed or
 *  the URL refused to load. Distinct from a normal value so we don't
 *  retry hopeless URLs every refresh. */
const NEG_SENTINEL = '__WM_NEG__';

/** Browser-like UA. Many publishers serve 403/empty to bot-flavored UAs;
 *  Safari-on-macOS reliably gets the full article HTML. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/** Override via `WM_V6_ARTICLE_FETCH=0` to disable in an emergency
 *  (e.g. if Vercel egress starts getting flagged on a critical site). */
function isEnabled(): boolean {
  return process.env.WM_V6_ARTICLE_FETCH !== '0';
}

// ── HTML utilities ────────────────────────────────────────────────

/** Mirror of `_normalize.ts:decodeXmlEntities` — same coverage set so
 *  text extracted from article HTML decodes the same as text extracted
 *  from RSS XML. Order matters; see _normalize.ts for the rationale. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&bull;/g, '•')
    .replace(/&middot;/g, '·')
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(s: string): string {
  return decodeEntities(
    s
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull all sufficiently-long `<p>` text out of an HTML fragment and
 *  concatenate. 30-char threshold filters out picture credits, photo
 *  captions, "Share this story" boilerplate that surrounds the real
 *  paragraphs in most article markup. */
function extractParagraphs(html: string): string {
  const paragraphs: string[] = [];
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(html)) !== null) {
    const text = stripHtml(m[1]!);
    if (text.length > 30) paragraphs.push(text);
  }
  return paragraphs.join(' ').trim();
}

// ── Article body extraction ───────────────────────────────────────

/**
 * Window of HTML to consider once we've located the article body's
 * opening tag for the itemprop / class-token tiers. Lazy `</tag>` matching
 * is unsafe here because nested `<div>`s would close the regex against an
 * inner closing tag rather than the wrapper's. Slicing a fixed window
 * after the opening tag and feeding it to `extractParagraphs` is more
 * robust and bounded.
 */
const BODY_WINDOW_BYTES = 50_000;

/**
 * Try increasingly fuzzy strategies to find the article body in an
 * arbitrary news HTML page. Returns null if nothing yields ≥
 * MIN_BODY_LEN chars of plausible body text.
 *
 *   1. JSON-LD `articleBody` — Schema.org. Most reputable news sites
 *      embed this in `<script type="application/ld+json">`. Cleanest
 *      because the publisher hand-curates it.
 *   2. <article> tag <p> content — semantic HTML5; modern sites wrap
 *      the body in this. Works for ~70% of feeds we touch.
 *   3. <main> tag <p> content — fallback when site uses <main> but
 *      not <article>.
 *   4. [itemprop="articleBody"] element — Schema.org microdata.
 *      Covers RTÉ, PBS reliably; can land on a description div on a
 *      few sites (Hindu) so the MIN_BODY_LEN gate is essential.
 *   5. Class-token match on <div> — catches React/Next.js publishers
 *      that close <main> before the body and emit the article into a
 *      named div: News24 (`article__body`), Anadolu (`prose`),
 *      RNZ (`article__body`), Hindu (`articlebodycontent`), plus a
 *      WordPress safety net (`entry-content`).
 *   6. og:description meta tag — ~200 char floor; always present.
 */
function extractArticleBody(html: string): string | null {
  // 1. JSON-LD articleBody (Schema.org)
  const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonLdRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]!.trim()) as unknown;
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates as Array<Record<string, unknown>>) {
        // Some sites wrap multiple types under @graph
        const graph =
          (Array.isArray(c['@graph']) ? (c['@graph'] as Array<Record<string, unknown>>) : null) ?? [c];
        for (const node of graph) {
          const ab = node['articleBody'];
          if (typeof ab === 'string' && ab.length >= MIN_BODY_LEN) {
            return ab.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_LEN);
          }
        }
      }
    } catch {
      // Malformed JSON-LD blocks are common; ignore and keep looking.
    }
  }

  // 2. <article> tag
  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    const text = extractParagraphs(articleMatch[1]!);
    if (text.length >= MIN_BODY_LEN) return text.slice(0, MAX_BODY_LEN);
  }

  // 3. <main> tag
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) {
    const text = extractParagraphs(mainMatch[1]!);
    if (text.length >= MIN_BODY_LEN) return text.slice(0, MAX_BODY_LEN);
  }

  // 4. [itemprop="articleBody"] — Schema.org microdata marker.
  //    Element type varies (div/section/article) so we match any tag.
  //    50KB window after the opening tag is safer than chasing the
  //    closing tag through nested divs.
  const itemPropRe = /<\w+\b[^>]+itemprop=["']articleBody["'][^>]*>/i;
  const itemPropMatch = html.match(itemPropRe);
  if (itemPropMatch && itemPropMatch.index !== undefined) {
    const start = itemPropMatch.index + itemPropMatch[0].length;
    const window = html.slice(start, start + BODY_WINDOW_BYTES);
    const text = extractParagraphs(window);
    if (text.length >= MIN_BODY_LEN) return text.slice(0, MAX_BODY_LEN);
  }

  // 5. Class-token match on <div>. Whitelisted classes cover the
  //    publishers whose React/CMS templates close <main> before the
  //    body. `\b` word-boundary keeps us from matching e.g.
  //    `.article-body-related` when we want `.article-body`.
  const classRe =
    /<div\b[^>]+class=["'][^"']*\b(?:article__body|articlebodycontent|entry-content|article-body|story-body|prose)\b[^"']*["'][^>]*>/i;
  const classMatch = html.match(classRe);
  if (classMatch && classMatch.index !== undefined) {
    const start = classMatch.index + classMatch[0].length;
    const window = html.slice(start, start + BODY_WINDOW_BYTES);
    const text = extractParagraphs(window);
    if (text.length >= MIN_BODY_LEN) return text.slice(0, MAX_BODY_LEN);
  }

  // 6. og:description meta tag — small but reliable last resort.
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{50,})["']/i);
  if (og) return decodeEntities(og[1]!).slice(0, MAX_BODY_LEN);

  return null;
}

// ── Batch fetcher ─────────────────────────────────────────────────

/**
 * Fetch article bodies for the given items. Returns a `link → body`
 * map. Items missing from the map either failed to fetch, produced
 * no extractable body, or were skipped by the budget cap.
 *
 * Side effects: writes per-link cache entries (positive on success,
 * sentinel on extraction failure). Cache TTL distinguishes the two
 * so repeat-failures back off naturally.
 */
export async function fetchArticleBodyBatch(items: RawRssItem[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!isEnabled() || items.length === 0) return out;

  // Compute all cache keys in parallel (sha256 via SubtleCrypto is async).
  const hashes = await Promise.all(items.map((it) => sha256Hex(it.link)));
  const cacheKeys = hashes.map((h) => `${ARTICLE_CACHE_PREFIX}${h}`);

  // Batch GET — single HTTP round-trip vs N individual GETs.
  const cached = await getCachedJsonBatch(cacheKeys);

  // Split into "already known" vs "needs fetch"
  const toFetch: { item: RawRssItem; cacheKey: string }[] = [];
  let cacheHits = 0;
  for (let i = 0; i < items.length; i++) {
    const ckey = cacheKeys[i]!;
    const v = cached.get(ckey);
    if (typeof v === 'string') {
      if (v === NEG_SENTINEL) continue; // negative cache — skip this run
      out.set(items[i]!.link, v);
      cacheHits++;
    } else {
      toFetch.push({ item: items[i]!, cacheKey: ckey });
    }
  }

  if (toFetch.length === 0) {
    console.log(`[live-news:v6:article] all ${cacheHits}/${items.length} cache-hit, no fetches needed`);
    return out;
  }

  const startedAt = Date.now();
  let fetched = 0;
  let failed = 0;
  let budgetSkipped = 0;

  // Fixed-size worker pool sharing a cursor. Faster workers pick up
  // additional jobs while slower ones are still mid-fetch.
  let cursor = 0;
  const workerCount = Math.min(FETCH_CONCURRENCY, toFetch.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= toFetch.length) return;
        if (Date.now() - startedAt >= TOTAL_BUDGET_MS) {
          // Hit the wall-clock budget — leave remaining items for next
          // refresh (they'll be a cache miss → re-queued naturally).
          budgetSkipped++;
          continue;
        }

        const { item, cacheKey } = toFetch[i]!;
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
          const resp = await fetch(item.link, {
            signal: ctrl.signal,
            redirect: 'follow',
            headers: {
              'User-Agent': BROWSER_UA,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.8',
            },
          });
          clearTimeout(timer);

          if (!resp.ok) {
            failed++;
            await setCachedJson(cacheKey, NEG_SENTINEL, ARTICLE_NEG_TTL_S);
            continue;
          }

          const html = await resp.text();
          const body = extractArticleBody(html);
          if (body && body.length >= MIN_BODY_LEN) {
            out.set(item.link, body);
            fetched++;
            await setCachedJson(cacheKey, body, ARTICLE_TTL_S);
          } else {
            failed++;
            await setCachedJson(cacheKey, NEG_SENTINEL, ARTICLE_NEG_TTL_S);
          }
        } catch {
          // Transient (AbortError, network reset) — don't cache; next
          // refresh will retry. Counted as a failure for the log.
          failed++;
        }
      }
    }),
  );

  const elapsed = Date.now() - startedAt;
  console.log(
    `[live-news:v6:article] fetched=${fetched} failed=${failed} ` +
    `budget-skipped=${budgetSkipped} cache-hit=${cacheHits} ` +
    `of total=${items.length} candidates in ${elapsed}ms`,
  );

  return out;
}
