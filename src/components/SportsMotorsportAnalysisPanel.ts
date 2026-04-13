import type { Feed, NewsItem } from '@/types';
import { fetchCategoryFeeds } from '@/services';
import { fetchFormulaOneStandingsData, type FormulaOneStandingsData } from '@/services/sports';
import { rssProxyUrl } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import {
  SportsAnalysisPanelBase,
  countFreshAnalysisStories,
  dedupeNewsItems,
  normalizeLookup,
  renderAiBrief,
  renderAnalysisCards,
  renderAnalysisPoints,
  renderAnalysisStories,
  renderDistributionChips,
  formatUpdatedAt,
  type SportsAnalysisCard,
  type SportsAnalysisPoint,
  type SportsAnalysisStory,
} from './sportsAnalysisShared';

const MOTORSPORT_ANALYSIS_FEEDS: Feed[] = [
  { name: 'Formula1.com', url: rssProxyUrl('https://news.google.com/rss/search?q=site:formula1.com+Formula+1+when:3d&hl=en-US&gl=US&ceid=US:en') },
  { name: 'NASCAR', url: rssProxyUrl('https://news.google.com/rss/search?q=site:nascar.com+NASCAR+when:3d&hl=en-US&gl=US&ceid=US:en') },
  { name: 'WRC', url: rssProxyUrl('https://news.google.com/rss/search?q=(site:wrc.com+OR+\"World Rally Championship\")+when:3d&hl=en-US&gl=US&ceid=US:en') },
  { name: 'Motorsport.com', url: rssProxyUrl('https://news.google.com/rss/search?q=site:motorsport.com+(Formula+1+OR+NASCAR+OR+Rally)+when:3d&hl=en-US&gl=US&ceid=US:en') },
  { name: 'Racer', url: rssProxyUrl('https://news.google.com/rss/search?q=site:racer.com+(Formula+1+OR+NASCAR+OR+rally)+when:3d&hl=en-US&gl=US&ceid=US:en') },
];

const SERIES_KEYWORDS: Array<{ label: string; keywords: string[] }> = [
  { label: 'F1', keywords: ['formula 1', 'f1', 'grand prix', 'verstappen', 'ferrari', 'mercedes', 'mclaren'] },
  { label: 'NASCAR', keywords: ['nascar', 'cup series', 'daytona', 'talladega', 'hendrick', 'joe gibbs'] },
  { label: 'Rally', keywords: ['wrc', 'world rally championship', 'rally', 'safari rally', 'monte carlo', 'rallye'] },
];

type TaggedMotorsportStory = SportsAnalysisStory & {
  tag: string;
  series: string;
};

type MotorsportAnalysisState = {
  standings: FormulaOneStandingsData | null;
  stories: TaggedMotorsportStory[];
  cards: SportsAnalysisCard[];
  points: SportsAnalysisPoint[];
  seriesMix: Array<{ label: string; count: number }>;
  updatedAt: string;
};

function classifySeries(item: NewsItem): string {
  const normalized = normalizeLookup(`${item.source} ${item.title}`);
  const match = SERIES_KEYWORDS.find((entry) => entry.keywords.some((keyword) => normalized.includes(normalizeLookup(keyword))));
  return match?.label || 'Other';
}

function buildTaggedStories(items: NewsItem[]): TaggedMotorsportStory[] {
  const deduped = dedupeNewsItems(items);
  const tagged = deduped.map((item) => {
    const series = classifySeries(item);
    return {
      title: item.title,
      link: item.link,
      source: item.source,
      publishedAt: item.pubDate,
      series,
      tag: series,
    };
  });

  const matched = tagged.filter((story) => story.series !== 'Other');
  return (matched.length >= 6 ? matched : tagged).slice(0, 10);
}

function buildSeriesMix(stories: TaggedMotorsportStory[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const story of stories) {
    counts.set(story.series, (counts.get(story.series) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([label, count]) => ({ label, count }));
}

function buildCards(standings: FormulaOneStandingsData | null, stories: TaggedMotorsportStory[]): SportsAnalysisCard[] {
  const driverLeader = standings?.driverStandings[0];
  const nextRace = standings?.nextRace;
  const nascarCount = stories.filter((story) => story.series === 'NASCAR').length;
  const rallyCount = stories.filter((story) => story.series === 'Rally').length;
  const dominant = buildSeriesMix(stories)[0];

  const cards: SportsAnalysisCard[] = [];
  if (driverLeader) cards.push({ label: 'F1 Leader', value: driverLeader.name, detail: `${driverLeader.points} pts`, tone: 'sky' });
  if (nextRace) cards.push({ label: 'Next GP', value: nextRace.raceName, detail: nextRace.date, tone: 'emerald' });
  cards.push({ label: 'NASCAR Heat', value: `${nascarCount}`, detail: 'recent headlines', tone: 'amber' });
  cards.push({ label: 'Rally Heat', value: `${rallyCount}`, detail: 'recent headlines', tone: 'rose' });
  if (dominant) cards.push({ label: 'Story Focus', value: dominant.label, detail: `${dominant.count} recent headlines` });
  return cards;
}

function buildPoints(standings: FormulaOneStandingsData | null, stories: TaggedMotorsportStory[]): SportsAnalysisPoint[] {
  const seriesMix = buildSeriesMix(stories);
  const dominant = seriesMix[0];
  const driverLeader = standings?.driverStandings[0];
  const driverRunnerUp = standings?.driverStandings[1];
  const constructorLeader = standings?.constructorStandings[0];
  const nascarCount = stories.filter((story) => story.series === 'NASCAR').length;
  const rallyCount = stories.filter((story) => story.series === 'Rally').length;

  const points: SportsAnalysisPoint[] = [];
  if (dominant) {
    points.push({
      label: 'Series Mix',
      text: `${dominant.label} is carrying the biggest share of headline flow right now, so the live motorsport narrative is not evenly distributed across F1, NASCAR, and rally.`,
    });
  }
  if (driverLeader && driverRunnerUp) {
    points.push({
      label: 'F1 Control',
      text: `${driverLeader.name} leads the F1 drivers' table by ${driverLeader.points - driverRunnerUp.points} points, while ${constructorLeader?.name || 'the leading constructor'} is still setting the team benchmark.`,
    });
  }
  points.push({
    label: 'US Stock Car Tape',
    text: nascarCount > 0
      ? `NASCAR still has fresh signal in the story tape with ${nascarCount} recent headlines, which keeps the panel anchored beyond the European single-seater cycle.`
      : 'NASCAR coverage is quiet relative to F1 right now, so the current motorsport narrative is skewing away from U.S. stock-car developments.',
  });
  points.push({
    label: 'Rally Watch',
    text: rallyCount > 0
      ? `Rally coverage is active with ${rallyCount} recent headlines, which is enough to keep WRC storylines in the current cross-series read.`
      : 'Rally coverage is light at the moment, so the panel should be read as F1-led unless new WRC stories start clustering in the next cycle.',
  });

  return points.slice(0, 4);
}

function buildFallbackBrief(standings: FormulaOneStandingsData | null, stories: TaggedMotorsportStory[]): string {
  const dominant = buildSeriesMix(stories)[0];
  const driverLeader = standings?.driverStandings[0];
  const nextRace = standings?.nextRace;
  return `${driverLeader?.name || 'F1'} still anchors the live championship picture, ${nextRace?.raceName || 'the next GP'} is the next major F1 checkpoint, and headline flow is currently led by ${dominant?.label || 'a mixed motorsport slate'}.`;
}

function buildSummaryInputs(standings: FormulaOneStandingsData | null, stories: TaggedMotorsportStory[]): string[] {
  const driverLeader = standings?.driverStandings[0];
  const constructorLeader = standings?.constructorStandings[0];
  const nextRace = standings?.nextRace;
  const dominant = buildSeriesMix(stories)[0];
  const nascarCount = stories.filter((story) => story.series === 'NASCAR').length;
  const rallyCount = stories.filter((story) => story.series === 'Rally').length;

  return [
    ...stories.slice(0, 5).map((story) => story.title),
    driverLeader ? `F1 driver leader ${driverLeader.name} with ${driverLeader.points} points` : '',
    constructorLeader ? `F1 constructor leader ${constructorLeader.name} with ${constructorLeader.points} points` : '',
    nextRace ? `Next grand prix is ${nextRace.raceName}` : '',
    dominant ? `${dominant.label} is driving the biggest share of motorsport headlines` : '',
    `NASCAR headlines ${nascarCount}`,
    `Rally headlines ${rallyCount}`,
  ].filter(Boolean);
}

function renderRaceContext(standings: FormulaOneStandingsData | null): string {
  const lastRace = standings?.lastRace;
  const nextRace = standings?.nextRace;

  return `
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;">
      <article style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.02);display:grid;gap:6px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Last F1 Race</div>
        <div style="font-size:14px;font-weight:800;line-height:1.35;">${escapeHtml(lastRace?.raceName || 'No completed race yet')}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.58);">${escapeHtml(lastRace?.winner ? `Winner: ${lastRace.winner}` : 'Result feed unavailable')}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.44);">${escapeHtml(lastRace?.country || lastRace?.circuitName || 'Awaiting data')}</div>
      </article>
      <article style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.02);display:grid;gap:6px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Next F1 Race</div>
        <div style="font-size:14px;font-weight:800;line-height:1.35;">${escapeHtml(nextRace?.raceName || 'No scheduled GP available')}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.58);">${escapeHtml(nextRace?.date || 'Date TBD')}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.44);">${escapeHtml(nextRace?.country || nextRace?.circuitName || 'Awaiting data')}</div>
      </article>
    </section>
  `;
}

export class SportsMotorsportAnalysisPanel extends SportsAnalysisPanelBase<MotorsportAnalysisState> {
  constructor() {
    super({
      id: 'sports-motorsport-analysis',
      title: 'Motorsport AI',
      showCount: true,
      className: 'panel-wide',
      defaultRowSpan: 5,
      infoTooltip: 'AI motorsport analysis across Formula 1, NASCAR, and rally, blending the latest headline mix with live F1 championship context.',
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading('Loading motorsport analysis...');
    try {
      const [standings, rawStories] = await Promise.all([
        fetchFormulaOneStandingsData().catch(() => null),
        fetchCategoryFeeds(MOTORSPORT_ANALYSIS_FEEDS, { batchSize: 2 }),
      ]);

      const stories = buildTaggedStories(rawStories);
      if (!stories.length && !standings) {
        this.setCount(0);
        this.showError('Motorsport analysis is unavailable right now.', () => void this.fetchData());
        return false;
      }

      const freshCount = countFreshAnalysisStories(stories);

      this.data = {
        standings,
        stories,
        cards: buildCards(standings, stories),
        points: buildPoints(standings, stories),
        seriesMix: buildSeriesMix(stories),
        updatedAt: standings?.updatedAt || new Date().toISOString(),
      };
      this.fallbackBrief = buildFallbackBrief(standings, stories);
      this.setCount(stories.length);
      this.setNewBadge(freshCount, freshCount > 0);
      this.renderPanel();
      this.requestAiBrief(buildSummaryInputs(standings, stories));
      return true;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.setCount(0);
      this.showError('Failed to load motorsport analysis.', () => void this.fetchData());
      return false;
    }
  }

  protected renderPanel(): void {
    if (!this.data) {
      this.setContent('<div style="font-size:12px;color:rgba(255,255,255,0.60);line-height:1.6;">Loading motorsport analysis.</div>');
      return;
    }

    this.setContent(`
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        <section style="border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;background:linear-gradient(135deg, rgba(244,63,94,0.12), rgba(15,23,42,0.10));display:grid;gap:6px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(254,205,211,0.92);">Cross-Series Desk</div>
          <div style="font-size:20px;font-weight:800;line-height:1.2;">Formula 1, NASCAR, and rally narrative mix</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.62);">AI summary layered over F1 championship context and the latest multi-series motorsport story flow.</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.48);">Updated ${escapeHtml(formatUpdatedAt(this.data.updatedAt))}</div>
        </section>

        ${renderAiBrief(this.aiBrief, this.fallbackBrief, this.aiPending)}
        ${renderAnalysisCards(this.data.cards)}
        ${renderDistributionChips('Series Mix', this.data.seriesMix.map((entry) => ({ label: entry.label, value: `${entry.count} stories` })))}
        ${renderRaceContext(this.data.standings)}
        ${renderAnalysisPoints('What Stands Out', this.data.points)}
        ${renderAnalysisStories('Key Storylines', this.data.stories, 'No motorsport storylines are available right now.')}
      </div>
    `);
  }
}
