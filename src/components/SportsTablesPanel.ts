import { Panel } from './Panel';
import {
  fetchAllSportsLeagues,
  fetchLeagueCenterData,
  type SportsLeagueCenterData,
  type SportsLeagueOption,
  type SportsStandingRow,
  type SportsTableGroup,
} from '@/services/sports';
import { escapeHtml } from '@/utils/sanitize';
import { renderSportsTeamIdentity } from './sportsPanelShared';

const SPORTS_LEAGUE_ID_KEY = 'wm-sports-league-id';
const LEGACY_SPORTS_SEASON_KEY = 'wm-sports-league-season';

type LeagueStatCard = {
  label: string;
  value: string;
  detail?: string;
};

function loadStored(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function saveStored(key: string, value: string): void {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore persistence failures.
  }
}

function buildLeagueGroups(leagues: SportsLeagueOption[]): Array<[string, SportsLeagueOption[]]> {
  const grouped = new Map<string, SportsLeagueOption[]>();
  for (const league of leagues) {
    const sport = league.sport || 'Other';
    const bucket = grouped.get(sport) || [];
    bucket.push(league);
    grouped.set(sport, bucket);
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sport, options]) => [sport, options.sort((a, b) => a.name.localeCompare(b.name))]);
}

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

function formatForm(form?: string): string {
  const cleaned = (form || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 5);
  return cleaned || '—';
}

function formatUpdatedAt(value?: string): string {
  if (!value) return 'Live feed';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function buildSeasonLabel(data: SportsLeagueCenterData): string {
  return data.table?.season || data.league.currentSeason || data.selectedSeason || 'Current season';
}

function buildStatCards(data: SportsLeagueCenterData): LeagueStatCard[] {
  const rows = data.table?.rows || [];
  const leader = rows[0];
  if (!leader) return [];

  const runnerUp = rows[1];
  const totalPlayed = rows.reduce((sum, row) => sum + row.played, 0);
  const totalPoints = rows.reduce((sum, row) => sum + row.points, 0);
  const matchesLogged = Math.round(totalPlayed / 2);
  const leaderPace = leader.played > 0 ? (leader.points / leader.played).toFixed(2) : '0.00';
  const averagePoints = (totalPoints / rows.length).toFixed(1);
  const bestForm = rows
    .filter((row) => !!row.form)
    .sort((a, b) => buildFormScore(b.form) - buildFormScore(a.form) || b.points - a.points)[0];

  const cards: LeagueStatCard[] = [
    {
      label: 'Leader',
      value: leader.team,
      detail: `${leader.points} pts`,
    },
    {
      label: 'Gap',
      value: runnerUp ? `${Math.max(leader.points - runnerUp.points, 0)} pts` : '—',
      detail: runnerUp ? `over ${runnerUp.team}` : 'No runner-up yet',
    },
    {
      label: 'Clubs',
      value: String(rows.length),
      detail: 'in table',
    },
    {
      label: 'Matches',
      value: String(matchesLogged),
      detail: 'logged',
    },
    {
      label: 'Leader pace',
      value: leaderPace,
      detail: 'pts per match',
    },
    {
      label: 'Avg points',
      value: averagePoints,
      detail: 'per club',
    },
  ];

  if (bestForm) {
    cards.push({
      label: 'Best form',
      value: formatForm(bestForm.form),
      detail: bestForm.team,
    });
  }

  return cards;
}

function renderFormBadges(form?: string): string {
  const values = formatForm(form);
  if (values === '—') {
    return '<span style="font-size:11px;color:rgba(255,255,255,0.40);">—</span>';
  }

  return `
    <span style="display:inline-flex;gap:4px;flex-wrap:nowrap;">
      ${values.split('').map((value) => {
        const tone = value === 'W'
          ? 'background:rgba(16,185,129,0.18);color:#a7f3d0;'
          : value === 'D'
            ? 'background:rgba(245,158,11,0.16);color:#fde68a;'
            : 'background:rgba(239,68,68,0.16);color:#fca5a5;';
        return `<span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;font-size:10px;font-weight:700;${tone}">${value}</span>`;
      }).join('')}
    </span>
  `;
}

function renderTableRows(table: SportsTableGroup): string {
  return table.rows.map((row) => {
    const isLeader = row.rank === 1;
    const rowAccent = isLeader ? 'background:rgba(16,185,129,0.05);' : '';
    const rankAccent = isLeader
      ? 'background:rgba(16,185,129,0.18);color:#a7f3d0;'
      : 'background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.76);';

    return `
      <tr style="border-top:1px solid rgba(255,255,255,0.06);${rowAccent}">
        <td style="padding:10px 8px;vertical-align:middle;">
          <span style="display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:700;${rankAccent}">
            ${row.rank}
          </span>
        </td>
        <td style="padding:10px 8px;min-width:180px;vertical-align:middle;">
          <div style="display:grid;gap:4px;">
            ${renderSportsTeamIdentity(row.team, row.badge)}
            ${row.note ? `<div style="font-size:10px;color:rgba(255,255,255,0.44);letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(row.note)}</div>` : ''}
          </div>
        </td>
        <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.74);">${row.played}</td>
        <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.74);">${row.wins}</td>
        <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.74);">${row.draws}</td>
        <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.74);">${row.losses}</td>
        <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.74);">${row.goalDifference >= 0 ? '+' : ''}${row.goalDifference}</td>
        <td style="padding:10px 8px;text-align:center;font-size:13px;font-weight:800;color:#f8fafc;">${row.points}</td>
        <td style="padding:10px 8px;text-align:right;">${renderFormBadges(row.form)}</td>
      </tr>
    `;
  }).join('');
}

function renderTableNotes(rows: SportsStandingRow[]): string {
  const notes = [...new Set(rows.map((row) => row.note).filter(Boolean))];
  if (!notes.length) return '';

  return `
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">
      ${notes.map((note) => `
        <span style="display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;background:rgba(255,255,255,0.05);font-size:10px;letter-spacing:0.04em;text-transform:uppercase;color:rgba(255,255,255,0.62);">
          ${escapeHtml(note || '')}
        </span>
      `).join('')}
    </div>
  `;
}

export class SportsTablesPanel extends Panel {
  private leagues: SportsLeagueOption[] = [];
  private data: SportsLeagueCenterData | null = null;
  private selectedLeagueId = loadStored(SPORTS_LEAGUE_ID_KEY) || '4328';
  private loadToken = 0;

  constructor() {
    super({
      id: 'sports-tables',
      title: 'League Table',
      showCount: true,
      className: 'panel-wide',
      defaultRowSpan: 5,
      infoTooltip: 'Select a football league to view its current full standings table and live league stats.',
    });

    saveStored(LEGACY_SPORTS_SEASON_KEY, '');

    this.content.addEventListener('change', (event) => {
      const target = event.target as HTMLElement;
      const select = target.closest('select[data-action="league-select"]') as HTMLSelectElement | null;
      if (!select || !select.value || select.value === this.selectedLeagueId) return;

      this.selectedLeagueId = select.value;
      saveStored(SPORTS_LEAGUE_ID_KEY, this.selectedLeagueId);
      void this.fetchData();
    });
  }

  public async fetchData(): Promise<boolean> {
    const token = ++this.loadToken;
    try {
      if (!this.leagues.length) {
        this.showLoading('Loading league directory...');
        this.leagues = (await fetchAllSportsLeagues()).filter((league) => league.sport === 'Soccer');
      }

      const selectedLeague = this.resolveSelectedLeague();
      if (!selectedLeague) {
        this.setCount(0);
        this.showError('No league directory available right now.', () => void this.fetchData());
        return false;
      }

      this.showLoading('Loading current table...');
      const data = await fetchLeagueCenterData(selectedLeague.id);
      if (token !== this.loadToken) return false;
      if (!data) {
        this.setCount(0);
        this.showError('League table is unavailable right now.', () => void this.fetchData());
        return false;
      }

      this.data = data;
      this.selectedLeagueId = data.league.id;
      saveStored(SPORTS_LEAGUE_ID_KEY, this.selectedLeagueId);
      saveStored(LEGACY_SPORTS_SEASON_KEY, '');
      this.setCount(data.table?.rows.length ?? 0);
      this.clearNewBadge();
      this.renderPanel();
      return true;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.setCount(0);
      this.showError('Failed to load league table.', () => void this.fetchData());
      return false;
    }
  }

  private resolveSelectedLeague(): SportsLeagueOption | null {
    if (!this.leagues.length) return null;
    return this.leagues.find((league) => league.id === this.selectedLeagueId)
      || this.leagues.find((league) => league.id === '4328')
      || this.leagues[0]
      || null;
  }

  private renderControls(): string {
    const groupedLeagues = buildLeagueGroups(this.leagues);

    return `
      <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
        <div style="display:grid;gap:4px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Competition</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.56);">Choose a football league. The panel loads the latest live table the feed has for that competition.</div>
        </div>
        <label style="display:grid;gap:4px;">
          <span style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.46);">League</span>
          <select data-action="league-select" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:inherit;border-radius:8px;padding:9px 10px;font:inherit;">
            ${groupedLeagues.map(([sport, leagues]) => `
              <optgroup label="${escapeHtml(sport)}">
                ${leagues.map((league) => `<option value="${escapeHtml(league.id)}"${league.id === this.selectedLeagueId ? ' selected' : ''}>${escapeHtml(league.name)}</option>`).join('')}
              </optgroup>
            `).join('')}
          </select>
        </label>
      </section>
    `;
  }

  private renderStats(): string {
    if (!this.data?.table?.rows.length) return '';

    const cards = buildStatCards(this.data);
    const league = this.data.league;
    const meta = [
      league.country,
      buildSeasonLabel(this.data),
      this.data.table?.updatedAt ? `Updated ${formatUpdatedAt(this.data.table.updatedAt)}` : 'Live table',
    ].filter((value): value is string => !!value).join(' · ');

    return `
      <section style="display:grid;gap:8px;">
        <div style="display:grid;gap:2px;">
          <div style="font-size:18px;font-weight:800;line-height:1.2;">${escapeHtml(league.name)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.54);">${escapeHtml(meta)}</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;">
        ${cards.map((card) => `
          <article style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px;background:rgba(255,255,255,0.03);display:grid;gap:6px;min-width:0;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.46);">${escapeHtml(card.label)}</div>
            <div style="font-size:15px;font-weight:800;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(card.value)}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.54);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(card.detail || '')}</div>
          </article>
        `).join('')}
        </div>
      </section>
    `;
  }

  private renderStandings(): string {
    if (!this.data) return '';

    if (!this.data.table?.rows.length) {
      return `
        <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:rgba(255,255,255,0.02);display:grid;gap:8px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Standings</div>
          <div style="font-size:12px;line-height:1.6;color:rgba(255,255,255,0.62);">
            The active feed does not return a current standings table for this league. Select another competition to load a live table.
          </div>
        </section>
      `;
    }

    return `
      <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
          <div style="display:grid;gap:3px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Live Table</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.54);">${escapeHtml(`${buildSeasonLabel(this.data)} · ${this.data.table.rows.length} clubs`)}</div>
          </div>
          <div style="font-size:11px;color:rgba(255,255,255,0.46);text-align:right;">
            ${escapeHtml(this.data.table.updatedAt ? `Updated ${formatUpdatedAt(this.data.table.updatedAt)}` : 'Live feed')}
          </div>
        </div>

        <div style="overflow:auto;margin:0 -2px;padding:0 2px;">
          <table style="width:100%;border-collapse:collapse;min-width:720px;">
            <thead>
              <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
                <th style="padding:0 8px 8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Pos</th>
                <th style="padding:0 8px 8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Team</th>
                <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">P</th>
                <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">W</th>
                <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">D</th>
                <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">L</th>
                <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">GD</th>
                <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Pts</th>
                <th style="padding:0 8px 8px;text-align:right;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Form</th>
              </tr>
            </thead>
            <tbody>
              ${renderTableRows(this.data.table)}
            </tbody>
          </table>
        </div>

        ${renderTableNotes(this.data.table.rows)}
      </section>
    `;
  }

  private renderPanel(): void {
    if (!this.leagues.length) {
      this.showLoading('Loading league directory...');
      return;
    }

    const controlsHtml = this.renderControls();
    if (!this.data) {
      this.setContent(`${controlsHtml}<div style="font-size:12px;color:rgba(255,255,255,0.60);line-height:1.6;">Select a league to load its current standings and league stats.</div>`);
      return;
    }

    this.setContent(`
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        ${controlsHtml}
        ${this.renderStats()}
        ${this.renderStandings()}
      </div>
    `);
  }
}
