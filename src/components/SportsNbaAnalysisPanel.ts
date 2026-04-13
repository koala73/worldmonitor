import type { Feed, NewsItem } from '@/types';
import { fetchCategoryFeeds } from '@/services';
import { fetchNbaStandingsData, type NbaStandingRow, type NbaStandingsData } from '@/services/sports';
import { rssProxyUrl } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import { renderSportsTeamIdentity } from './sportsPanelShared';
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

const NBA_ANALYSIS_FEEDS: Feed[] = [
  { name: 'NBA.com', url: rssProxyUrl('https://news.google.com/rss/search?q=site:nba.com+NBA+when:3d&hl=en-US&gl=US&ceid=US:en') },
  { name: 'ESPN NBA', url: rssProxyUrl('https://news.google.com/rss/search?q=site:espn.com+NBA+-college+-fantasy+-%22transfer+portal%22+when:3d&hl=en-US&gl=US&ceid=US:en') },
  { name: 'The Athletic NBA', url: rssProxyUrl('https://news.google.com/rss/search?q=site:theathletic.com+NBA+-fantasy+-college+when:3d&hl=en-US&gl=US&ceid=US:en') },
  { name: 'Reuters NBA', url: rssProxyUrl('https://news.google.com/rss/search?q=site:reuters.com+NBA+when:3d&hl=en-US&gl=US&ceid=US:en') },
];

const NBA_THEME_KEYWORDS: Array<{ label: string; keywords: string[] }> = [
  { label: 'Playoffs', keywords: ['playoff', 'postseason', 'play-in', 'finals', 'conference finals'] },
  { label: 'Injuries', keywords: ['injury', 'injured', 'questionable', 'out for', 'returning', 'returns'] },
  { label: 'Trades', keywords: ['trade', 'extension', 'free agent', 'free agency', 'contract'] },
  { label: 'Awards', keywords: ['mvp', 'rookie of the year', 'all-nba', 'defensive player', 'coach of the year'] },
  { label: 'Coaching', keywords: ['coach', 'coaching', 'fired', 'hired'] },
];

type TaggedNbaStory = SportsAnalysisStory & {
  tag: string;
  team?: string;
  theme: string;
};

type NbaAnalysisState = {
  standings: NbaStandingsData;
  stories: TaggedNbaStory[];
  themeMix: Array<{ label: string; count: number }>;
  cards: SportsAnalysisCard[];
  points: SportsAnalysisPoint[];
  updatedAt: string;
};

function parseDifferential(value: string): number {
  const numeric = Number.parseFloat(value.replace(/^\+/, ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseStreakScore(value: string): number {
  const match = value.match(/^([WL])(\d+)$/i);
  if (!match) return 0;
  const [, side = '', count = '0'] = match;
  const magnitude = Number.parseInt(count, 10);
  return side.toUpperCase() === 'W' ? magnitude : -magnitude;
}

function parseGamesBehind(value: string): number {
  const numeric = Number.parseFloat(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
}

function buildTeamAliases(row: NbaStandingRow): string[] {
  const parts = row.team.split(/\s+/).filter(Boolean);
  const aliases = [
    row.team,
    row.abbreviation,
    parts.slice(-1).join(' '),
    parts.slice(-2).join(' '),
  ];

  return [...new Set(aliases.map(normalizeLookup).filter((alias) => alias.length >= 2))];
}

function findTeamMention(title: string, rows: NbaStandingRow[]): NbaStandingRow | null {
  const normalized = normalizeLookup(title);
  let best: { row: NbaStandingRow; score: number } | null = null;

  for (const row of rows) {
    for (const alias of buildTeamAliases(row)) {
      if (!alias || !normalized.includes(alias)) continue;
      const score = alias.length + (alias === normalizeLookup(row.team) ? 20 : 0);
      if (!best || score > best.score) {
        best = { row, score };
      }
    }
  }

  return best?.row || null;
}

function classifyTheme(title: string): string {
  const normalized = normalizeLookup(title);
  const match = NBA_THEME_KEYWORDS.find((entry) => entry.keywords.some((keyword) => normalized.includes(normalizeLookup(keyword))));
  return match?.label || 'General';
}

function buildTaggedStories(items: NewsItem[], standings: NbaStandingsData): TaggedNbaStory[] {
  const rows = standings.groups.flatMap((group) => group.rows);
  return items.slice(0, 8).map((item) => {
    const team = findTeamMention(item.title, rows);
    const theme = classifyTheme(item.title);
    return {
      title: item.title,
      link: item.link,
      source: item.source,
      publishedAt: item.pubDate,
      team: team?.team,
      theme,
      tag: team?.abbreviation || team?.team || theme,
    };
  });
}

function pickStoryFocus(stories: TaggedNbaStory[]): { value: string; detail: string } {
  const counts = new Map<string, number>();
  const detailByLabel = new Map<string, string>();

  for (const story of stories) {
    const label = story.team || story.theme;
    counts.set(label, (counts.get(label) || 0) + 1);
    if (!detailByLabel.has(label)) {
      detailByLabel.set(label, story.team ? 'team-led news flow' : 'theme-led story mix');
    }
  }

  const focus = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!focus) return { value: 'Balanced', detail: 'no dominant storyline yet' };
  return {
    value: focus[0],
    detail: `${focus[1]} recent headlines · ${detailByLabel.get(focus[0]) || 'story focus'}`,
  };
}

function buildThemeMix(stories: TaggedNbaStory[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const story of stories) {
    counts.set(story.theme, (counts.get(story.theme) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([label, count]) => ({ label, count }));
}

function buildCards(standings: NbaStandingsData, stories: TaggedNbaStory[]): SportsAnalysisCard[] {
  const eastLeader = standings.groups[0]?.rows[0];
  const westLeader = standings.groups[1]?.rows[0];
  const allRows = standings.groups.flatMap((group) => group.rows);
  const bestDiff = [...allRows].sort((a, b) => parseDifferential(b.differential) - parseDifferential(a.differential))[0];
  const hottest = [...allRows].sort((a, b) => parseStreakScore(b.streak) - parseStreakScore(a.streak))[0];
  const focus = pickStoryFocus(stories);

  const cards: SportsAnalysisCard[] = [];
  if (eastLeader) cards.push({ label: 'East Leader', value: eastLeader.team, detail: `${eastLeader.wins}-${eastLeader.losses}`, tone: 'sky' });
  if (westLeader) cards.push({ label: 'West Leader', value: westLeader.team, detail: `${westLeader.wins}-${westLeader.losses}`, tone: 'sky' });
  if (bestDiff) cards.push({ label: 'Best Diff', value: bestDiff.differential, detail: bestDiff.team, tone: 'emerald' });
  if (hottest) cards.push({ label: 'Hottest Streak', value: hottest.streak, detail: hottest.team, tone: 'amber' });
  cards.push({ label: 'Story Focus', value: focus.value, detail: focus.detail, tone: 'rose' });
  return cards;
}

function buildPoints(standings: NbaStandingsData, stories: TaggedNbaStory[]): SportsAnalysisPoint[] {
  const allRows = standings.groups.flatMap((group) => group.rows);
  const bestDiff = [...allRows].sort((a, b) => parseDifferential(b.differential) - parseDifferential(a.differential))[0];
  const hottest = [...allRows].sort((a, b) => parseStreakScore(b.streak) - parseStreakScore(a.streak))[0];
  const conferenceRace = standings.groups
    .map((group) => {
      const leader = group.rows[0];
      const runnerUp = group.rows[1];
      return leader && runnerUp
        ? { group: group.name, leader, runnerUp, gap: parseGamesBehind(runnerUp.gamesBehind) }
        : null;
    })
    .filter((entry): entry is { group: string; leader: NbaStandingRow; runnerUp: NbaStandingRow; gap: number } => !!entry)
    .sort((a, b) => a.gap - b.gap)[0];
  const focus = pickStoryFocus(stories);

  const points: SportsAnalysisPoint[] = [];
  if (conferenceRace) {
    points.push({
      label: 'Race Pressure',
      text: `${conferenceRace.group} is the tighter top-seed race right now, with ${conferenceRace.runnerUp.team} only ${conferenceRace.runnerUp.gamesBehind} games behind ${conferenceRace.leader.team}.`,
    });
  }
  if (bestDiff) {
    points.push({
      label: 'Two-Way Signal',
      text: `${bestDiff.team} owns the best point differential at ${bestDiff.differential}, which is usually the cleanest shorthand for lineup balance going into the stretch run.`,
    });
  }
  if (hottest) {
    points.push({
      label: 'Momentum',
      text: `${hottest.team} is carrying the strongest recent streak at ${hottest.streak}, so current headline flow should be read through real momentum instead of season-long priors alone.`,
    });
  }
  points.push({
    label: 'Story Tape',
    text: `${focus.value} is driving the loudest recent conversation, which means the media narrative is concentrating there even if the standings picture is broader than one club.`,
  });

  return points.slice(0, 4);
}

function buildFallbackBrief(standings: NbaStandingsData, stories: TaggedNbaStory[]): string {
  const eastLeader = standings.groups[0]?.rows[0];
  const westLeader = standings.groups[1]?.rows[0];
  const hottest = [...standings.groups.flatMap((group) => group.rows)].sort((a, b) => parseStreakScore(b.streak) - parseStreakScore(a.streak))[0];
  const focus = pickStoryFocus(stories);
  return `${eastLeader?.team || 'The East leader'} and ${westLeader?.team || 'the West leader'} still anchor the table, ${hottest?.team || 'the hottest team'} is carrying the strongest recent run, and headline flow is clustering around ${focus.value}.`;
}

function buildSummaryInputs(standings: NbaStandingsData, stories: TaggedNbaStory[]): string[] {
  const eastLeader = standings.groups[0]?.rows[0];
  const westLeader = standings.groups[1]?.rows[0];
  const bestDiff = [...standings.groups.flatMap((group) => group.rows)].sort((a, b) => parseDifferential(b.differential) - parseDifferential(a.differential))[0];
  const hottest = [...standings.groups.flatMap((group) => group.rows)].sort((a, b) => parseStreakScore(b.streak) - parseStreakScore(a.streak))[0];
  const focus = pickStoryFocus(stories);

  return [
    ...stories.slice(0, 5).map((story) => story.title),
    eastLeader ? `East leader ${eastLeader.team} at ${eastLeader.wins}-${eastLeader.losses}` : '',
    westLeader ? `West leader ${westLeader.team} at ${westLeader.wins}-${westLeader.losses}` : '',
    bestDiff ? `Best point differential belongs to ${bestDiff.team} at ${bestDiff.differential}` : '',
    hottest ? `Hottest streak belongs to ${hottest.team} at ${hottest.streak}` : '',
    `Recent story focus is ${focus.value}`,
  ].filter(Boolean);
}

function renderConferenceBoard(data: NbaStandingsData): string {
  return `
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px;">
      ${data.groups.map((group) => `
        <article style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(group.name)}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.48);">Top 3 seeds</div>
          </div>
          <div style="display:grid;gap:8px;">
            ${group.rows.slice(0, 3).map((row) => `
              <div style="display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 10px;border-radius:10px;background:${row.rank === 1 ? 'rgba(16,185,129,0.08)' : 'rgba(255,255,255,0.03)'};">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:999px;background:rgba(255,255,255,0.06);font-size:11px;font-weight:800;color:#f8fafc;">${row.seed}</span>
                ${renderSportsTeamIdentity(row.team, row.badge, { secondary: `${row.wins}-${row.losses} · ${row.streak}`, size: 24 })}
                <div style="text-align:right;">
                  <div style="font-size:12px;font-weight:800;color:#f8fafc;">${escapeHtml(row.gamesBehind)}</div>
                  <div style="font-size:10px;color:rgba(255,255,255,0.46);">GB</div>
                </div>
              </div>
            `).join('')}
          </div>
        </article>
      `).join('')}
    </section>
  `;
}

export class SportsNbaAnalysisPanel extends SportsAnalysisPanelBase<NbaAnalysisState> {
  constructor() {
    super({
      id: 'sports-nba-analysis',
      title: 'NBA AI Analysis',
      showCount: true,
      className: 'panel-wide',
      defaultRowSpan: 5,
      infoTooltip: 'NBA storylines summarized with AI, plus conference pressure, momentum, and media-focus signals from live standings and recent headlines.',
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading('Loading NBA analysis...');
    try {
      const [standings, rawStories] = await Promise.all([
        fetchNbaStandingsData(),
        fetchCategoryFeeds(NBA_ANALYSIS_FEEDS, { batchSize: 2 }),
      ]);

      if (!standings) {
        this.setCount(0);
        this.showError('NBA analysis is unavailable right now.', () => void this.fetchData());
        return false;
      }

      const stories = buildTaggedStories(dedupeNewsItems(rawStories), standings);
      const freshCount = countFreshAnalysisStories(stories);

      this.data = {
        standings,
        stories,
        themeMix: buildThemeMix(stories),
        cards: buildCards(standings, stories),
        points: buildPoints(standings, stories),
        updatedAt: standings.updatedAt,
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
      this.showError('Failed to load NBA analysis.', () => void this.fetchData());
      return false;
    }
  }

  protected renderPanel(): void {
    if (!this.data) {
      this.setContent('<div style="font-size:12px;color:rgba(255,255,255,0.60);line-height:1.6;">Loading NBA analysis.</div>');
      return;
    }

    this.setContent(`
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        <section style="border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;background:linear-gradient(135deg, rgba(59,130,246,0.14), rgba(15,23,42,0.10));display:grid;gap:6px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(191,219,254,0.88);">NBA Story Desk</div>
          <div style="font-size:20px;font-weight:800;line-height:1.2;">Conference pressure, momentum, and narrative flow</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.62);">AI summary layered on top of live conference tables and the latest league story mix.</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.48);">Updated ${escapeHtml(formatUpdatedAt(this.data.updatedAt))}</div>
        </section>

        ${renderAiBrief(this.aiBrief, this.fallbackBrief, this.aiPending)}
        ${renderAnalysisCards(this.data.cards)}
        ${renderDistributionChips('Theme Mix', this.data.themeMix.map((entry) => ({ label: entry.label, value: `${entry.count} stories` })))}
        ${renderConferenceBoard(this.data.standings)}
        ${renderAnalysisPoints('What Stands Out', this.data.points)}
        ${renderAnalysisStories('Key Storylines', this.data.stories, 'No NBA storylines are available right now.')}
      </div>
    `);
  }
}
