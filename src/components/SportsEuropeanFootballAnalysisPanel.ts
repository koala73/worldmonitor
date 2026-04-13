import type { Feed, NewsItem } from '@/types';
import { fetchCategoryFeeds } from '@/services';
import { fetchEuropeanFootballTopLeagueTables, type SportsStandingRow, type SportsTableGroup } from '@/services/sports';
import { rssProxyUrl } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import { formatSportsForm, renderSportsTeamIdentity } from './sportsPanelShared';
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

const EURO_FOOTBALL_ANALYSIS_FEEDS: Feed[] = [
  { name: 'BBC Football', url: rssProxyUrl('https://feeds.bbci.co.uk/sport/football/rss.xml?edition=uk') },
  { name: 'ESPN Soccer', url: rssProxyUrl('https://www.espn.com/espn/rss/soccer/news') },
  { name: 'Guardian Football', url: rssProxyUrl('https://www.theguardian.com/football/rss') },
  { name: 'European Leagues', url: rssProxyUrl('https://news.google.com/rss/search?q=(\"Premier League\" OR \"La Liga\" OR Bundesliga OR \"Serie A\" OR \"Ligue 1\" OR Eredivisie OR \"Primeira Liga\")+when:2d&hl=en-US&gl=US&ceid=US:en') },
];

type LeagueSnapshot = {
  table: SportsTableGroup;
  leader: SportsStandingRow;
  runnerUp: SportsStandingRow | null;
  gap: number;
  bestForm: SportsStandingRow | null;
};

type TaggedFootballStory = SportsAnalysisStory & {
  tag: string;
  league?: string;
};

type FootballAnalysisState = {
  snapshots: LeagueSnapshot[];
  stories: TaggedFootballStory[];
  cards: SportsAnalysisCard[];
  points: SportsAnalysisPoint[];
  leagueMix: Array<{ label: string; count: number }>;
  updatedAt: string;
};

function buildFormScore(form?: string): number {
  return (form || '')
    .toUpperCase()
    .split('')
    .reduce((score, result) => {
      if (result === 'W') return score + 3;
      if (result === 'D') return score + 1;
      return score;
    }, 0);
}

function teamAliases(row: SportsStandingRow): string[] {
  const parts = row.team.split(/\s+/).filter(Boolean);
  const acronym = parts.length >= 2 ? parts.map((part) => part[0]).join('') : '';
  const aliases = [
    row.team,
    acronym,
    parts.slice(-1).join(' '),
    parts.slice(-2).join(' '),
  ];

  return [...new Set(aliases.map(normalizeLookup).filter((alias) => alias.length >= 2))];
}

function buildLeagueSnapshots(tables: SportsTableGroup[]): LeagueSnapshot[] {
  return tables
    .map((table) => {
      const leader = table.rows[0];
      if (!leader) return null;
      const runnerUp = table.rows[1] || null;
      const bestForm = [...table.rows]
        .filter((row) => !!row.form)
        .sort((a, b) => buildFormScore(b.form) - buildFormScore(a.form) || b.points - a.points)[0] || null;

      return {
        table,
        leader,
        runnerUp,
        gap: runnerUp ? Math.max(leader.points - runnerUp.points, 0) : 0,
        bestForm,
      } satisfies LeagueSnapshot;
    })
    .filter((snapshot): snapshot is LeagueSnapshot => !!snapshot);
}

function buildLeagueAliases(snapshot: LeagueSnapshot): string[] {
  const leagueNames = [
    snapshot.table.league.name,
    snapshot.table.league.shortName,
  ];
  const teamNames = snapshot.table.rows.slice(0, 8).flatMap((row) => teamAliases(row));
  return [...new Set([
    ...leagueNames.map(normalizeLookup),
    ...teamNames,
  ].filter((alias) => alias.length >= 2))];
}

function matchStoryToLeague(title: string, snapshots: LeagueSnapshot[]): LeagueSnapshot | null {
  const normalized = normalizeLookup(title);
  let best: { snapshot: LeagueSnapshot; score: number } | null = null;

  for (const snapshot of snapshots) {
    const aliases = buildLeagueAliases(snapshot);
    let score = 0;
    for (const alias of aliases) {
      if (!normalized.includes(alias)) continue;
      score = Math.max(score, alias === normalizeLookup(snapshot.table.league.name) ? 120 : alias === normalizeLookup(snapshot.table.league.shortName) ? 95 : 65);
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { snapshot, score };
    }
  }

  return best?.snapshot || null;
}

function buildTaggedStories(items: NewsItem[], snapshots: LeagueSnapshot[]): TaggedFootballStory[] {
  const deduped = dedupeNewsItems(items);
  const tagged = deduped.map((item) => {
    const match = matchStoryToLeague(item.title, snapshots);
    return {
      title: item.title,
      link: item.link,
      source: item.source,
      publishedAt: item.pubDate,
      league: match?.table.league.shortName || match?.table.league.name,
      tag: match?.table.league.shortName || 'Europe',
    };
  });

  const matched = tagged.filter((story) => story.league);
  return (matched.length >= 6 ? matched : tagged).slice(0, 10);
}

function buildLeagueMix(stories: TaggedFootballStory[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const story of stories) {
    counts.set(story.tag, (counts.get(story.tag) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));
}

function buildCards(snapshots: LeagueSnapshot[], stories: TaggedFootballStory[]): SportsAnalysisCard[] {
  const tightest = [...snapshots].sort((a, b) => a.gap - b.gap)[0];
  const biggestCushion = [...snapshots].sort((a, b) => b.gap - a.gap)[0];
  const hottest = [...snapshots]
    .filter((snapshot) => snapshot.bestForm)
    .sort((a, b) => buildFormScore(b.bestForm?.form) - buildFormScore(a.bestForm?.form))[0];
  const storyFocus = buildLeagueMix(stories)[0];

  const cards: SportsAnalysisCard[] = [];
  if (tightest) cards.push({ label: 'Tightest Race', value: `${tightest.gap} pts`, detail: tightest.table.league.shortName, tone: 'amber' });
  if (biggestCushion) cards.push({ label: 'Biggest Cushion', value: `${biggestCushion.gap} pts`, detail: biggestCushion.table.league.shortName, tone: 'sky' });
  if (hottest?.bestForm) cards.push({ label: 'Hottest Club', value: hottest.bestForm.team, detail: `${formatSportsForm(hottest.bestForm.form)} · ${hottest.table.league.shortName}`, tone: 'emerald' });
  if (storyFocus) cards.push({ label: 'Story Focus', value: storyFocus.label, detail: `${storyFocus.count} recent headlines`, tone: 'rose' });
  return cards;
}

function buildPoints(snapshots: LeagueSnapshot[], stories: TaggedFootballStory[]): SportsAnalysisPoint[] {
  const tightest = [...snapshots].sort((a, b) => a.gap - b.gap)[0];
  const biggestCushion = [...snapshots].sort((a, b) => b.gap - a.gap)[0];
  const hottest = [...snapshots]
    .filter((snapshot) => snapshot.bestForm)
    .sort((a, b) => buildFormScore(b.bestForm?.form) - buildFormScore(a.bestForm?.form))[0];
  const focus = buildLeagueMix(stories)[0];

  const points: SportsAnalysisPoint[] = [];
  if (tightest && tightest.runnerUp) {
    points.push({
      label: 'Title Pressure',
      text: `${tightest.table.league.name} is the sharpest title race in the pack, with ${tightest.leader.team} only ${tightest.gap} points clear of ${tightest.runnerUp.team}.`,
    });
  }
  if (biggestCushion && biggestCushion.runnerUp) {
    points.push({
      label: 'Control',
      text: `${biggestCushion.leader.team} has the most breathing room of the seven-league set, sitting ${biggestCushion.gap} points ahead in ${biggestCushion.table.league.name}.`,
    });
  }
  if (hottest?.bestForm) {
    points.push({
      label: 'Form',
      text: `${hottest.bestForm.team} owns the strongest recent form line at ${formatSportsForm(hottest.bestForm.form)}, which is the cleanest short-term signal in the title and Champions League races.`,
    });
  }
  if (focus) {
    points.push({
      label: 'Story Tape',
      text: `${focus.label} is absorbing the most recent headline flow, so the media narrative is leaning there even though the full top-seven picture remains spread across the table board.`,
    });
  }

  return points.slice(0, 4);
}

function buildFallbackBrief(snapshots: LeagueSnapshot[], stories: TaggedFootballStory[]): string {
  const tightest = [...snapshots].sort((a, b) => a.gap - b.gap)[0];
  const hottest = [...snapshots]
    .filter((snapshot) => snapshot.bestForm)
    .sort((a, b) => buildFormScore(b.bestForm?.form) - buildFormScore(a.bestForm?.form))[0];
  const focus = buildLeagueMix(stories)[0];
  return `${tightest?.table.league.shortName || 'The top-seven set'} has the tightest title pressure, ${hottest?.bestForm?.team || 'the hottest club'} is carrying the best recent form, and story flow is leaning toward ${focus?.label || 'Europe-wide themes'}.`;
}

function buildSummaryInputs(snapshots: LeagueSnapshot[], stories: TaggedFootballStory[]): string[] {
  const tightest = [...snapshots].sort((a, b) => a.gap - b.gap)[0];
  const biggestCushion = [...snapshots].sort((a, b) => b.gap - a.gap)[0];
  const hottest = [...snapshots]
    .filter((snapshot) => snapshot.bestForm)
    .sort((a, b) => buildFormScore(b.bestForm?.form) - buildFormScore(a.bestForm?.form))[0];
  const focus = buildLeagueMix(stories)[0];

  return [
    ...stories.slice(0, 5).map((story) => story.title),
    tightest ? `${tightest.table.league.name} is the tightest race at ${tightest.gap} points` : '',
    biggestCushion ? `${biggestCushion.leader.team} has the biggest cushion at ${biggestCushion.gap} points in ${biggestCushion.table.league.name}` : '',
    hottest?.bestForm ? `${hottest.bestForm.team} has the best recent form at ${formatSportsForm(hottest.bestForm.form)}` : '',
    focus ? `${focus.label} is driving the most football headlines` : '',
  ].filter(Boolean);
}

function renderLeagueBoard(snapshots: LeagueSnapshot[]): string {
  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Top 7 League Board</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.48);">Leader, gap, and hottest form</div>
      </div>
      <div style="overflow:auto;margin:0 -2px;padding:0 2px;">
        <table style="width:100%;border-collapse:collapse;min-width:760px;">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
              <th style="padding:0 8px 8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">League</th>
              <th style="padding:0 8px 8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Leader</th>
              <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Gap</th>
              <th style="padding:0 8px 8px;text-align:right;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Best Form</th>
            </tr>
          </thead>
          <tbody>
            ${snapshots.map((snapshot) => `
              <tr style="border-top:1px solid rgba(255,255,255,0.06);${snapshot.gap <= 3 ? 'background:rgba(251,191,36,0.05);' : ''}">
                <td style="padding:10px 8px;">
                  <div style="display:grid;gap:2px;">
                    <div style="font-size:12px;font-weight:700;color:#f8fafc;">${escapeHtml(snapshot.table.league.name)}</div>
                    <div style="font-size:10px;color:rgba(255,255,255,0.46);">${escapeHtml(snapshot.table.season || 'Current season')}</div>
                  </div>
                </td>
                <td style="padding:10px 8px;min-width:190px;">
                  ${renderSportsTeamIdentity(snapshot.leader.team, snapshot.leader.badge, { secondary: `${snapshot.leader.points} pts`, size: 24 })}
                </td>
                <td style="padding:10px 8px;text-align:center;font-size:12px;font-weight:800;color:#f8fafc;">${snapshot.runnerUp ? `${snapshot.gap} pts` : '—'}</td>
                <td style="padding:10px 8px;text-align:right;">
                  ${snapshot.bestForm ? `
                    <div style="display:grid;gap:2px;justify-items:end;">
                      <div style="font-size:12px;font-weight:700;color:#f8fafc;">${escapeHtml(snapshot.bestForm.team)}</div>
                      <div style="font-size:10px;color:rgba(255,255,255,0.46);">${escapeHtml(formatSportsForm(snapshot.bestForm.form))}</div>
                    </div>
                  ` : '<span style="font-size:11px;color:rgba(255,255,255,0.40);">—</span>'}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

export class SportsEuropeanFootballAnalysisPanel extends SportsAnalysisPanelBase<FootballAnalysisState> {
  constructor() {
    super({
      id: 'sports-football-analysis',
      title: 'European Football AI',
      showCount: true,
      className: 'panel-wide',
      defaultRowSpan: 5,
      infoTooltip: 'European football storylines across the top seven leagues, summarized with AI and anchored to live title-race tables.',
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading('Loading European football analysis...');
    try {
      const [tables, rawStories] = await Promise.all([
        fetchEuropeanFootballTopLeagueTables(),
        fetchCategoryFeeds(EURO_FOOTBALL_ANALYSIS_FEEDS, { batchSize: 2 }),
      ]);

      const snapshots = buildLeagueSnapshots(tables);
      if (!snapshots.length) {
        this.setCount(0);
        this.showError('European football analysis is unavailable right now.', () => void this.fetchData());
        return false;
      }

      const stories = buildTaggedStories(rawStories, snapshots);
      const freshCount = countFreshAnalysisStories(stories);
      const updatedAt = snapshots
        .map((snapshot) => snapshot.table.updatedAt)
        .filter((value): value is string => !!value)
        .sort()
        .reverse()[0] || new Date().toISOString();

      this.data = {
        snapshots,
        stories,
        cards: buildCards(snapshots, stories),
        points: buildPoints(snapshots, stories),
        leagueMix: buildLeagueMix(stories),
        updatedAt,
      };
      this.fallbackBrief = buildFallbackBrief(snapshots, stories);
      this.setCount(stories.length);
      this.setNewBadge(freshCount, freshCount > 0);
      this.renderPanel();
      this.requestAiBrief(buildSummaryInputs(snapshots, stories));
      return true;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.setCount(0);
      this.showError('Failed to load European football analysis.', () => void this.fetchData());
      return false;
    }
  }

  protected renderPanel(): void {
    if (!this.data) {
      this.setContent('<div style="font-size:12px;color:rgba(255,255,255,0.60);line-height:1.6;">Loading European football analysis.</div>');
      return;
    }

    this.setContent(`
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        <section style="border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;background:linear-gradient(135deg, rgba(34,197,94,0.12), rgba(15,23,42,0.10));display:grid;gap:6px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(187,247,208,0.88);">Top 7 League Desk</div>
          <div style="font-size:20px;font-weight:800;line-height:1.2;">European football title-race pressure and story flow</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.62);">AI summary stacked on top of live league-table context for the Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Eredivisie, and Primeira Liga.</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.48);">Updated ${escapeHtml(formatUpdatedAt(this.data.updatedAt))}</div>
        </section>

        ${renderAiBrief(this.aiBrief, this.fallbackBrief, this.aiPending)}
        ${renderAnalysisCards(this.data.cards)}
        ${renderDistributionChips('League Focus', this.data.leagueMix.map((entry) => ({ label: entry.label, value: `${entry.count} stories` })))}
        ${renderLeagueBoard(this.data.snapshots)}
        ${renderAnalysisPoints('What Stands Out', this.data.points)}
        ${renderAnalysisStories('Key Storylines', this.data.stories, 'No European football storylines are available right now.')}
      </div>
    `);
  }
}
