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

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { SignalModal } from '@/components/SignalModal';
import type { CorrelationSignal } from '@/services/correlation';
import {
  drainTrendingSignals,
  ingestHeadlines,
  updateTrendingConfig,
} from '@/services/trending-keywords';

type SpikeData = CorrelationSignal['data'];

/**
 * `handleSpike` is async (it awaits term-significance scoring), so signals land
 * in the pending queue a tick or more after `ingestHeadlines` returns. Drain
 * repeatedly and keep everything seen — a bare `drainTrendingSignals()` splices
 * the queue, so a non-matching signal drained on an early pass would be lost.
 */
async function drainSpikesUntil(term: RegExp): Promise<CorrelationSignal[]> {
  const seen: CorrelationSignal[] = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    seen.push(...drainTrendingSignals());
    const match = seen.find(
      signal =>
        signal.type === 'keyword_spike' &&
        term.test(String((signal.data as SpikeData).term ?? '')),
    );
    if (match) return seen;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(
    `[keyword-spike] no keyword_spike matching ${term} was emitted; saw ${JSON.stringify(seen.map(s => (s.data as SpikeData).term))}`,
  );
}

async function drainSpikeFor(term: RegExp): Promise<CorrelationSignal> {
  const seen = await drainSpikesUntil(term);
  return seen.find(
    signal =>
      signal.type === 'keyword_spike' &&
      term.test(String((signal.data as SpikeData).term ?? '')),
  )!;
}

function spikeTermsIn(signals: CorrelationSignal[], term: RegExp): string[] {
  return signals
    .filter(signal => signal.type === 'keyword_spike')
    .map(signal => String((signal.data as SpikeData).term ?? ''))
    .filter(value => term.test(value));
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

describe('keyword_spike re-spike evidence breaks publication-time ties by arrival', () => {
  it('shows later arrivals first after the cooldown when publication times match', async () => {
    await initTestI18n();
    updateTrendingConfig({
      blockedTerms: [],
      minSpikeCount: 5,
      spikeMultiplier: 3,
      autoSummarize: false,
    });

    const firstIngestAt = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(firstIngestAt);
    const sharedPubDate = new Date(firstIngestAt - 60_000);
    const originalHeadlines = [
      { source: 'Reuters', title: 'Talks resume as Solmira delegates arrive' },
      { source: 'AP', title: 'Markets watch Solmira summit opening' },
      { source: 'BBC', title: 'Officials outline Solmira summit agenda' },
      { source: 'Reuters', title: 'Regional leaders join Solmira negotiations' },
      { source: 'AP', title: 'Observers assess Solmira policy proposals' },
      { source: 'BBC', title: 'Delegations prepare Solmira joint statement' },
    ];
    const laterHeadlines = [
      { source: 'Reuters', title: 'Fresh terms reshape Solmira summit talks' },
      { source: 'AP', title: 'New warning changes Solmira negotiation' },
    ];

    try {
      ingestHeadlines(originalHeadlines.map(headline => ({ ...headline, pubDate: sharedPubDate })));
      await drainSpikeFor(/solmira/i);

      // The rolling evidence window is two hours and the alert cooldown is 30
      // minutes. The old and new stories deliberately share one publication
      // time, as feeds with coarse timestamps can do.
      dateNow.mockReturnValue(firstIngestAt + 31 * 60_000);
      ingestHeadlines(laterHeadlines.map(headline => ({ ...headline, pubDate: sharedPubDate })));

      const secondSignal = await drainSpikeFor(/solmira/i);
      const titles = (dataOf(secondSignal).articles ?? []).map(article => article.title);
      expect(titles.slice(0, laterHeadlines.length)).toEqual(
        laterHeadlines.map(headline => headline.title),
      );
      expect(titles).not.toContain(originalHeadlines[originalHeadlines.length - 1]!.title);
      expect(titles).not.toContain(originalHeadlines[originalHeadlines.length - 2]!.title);
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe('keyword_spike evidence ranks only real publication dates', () => {
  it('does not let a missing-date article displace six dated articles from the evidence cap', async () => {
    await initTestI18n();
    updateTrendingConfig({
      blockedTerms: [],
      minSpikeCount: 5,
      spikeMultiplier: 3,
      autoSummarize: false,
    });

    const now = Date.now();
    const datedHeadlines = [
      { source: 'Reuters', title: 'Aurelith summit opens after regional talks', link: 'https://example.com/aurelith/1' },
      { source: 'AP', title: 'Delegates reach Aurelith summit venue', link: 'https://example.com/aurelith/2' },
      { source: 'BBC', title: 'Aurelith summit agenda focuses on trade', link: 'https://example.com/aurelith/3' },
      { source: 'Reuters', title: 'Leaders address Aurelith summit session', link: 'https://example.com/aurelith/4' },
      { source: 'AP', title: 'Aurelith summit enters final negotiations', link: 'https://example.com/aurelith/5' },
      { source: 'BBC', title: 'Aurelith summit prepares joint statement', link: 'https://example.com/aurelith/6' },
    ];

    ingestHeadlines([
      ...datedHeadlines.map((item, index) => ({
        ...item,
        pubDate: new Date(now - (datedHeadlines.length - index) * 60_000),
      })),
      {
        source: 'Undated Wire',
        title: 'Aurelith summit item arrives without publication date',
        link: 'https://example.com/aurelith/missing',
        pubDate: new Date(now),
        pubDateMissing: true,
      },
    ]);

    const signal = await drainSpikeFor(/aurelith/i);
    const articles = dataOf(signal).articles ?? [];
    expect(articles.map(article => article.title)).toEqual(
      datedHeadlines.map(headline => headline.title).reverse(),
    );
    expect(articles.every(article => Number.isFinite(article.publishedAt) && article.publishedAt! > 0)).toBe(true);
  });

  it('puts invalid-date evidence last and omits its publication timestamp', async () => {
    await initTestI18n();
    updateTrendingConfig({
      blockedTerms: [],
      minSpikeCount: 5,
      spikeMultiplier: 3,
      autoSummarize: false,
    });

    const now = Date.now();
    const datedHeadlines = [
      { source: 'Reuters', title: 'Belvarin forum opens with policy talks' },
      { source: 'AP', title: 'Delegates arrive for Belvarin forum session' },
      { source: 'BBC', title: 'Belvarin forum reviews regional proposal' },
      { source: 'Reuters', title: 'Officials address Belvarin forum delegates' },
      { source: 'AP', title: 'Belvarin forum prepares closing statement' },
    ];
    const invalidTitle = 'Belvarin forum item has malformed feed date';

    ingestHeadlines([
      ...datedHeadlines.map((item, index) => ({
        ...item,
        pubDate: new Date(now - (datedHeadlines.length - index) * 60_000),
      })),
      { source: 'Malformed Wire', title: invalidTitle, pubDate: new Date(Number.NaN) },
    ]);

    const signal = await drainSpikeFor(/belvarin/i);
    const articles = dataOf(signal).articles ?? [];
    const lastArticle = articles[articles.length - 1];
    expect(lastArticle?.title).toBe(invalidTitle);
    expect(lastArticle).not.toHaveProperty('publishedAt');
    expect(articles.slice(0, -1).every(article => Number.isFinite(article.publishedAt) && article.publishedAt! > 0)).toBe(true);
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

  // #6428: "mentioned in N different news sources" is a corroboration claim.
  // headline.source is a FEED LABEL and one newsroom ships many, so a
  // label-keyed count let a single publisher raise the alert on its own.
  it('counts one publisher once across its own feed labels', async () => {
    await initTestI18n();
    updateTrendingConfig({
      blockedTerms: [],
      minSpikeCount: 5,
      spikeMultiplier: 3,
      autoSummarize: false,
    });
    const pubDate = new Date();
    // Kelmarq arrives on five Reuters DESKS — one publisher wearing five feed
    // labels — so the gate must reject it. Tessaline is the positive control in
    // the SAME batch: same shape, same count, but three genuinely distinct
    // publishers, so it must spike.
    //
    // The control is what makes Kelmarq's absence provable. Both terms are
    // decided by the one synchronous checkForSpikes() pass inside
    // ingestHeadlines, so the moment the control's signal lands, that pass has
    // demonstrably run and Kelmarq's silence is a verdict rather than a race.
    //
    // Waiting a fixed period instead — which is what this test used to do, by
    // letting an 80 x 25ms poll run to exhaustion — cannot distinguish "the
    // gate rejected it" from "the pipeline had not got to it yet", so it would
    // stay green if ingest broke entirely. It also cost a guaranteed 2000ms
    // against a 15000ms budget, making it the slowest test in the DOM suite and
    // the next one to fail under load (#6677).
    ingestHeadlines([
      { source: 'Reuters World', title: 'Ports brace for Kelmarq tariff review', link: 'https://example.com/k/1' },
      { source: 'Reuters US', title: 'Growers protest Kelmarq tariff schedule', link: 'https://example.com/k/2' },
      { source: 'Reuters Business', title: 'Retailers model Kelmarq tariff costs', link: 'https://example.com/k/3' },
      { source: 'Reuters Asia', title: 'Analysts weigh Kelmarq tariff fallout', link: 'https://example.com/k/4' },
      { source: 'Reuters Energy', title: 'Traders watch Kelmarq tariff deadline', link: 'https://example.com/k/5' },
      { source: 'Reuters', title: 'Ports brace for Tessaline levy review', link: 'https://example.com/t/1' },
      { source: 'AP', title: 'Growers protest Tessaline levy schedule', link: 'https://example.com/t/2' },
      { source: 'BBC', title: 'Retailers model Tessaline levy costs', link: 'https://example.com/t/3' },
      { source: 'AP', title: 'Analysts weigh Tessaline levy fallout', link: 'https://example.com/t/4' },
      { source: 'BBC', title: 'Traders watch Tessaline levy deadline', link: 'https://example.com/t/5' },
    ].map(item => ({ ...item, pubDate })));

    const seen = await drainSpikesUntil(/tessaline/i);

    expect(spikeTermsIn(seen, /kelmarq/i)).toEqual([]);
  });

  it('still counts genuinely independent publishers, and names them once each', async () => {
    await initTestI18n();
    updateTrendingConfig({
      blockedTerms: [],
      minSpikeCount: 5,
      spikeMultiplier: 3,
      autoSummarize: false,
    });
    const pubDate = new Date();
    ingestHeadlines([
      { source: 'Reuters World', title: 'Ports brace for Zorvane tariff review', link: 'https://example.com/z/1' },
      { source: 'Reuters US', title: 'Growers protest Zorvane tariff schedule', link: 'https://example.com/z/2' },
      { source: 'BBC World', title: 'Retailers model Zorvane tariff costs', link: 'https://example.com/z/3' },
      { source: 'BBC Africa', title: 'Analysts weigh Zorvane tariff fallout', link: 'https://example.com/z/4' },
      { source: 'Al Jazeera', title: 'Traders watch Zorvane tariff deadline', link: 'https://example.com/z/5' },
    ].map(item => ({ ...item, pubDate })));

    const signal = await drainSpikeFor(/zorvane/i);
    const data = dataOf(signal);
    // Two Reuters desks and two BBC editions collapse to their publishers, so
    // the count the user reads and the chips beside it are both three — the
    // #6414 invariant, now stated in publishers.
    expect([...(data.sourceNames ?? [])].sort()).toEqual(['Al Jazeera', 'BBC', 'Reuters']);
    expect(data.sourceCount).toBe(3);
  });

  it('does not let a blank source satisfy the minimum-source gate', async () => {
    await initTestI18n();
    updateTrendingConfig({
      blockedTerms: [],
      minSpikeCount: 5,
      spikeMultiplier: 3,
      autoSummarize: false,
    });
    const pubDate = new Date();
    ingestHeadlines([
      { source: 'Reuters', title: 'Ports brace for Norvexa tariff review' },
      { source: 'Reuters', title: 'Shippers rework Norvexa tariff routing' },
      { source: 'Reuters', title: 'Growers protest Norvexa tariff schedule' },
      { source: 'Reuters', title: 'Lawmakers question Norvexa tariff timing' },
      { source: '   ', title: 'Analysts weigh Norvexa tariff fallout' },
    ].map(item => ({ ...item, pubDate })));

    await new Promise(resolve => setTimeout(resolve, 50));
    const emitted = drainTrendingSignals().filter(
      candidate => /norvexa/i.test(String((candidate.data as SpikeData).term ?? '')),
    );
    expect(emitted).toHaveLength(0);
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
