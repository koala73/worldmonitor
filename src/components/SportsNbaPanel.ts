import { Panel } from './Panel';
import { fetchNbaStandingsData, type NbaStandingRow, type NbaStandingsData, type NbaStandingsGroup } from '@/services/sports';
import { escapeHtml } from '@/utils/sanitize';
import { renderSportsTeamIdentity } from './sportsPanelShared';

type NbaCard = {
  label: string;
  value: string;
  detail?: string;
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

function formatUpdatedAt(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function buildCards(data: NbaStandingsData): NbaCard[] {
  const eastLeader = data.groups[0]?.rows[0];
  const westLeader = data.groups[1]?.rows[0];
  const allRows = data.groups.flatMap((group) => group.rows);
  const bestDiff = [...allRows].sort((a, b) => parseDifferential(b.differential) - parseDifferential(a.differential))[0];
  const hottest = [...allRows].sort((a, b) => parseStreakScore(b.streak) - parseStreakScore(a.streak))[0];
  const cards: NbaCard[] = [];

  if (eastLeader) {
    cards.push({ label: 'East Leader', value: eastLeader.team, detail: `${eastLeader.wins}-${eastLeader.losses}` });
  }
  if (westLeader) {
    cards.push({ label: 'West Leader', value: westLeader.team, detail: `${westLeader.wins}-${westLeader.losses}` });
  }
  if (bestDiff) {
    cards.push({ label: 'Best Diff', value: bestDiff.differential, detail: bestDiff.team });
  }
  if (hottest) {
    cards.push({ label: 'Hottest Streak', value: hottest.streak, detail: hottest.team });
  }

  return cards;
}

function renderCards(cards: NbaCard[]): string {
  return `
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;">
      ${cards.map((card) => `
        <article style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px;background:rgba(255,255,255,0.03);display:grid;gap:6px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.46);">${escapeHtml(card.label)}</div>
          <div style="font-size:15px;font-weight:800;line-height:1.25;">${escapeHtml(card.value)}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.54);">${escapeHtml(card.detail || '')}</div>
        </article>
      `).join('')}
    </section>
  `;
}

function renderStandingsRows(rows: NbaStandingRow[]): string {
  return rows.map((row) => `
    <tr style="border-top:1px solid rgba(255,255,255,0.06);${row.rank === 1 ? 'background:rgba(16,185,129,0.05);' : ''}">
      <td style="padding:10px 8px;font-size:12px;font-weight:700;color:#f8fafc;">${row.seed}</td>
      <td style="padding:10px 8px;min-width:190px;">
        <div style="display:grid;gap:4px;">
          ${renderSportsTeamIdentity(row.team, row.badge)}
          <div style="font-size:10px;color:rgba(255,255,255,0.46);letter-spacing:0.04em;text-transform:uppercase;">
            ${escapeHtml(row.abbreviation)}${row.clincher ? ` · ${escapeHtml(row.clincher.toUpperCase())}` : ''}
          </div>
        </div>
      </td>
      <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.76);">${row.wins}</td>
      <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.76);">${row.losses}</td>
      <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.76);">${escapeHtml(row.winPercent)}</td>
      <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.76);">${escapeHtml(row.gamesBehind)}</td>
      <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.76);">${escapeHtml(row.pointsFor)}</td>
      <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.76);">${escapeHtml(row.pointsAgainst)}</td>
      <td style="padding:10px 8px;text-align:center;font-size:12px;font-weight:700;color:#f8fafc;">${escapeHtml(row.differential)}</td>
      <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.76);">${escapeHtml(row.streak)}</td>
      <td style="padding:10px 8px;text-align:right;font-size:12px;color:rgba(255,255,255,0.76);">${escapeHtml(row.lastTen)}</td>
    </tr>
  `).join('');
}

function renderStandingsGroup(group: NbaStandingsGroup): string {
  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
        <div style="display:grid;gap:3px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(group.name)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.54);">${group.rows.length} teams</div>
        </div>
      </div>

      <div style="overflow:auto;margin:0 -2px;padding:0 2px;">
        <table style="width:100%;border-collapse:collapse;min-width:980px;">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
              <th style="padding:0 8px 8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Seed</th>
              <th style="padding:0 8px 8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Team</th>
              <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">W</th>
              <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">L</th>
              <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">PCT</th>
              <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">GB</th>
              <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">PPG</th>
              <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">OPP</th>
              <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">DIFF</th>
              <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">STRK</th>
              <th style="padding:0 8px 8px;text-align:right;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">L10</th>
            </tr>
          </thead>
          <tbody>
            ${renderStandingsRows(group.rows)}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

export class SportsNbaPanel extends Panel {
  private data: NbaStandingsData | null = null;

  constructor() {
    super({
      id: 'sports-nba',
      title: 'NBA Standings',
      showCount: true,
      className: 'panel-wide',
      defaultRowSpan: 4,
      infoTooltip: 'Live NBA conference standings and league metrics sourced from ESPN standings data.',
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading('Loading NBA standings...');
    try {
      const data = await fetchNbaStandingsData();
      if (!data) {
        this.setCount(0);
        this.showError('NBA standings are unavailable right now.', () => void this.fetchData());
        return false;
      }

      this.data = data;
      this.setCount(data.groups.reduce((sum, group) => sum + group.rows.length, 0));
      this.renderPanel();
      return true;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.setCount(0);
      this.showError('Failed to load NBA standings.', () => void this.fetchData());
      return false;
    }
  }

  private renderPanel(): void {
    if (!this.data) {
      this.setContent('<div style="font-size:12px;color:rgba(255,255,255,0.60);line-height:1.6;">Loading NBA standings.</div>');
      return;
    }

    const cards = buildCards(this.data);
    this.setContent(`
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));display:grid;gap:6px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">NBA</div>
          <div style="font-size:20px;font-weight:800;line-height:1.2;">${escapeHtml(this.data.seasonDisplay || this.data.leagueName)} Standings</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.56);">Full conference tables and league-level performance stats.</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.48);">Updated ${escapeHtml(formatUpdatedAt(this.data.updatedAt))}</div>
        </section>

        ${renderCards(cards)}
        ${this.data.groups.map((group) => renderStandingsGroup(group)).join('')}
      </div>
    `);
  }
}
