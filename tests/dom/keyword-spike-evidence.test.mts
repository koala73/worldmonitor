/**
 * Keyword-spike alerts must carry — and show — the evidence they were built
 * from (#6414).
 *
 * A user reported an alert reading "Trump mentioned in 4 different news sources
 * 5 times in the last 2 hours" with no way to see which 4 sources or which
 * story. `handleSpike` holds the contributing headlines, their sources and
 * their URLs at emit time and used to keep only the counts, so the alert was
 * unreachable from the news it described.
 *
 * These tests run the REAL ingest -> spike -> signal pipeline (not a synthetic
 * payload) and then feed that same emitted signal into the REAL `SignalModal`,
 * so the emitter and the renderer cannot drift apart.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { SignalModal } from '@/components/SignalModal';
import type { CorrelationSignal } from '@/services/correlation';
import {
  drainTrendingSignals,
  ingestHeadlines,
  updateTrendingConfig,
} from '@/services/trending-keywords';

interface SpikeArticle {
  title: string;
  source: string;
  link?: string;
  publishedAt?: number;
}

interface SpikeData {
  term?: string;
  sourceCount?: number;
  sourceNames?: string[];
  articles?: SpikeArticle[];
  relatedTopics?: string[];
}

/**
 * `handleSpike` is async (it awaits term-significance scoring), so signals land
 * in the pending queue a tick or more after `ingestHeadlines` returns. Drain
 * repeatedly and keep everything seen — a bare `drainTrendingSignals()` splices
 * the queue, so a non-matching signal drained on an early pass would be lost.
 */
async function drainSpikeFor(term: RegExp): Promise<CorrelationSignal> {
  const seen: CorrelationSignal[] = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    seen.push(...drainTrendingSignals());
    const match = seen.find(
      signal =>
        signal.type === 'keyword_spike' &&
        term.test(String((signal.data as SpikeData).term ?? '')),
    );
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(
    `[keyword-spike] no keyword_spike matching ${term} was emitted; saw ${JSON.stringify(seen.map(s => (s.data as SpikeData).term))}`,
  );
}

function dataOf(signal: CorrelationSignal): SpikeData {
  return signal.data as SpikeData;
}

describe('keyword_spike signal payload carries its evidence', () => {
  // Eight headlines, four distinct sources, in ARRIVAL order — index 0 is the
  // oldest, exactly how a rolling window fills up in production. Two properties
  // are load-bearing:
  //
  //  - Bloomberg appears ONLY in the oldest pair, so it falls past the
  //    six-article cap. A `sourceNames` derived from the truncated article list
  //    would report three sources while `sourceCount` reported four — the
  //    disagreement the payload must make impossible.
  //  - The newest six and the first six are DISJOINT source sets, so taking the
  //    head of the array instead of the newest six is observable. Ingesting
  //    newest-first here would make the two indistinguishable and the recency
  //    assertion below would hold no matter what the emitter did.
  const HEADLINES = [
    { source: 'Bloomberg', title: 'Funds watch Zephyria sanctions deadline', link: 'https://example.com/bloomberg/1' },
    { source: 'Bloomberg', title: 'Traders weigh Zephyria sanctions fallout', link: 'https://example.com/bloomberg/2' },
    { source: 'Reuters', title: 'Pressure rises as Zephyria sanctions debate grows', link: 'https://example.com/reuters/1' },
    { source: 'Reuters', title: 'Regional response to Zephyria sanctions package', link: 'https://example.com/reuters/2' },
    { source: 'AP', title: 'Washington intensifies Zephyria sanctions push', link: 'https://example.com/ap/1' },
    { source: 'AP', title: 'New momentum behind Zephyria sanctions proposal', link: 'https://example.com/ap/2' },
    { source: 'BBC', title: 'Fresh concerns over Zephyria sanctions impact', link: 'https://example.com/bbc/1' },
    { source: 'BBC', title: 'Timeline shortens for Zephyria sanctions after warnings', link: 'https://example.com/bbc/2' },
  ];
  // The six newest, newest first — what the emitter must select.
  const NEWEST_SIX_TITLES = HEADLINES.slice(2).reverse().map(headline => headline.title);

  let signal: CorrelationSignal;

  beforeAll(async () => {
    await initTestI18n();
    updateTrendingConfig({
      blockedTerms: [],
      minSpikeCount: 5,
      spikeMultiplier: 3,
      autoSummarize: false,
    });
    const now = Date.now();
    ingestHeadlines(
      // One minute apart, ascending: index 0 is the OLDEST story.
      HEADLINES.map((item, index) => ({
        ...item,
        pubDate: new Date(now - (HEADLINES.length - 1 - index) * 60_000),
      })),
    );
    signal = await drainSpikeFor(/zephyria/i);
  });

  it('emits the contributing articles with title, source and link', () => {
    const articles = dataOf(signal).articles ?? [];
    expect(articles.length).toBeGreaterThan(0);
    for (const article of articles) {
      expect(typeof article.title).toBe('string');
      expect(article.title.length).toBeGreaterThan(0);
      expect(article.source).toBeTruthy();
      expect(article.link).toBeTruthy();
      const origin = HEADLINES.find(h => h.title === article.title);
      expect(origin, `article "${article.title}" was not one of the ingested headlines`).toBeTruthy();
      expect(article.source).toBe(origin!.source);
      expect(article.link).toBe(origin!.link);
    }
  });

  it('bounds the article list so the payload cannot grow with the spike', () => {
    // Eight headlines in, six out: the cap is a fixed bound, not a copy.
    expect(dataOf(signal).articles).toHaveLength(6);
  });

  it('names every distinct source behind sourceCount, including ones past the cap', () => {
    const data = dataOf(signal);
    const names = data.sourceNames ?? [];
    expect([...names].sort()).toEqual(['AP', 'BBC', 'Bloomberg', 'Reuters']);
    // The count and the names are the same fact; they must not be able to disagree.
    expect(data.sourceCount).toBe(names.length);
    // Proves the names came from the full headline set, not the capped articles.
    const cappedSources = new Set((data.articles ?? []).map(article => article.source));
    expect(cappedSources.size).toBeLessThan(names.length);
  });

  it('keeps the NEWEST articles when it caps, not the oldest', () => {
    // The rolling window is 2h but the per-term cooldown is 30 minutes, so
    // capping the head of the arrival-ordered array would re-serve the same six
    // up-to-2h-old headlines on every re-spike, under a title reporting a
    // higher count — a "new" alert whose evidence never changes.
    const titles = (dataOf(signal).articles ?? []).map(article => article.title);
    expect(titles).toEqual(NEWEST_SIX_TITLES);
    // The two oldest — the ones a head-of-array cap would have kept.
    expect(titles).not.toContain(HEADLINES[0]!.title);
    expect(titles).not.toContain(HEADLINES[1]!.title);
  });

  it('orders the articles newest first', () => {
    const stamps = (dataOf(signal).articles ?? []).map(article => article.publishedAt ?? 0);
    expect(stamps.length).toBeGreaterThan(1);
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
  });

  it('carries each article publication time', () => {
    // docs/algorithms.mdx advertises publication time as part of the payload.
    const articles = dataOf(signal).articles ?? [];
    expect(articles.length).toBeGreaterThan(0);
    for (const article of articles) {
      expect(typeof article.publishedAt).toBe('number');
      expect(article.publishedAt).toBeGreaterThan(0);
    }
  });

  it('does not echo the search term back as a related topic', () => {
    // `relatedTopics: [spike.term]` rendered a chip reading the term the user
    // was already looking at, which carried no information.
    expect(dataOf(signal).relatedTopics ?? []).not.toContain(dataOf(signal).term);
  });
});

describe('keyword_spike modal renders the evidence', () => {
  let signal: CorrelationSignal;
  let modal: SignalModal;
  let root: HTMLElement;

  beforeAll(async () => {
    await initTestI18n();
    updateTrendingConfig({
      blockedTerms: [],
      minSpikeCount: 5,
      spikeMultiplier: 3,
      autoSummarize: false,
    });
    const pubDate = new Date();
    ingestHeadlines([
      { source: 'Reuters', title: 'Ports brace as Kelverin tariff review lands', link: 'https://example.com/kelverin/reuters-1' },
      { source: 'Reuters', title: 'Shippers rework Kelverin tariff routing', link: 'https://example.com/kelverin/reuters-2' },
      { source: 'AP', title: 'Growers protest Kelverin tariff schedule', link: 'https://example.com/kelverin/ap-1' },
      { source: 'AP', title: 'Lawmakers question Kelverin tariff timing', link: 'https://example.com/kelverin/ap-2' },
      { source: 'BBC', title: 'Retailers model Kelverin tariff costs', link: 'https://example.com/kelverin/bbc-1' },
    ].map(item => ({ ...item, pubDate })));
    signal = await drainSpikeFor(/kelverin/i);

    modal = new SignalModal();
    modal.showSignal(signal);
    root = modal.getElement();
  });

  it('renders one link per contributing article, pointing at the article', () => {
    const articles = dataOf(signal).articles ?? [];
    expect(articles.length).toBeGreaterThan(0);

    const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>('.signal-article-item a'));
    expect(anchors).toHaveLength(articles.length);
    expect(anchors.map(a => a.getAttribute('href'))).toEqual(articles.map(article => article.link));
  });

  it('labels each link with the source it came from', () => {
    const articles = dataOf(signal).articles ?? [];
    const labels = Array.from(root.querySelectorAll('.signal-article-item .news-source')).map(
      node => node.textContent?.trim(),
    );
    // Guard the comparison: with no articles rendered both sides are `[]` and
    // the assertion would hold on a modal that shows nothing at all.
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).toEqual(articles.map(article => article.source));
  });

  it('opens article links in a new tab without handing over the opener', () => {
    const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>('.signal-article-item a'));
    // Without this the loop below has nothing to iterate and passes vacuously.
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(anchor.getAttribute('target')).toBe('_blank');
      expect(anchor.getAttribute('rel') ?? '').toContain('noopener');
    }
  });

  it('names the sources behind the count', () => {
    const names = dataOf(signal).sourceNames ?? [];
    expect(names.length).toBeGreaterThan(0);
    const chips = Array.from(root.querySelectorAll('.signal-source-chip')).map(
      node => node.textContent?.trim(),
    );
    expect(chips).toEqual(names);
  });

  it('labels the source list with real copy, not the raw i18n key', () => {
    // `t()` returns the key itself on a miss, so a renamed or unmirrored key
    // would ship the literal "header.sources" to users with the suite green.
    const label = root.querySelector('.signal-sources-label')?.textContent?.trim();
    expect(label).toBe('SOURCES');
  });

  it('keeps the suppress action working alongside the new evidence markup', () => {
    const button = root.querySelector<HTMLButtonElement>('.suppress-keyword-btn');
    expect(button).toBeTruthy();
    expect(button?.dataset.term).toBe(dataOf(signal).term);

    // The suppress handler re-renders from `currentSignals`, which is the same
    // template the evidence block was inserted into — clicking it must clear
    // the signal rather than throw or leave the evidence orphaned.
    button!.click();
    expect(root.querySelectorAll('.signal-item')).toHaveLength(0);
    expect(root.querySelectorAll('.signal-article-item')).toHaveLength(0);
  });
});

describe('keyword_spike payload excludes unusable source names from the count', () => {
  it('does not count a blank source it could never name', async () => {
    await initTestI18n();
    updateTrendingConfig({
      blockedTerms: [],
      minSpikeCount: 5,
      spikeMultiplier: 3,
      autoSummarize: false,
    });
    const pubDate = new Date();
    ingestHeadlines([
      { source: 'Reuters', title: 'Ports brace for Vandrelo tariff review', link: 'https://example.com/v/1' },
      { source: 'AP', title: 'Growers protest Vandrelo tariff schedule', link: 'https://example.com/v/2' },
      { source: 'BBC', title: 'Retailers model Vandrelo tariff costs', link: 'https://example.com/v/3' },
      { source: '   ', title: 'Analysts weigh Vandrelo tariff fallout', link: 'https://example.com/v/4' },
      { source: '', title: 'Traders watch Vandrelo tariff deadline', link: 'https://example.com/v/5' },
    ].map(item => ({ ...item, pubDate })));

    const signal = await drainSpikeFor(/vandrelo/i);
    const data = dataOf(signal);
    // The renderer drops blank chips, so counting them at the emitter would let
    // the alert claim five sources while the modal could only show three.
    expect([...(data.sourceNames ?? [])].sort()).toEqual(['AP', 'BBC', 'Reuters']);
    expect(data.sourceCount).toBe(3);
  });
});

describe('keyword_spike modal refuses to render a hostile or missing link', () => {
  let modal: SignalModal;
  let root: HTMLElement;

  const signal = {
    id: 'test-hostile',
    type: 'keyword_spike',
    title: 'Hostile link probe',
    description: 'probe',
    confidence: 0.5,
    timestamp: new Date(),
    data: {
      term: 'Probeterm',
      sourceCount: 3,
      sourceNames: ['Reuters', 'AP', 'BBC'],
      articles: [
        { title: 'Safe story', source: 'Reuters', link: 'https://example.com/safe' },
        { title: 'Script story', source: 'AP', link: 'javascript:alert(1)' },
        { title: 'Linkless story', source: 'BBC', link: '' },
      ],
    },
  } as unknown as CorrelationSignal;

  beforeAll(async () => {
    await initTestI18n();
    modal = new SignalModal();
    modal.showSignal(signal);
    root = modal.getElement();
  });

  it('drops the javascript: URL instead of rendering it as a link', () => {
    const hrefs = Array.from(root.querySelectorAll<HTMLAnchorElement>('.signal-article-item a')).map(
      anchor => anchor.getAttribute('href'),
    );
    expect(hrefs).toEqual(['https://example.com/safe']);
    expect(root.innerHTML).not.toContain('javascript:');
  });

  it('still shows a headline that has no usable URL, as plain text', () => {
    const titles = Array.from(root.querySelectorAll('.signal-article-item .news-title')).map(
      node => node.textContent?.trim(),
    );
    expect(titles).toEqual(['Safe story', 'Script story', 'Linkless story']);
  });
});

/**
 * Article titles, source labels and links are third-party RSS text reaching an
 * HTML sink. These lock the escaping in place: each assertion here goes red if
 * the corresponding `escapeHtml` / `sanitizeUrl` call is removed.
 */
describe('keyword_spike modal neutralises hostile feed text', () => {
  let root: HTMLElement;

  beforeAll(async () => {
    await initTestI18n();
    const modal = new SignalModal();
    modal.showSignal({
      id: 'test-escaping',
      type: 'keyword_spike',
      title: 'Escaping probe',
      description: 'probe',
      confidence: 0.5,
      timestamp: new Date(),
      data: {
        term: 'Probeterm',
        sourceCount: 1,
        sourceNames: ['<img src=x onerror=alert(1)>'],
        articles: [
          {
            title: '<script>alert("title")</script>',
            source: '<script>alert("source")</script>',
            // An ALLOWED https URL carrying a double quote: if sanitizeUrl stopped
            // attribute-escaping, this would break out of the href attribute.
            link: 'https://example.com/a?q=" onmouseover="alert(1)',
          },
        ],
      },
    } as unknown as CorrelationSignal);
    root = modal.getElement();
  });

  it('renders hostile title and source as inert text, never as markup', () => {
    expect(root.querySelector('.signal-article-item script')).toBeNull();
    expect(root.querySelector('.signal-source-chip img')).toBeNull();
    expect(root.querySelector('.signal-article-item .news-title')?.textContent).toBe(
      '<script>alert("title")</script>',
    );
    expect(root.querySelector('.signal-article-item .news-source')?.textContent).toBe(
      '<script>alert("source")</script>',
    );
    expect(root.querySelector('.signal-source-chip')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });

  it('does not let a quote inside an allowed URL escape the href attribute', () => {
    const anchor = root.querySelector<HTMLAnchorElement>('.signal-article-item a');
    expect(anchor).toBeTruthy();
    expect(anchor?.getAttribute('onmouseover')).toBeNull();
    expect(anchor?.getAttribute('href') ?? '').not.toContain('" onmouseover');
  });
});

describe('keyword_spike modal bounds what an untrusted producer can render', () => {
  let root: HTMLElement;
  const SOURCE_COUNT = 40;
  const ARTICLE_COUNT = 30;

  beforeAll(async () => {
    await initTestI18n();
    const modal = new SignalModal();
    modal.showSignal({
      id: 'test-oversized',
      type: 'keyword_spike',
      title: 'Oversized probe',
      description: 'probe',
      confidence: 0.5,
      timestamp: new Date(),
      data: {
        term: 'Probeterm',
        sourceCount: SOURCE_COUNT,
        sourceNames: Array.from({ length: SOURCE_COUNT }, (_, i) => `Source ${i}`),
        articles: Array.from({ length: ARTICLE_COUNT }, (_, i) => ({
          title: `Story ${i}`,
          source: `Source ${i}`,
          link: `https://example.com/${i}`,
        })),
      },
    } as unknown as CorrelationSignal);
    root = modal.getElement();
  });

  it('caps the rendered rows well below what the payload claims', () => {
    expect(root.querySelectorAll('.signal-article-item').length).toBeLessThan(ARTICLE_COUNT);
    expect(root.querySelectorAll('.signal-article-item').length).toBeGreaterThan(0);
  });

  it('accounts for the chips it did not render instead of dropping them silently', () => {
    const chips = Array.from(root.querySelectorAll('.signal-source-chip'));
    const overflow = root.querySelector('.signal-source-chip-more');
    expect(chips.length).toBeLessThan(SOURCE_COUNT);
    expect(overflow).toBeTruthy();
    // shown chips (excluding the counter) + the counter's own number == the total
    const shown = chips.length - 1;
    expect(overflow?.textContent?.trim()).toBe(`+${SOURCE_COUNT - shown}`);
  });
});

describe('keyword_spike modal tolerates a signal without evidence', () => {
  function modalFor(data: Record<string, unknown>, type = 'keyword_spike'): HTMLElement {
    const modal = new SignalModal();
    modal.showSignal({
      id: `test-${type}-${JSON.stringify(data).length}`,
      type,
      title: 'No evidence probe',
      description: 'probe',
      confidence: 0.5,
      timestamp: new Date(),
      data,
    } as unknown as CorrelationSignal);
    return modal.getElement();
  }

  beforeAll(async () => {
    await initTestI18n();
  });

  it('renders no evidence block when the payload omits both fields', () => {
    // Reachable in production: the service worker can serve a cached
    // trending-keywords chunk that predates these fields against a fresh
    // SignalModal, and older in-memory signals from earlier in the session
    // carry the old shape.
    const root = modalFor({ term: 'Probeterm', sourceCount: 3 });
    expect(root.querySelector('.signal-sources')).toBeNull();
    expect(root.querySelector('.signal-articles')).toBeNull();
    // The rest of the alert still renders, suppress included.
    expect(root.querySelector('.signal-item')).toBeTruthy();
    expect(root.querySelector('.suppress-keyword-btn')).toBeTruthy();
  });

  it('ignores fields that are not arrays, and entries that are not articles', () => {
    const root = modalFor({
      term: 'Probeterm',
      sourceNames: 'Reuters',
      articles: { title: 'not an array' },
    });
    expect(root.querySelector('.signal-sources')).toBeNull();
    expect(root.querySelector('.signal-articles')).toBeNull();

    const withHoles = modalFor({
      term: 'Probeterm',
      sourceNames: ['Reuters', null, '', 'AP'],
      articles: [null, { source: 'AP' }, { title: 'Real story', source: 'AP', link: 'https://example.com/x' }],
    });
    expect(
      Array.from(withHoles.querySelectorAll('.signal-source-chip')).map(n => n.textContent),
    ).toEqual(['Reuters', 'AP']);
    expect(
      Array.from(withHoles.querySelectorAll('.signal-article-item .news-title')).map(n => n.textContent),
    ).toEqual(['Real story']);
  });

  it('renders no evidence block for a signal that is not a keyword spike', () => {
    const root = modalFor(
      {
        term: 'Probeterm',
        sourceNames: ['Reuters', 'AP'],
        articles: [{ title: 'Story', source: 'AP', link: 'https://example.com/y' }],
      },
      'convergence',
    );
    expect(root.querySelector('.signal-sources')).toBeNull();
    expect(root.querySelector('.signal-articles')).toBeNull();
  });
});
