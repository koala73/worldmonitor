import { Panel } from './Panel';
import {
  fetchMajorTournamentCenterData,
  fetchMajorTournamentLeagueOptions,
  type SportsLeagueCenterData,
  type SportsLeagueOption,
} from '@/services/sports';
import { escapeHtml } from '@/utils/sanitize';
import {
  buildSportsLeagueStatCards,
  buildSportsSeasonLabel,
  formatSportsUpdatedAt,
  renderSportsEventSection,
  renderSportsStandingsBlock,
  renderSportsStatSnapshotBlock,
} from './sportsPanelShared';

const TOURNAMENT_KEY = 'wm-sports-tournament-id';

function loadStored(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function saveStored(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Ignore persistence failures.
  }
}

export class SportsMajorTournamentsPanel extends Panel {
  private options: SportsLeagueOption[] = [];
  private data: SportsLeagueCenterData | null = null;
  private selectedLeagueId = loadStored(TOURNAMENT_KEY);
  private loadToken = 0;

  constructor() {
    super({
      id: 'sports-tournaments',
      title: 'Major Tournaments',
      showCount: true,
      className: 'panel-wide',
      defaultRowSpan: 4,
      infoTooltip: 'Curated ESPN tournament selector for major competitions such as the UEFA Champions League and FIFA World Cup.',
    });

    this.content.addEventListener('change', (event) => {
      const target = event.target as HTMLElement;
      const select = target.closest('select[data-action="tournament-select"]') as HTMLSelectElement | null;
      if (!select || !select.value || select.value === this.selectedLeagueId) return;

      this.selectedLeagueId = select.value;
      saveStored(TOURNAMENT_KEY, this.selectedLeagueId);
      void this.fetchData();
    });
  }

  public async fetchData(): Promise<boolean> {
    const token = ++this.loadToken;
    try {
      if (!this.options.length) {
        this.showLoading('Loading tournaments...');
        this.options = await fetchMajorTournamentLeagueOptions();
      }

      const selected = this.resolveSelectedLeague();
      if (!selected) {
        this.setCount(0);
        this.showError('No tournament leagues available right now.', () => void this.fetchData());
        return false;
      }

      this.showLoading('Loading tournament data...');
      const data = await fetchMajorTournamentCenterData(selected.id);
      if (token !== this.loadToken) return false;
      if (!data) {
        this.setCount(0);
        this.showError('Tournament data is unavailable right now.', () => void this.fetchData());
        return false;
      }

      this.data = data;
      this.selectedLeagueId = data.league.id;
      saveStored(TOURNAMENT_KEY, this.selectedLeagueId);
      this.setCount(data.table?.rows.length ?? (data.recentEvents.length + data.upcomingEvents.length));
      this.renderPanel();
      return true;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.setCount(0);
      this.showError('Failed to load major tournaments.', () => void this.fetchData());
      return false;
    }
  }

  private resolveSelectedLeague(): SportsLeagueOption | null {
    if (!this.options.length) return null;
    return this.options.find((option) => option.id === this.selectedLeagueId)
      || this.options[0]
      || null;
  }

  private renderControls(): string {
    return `
      <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
          <div style="display:grid;gap:4px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Tournament Selector</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.56);">Switch between major competitions like UCL, World Cup, Euros, and Copa tournaments.</div>
          </div>
        <label style="display:grid;gap:4px;">
          <span style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.46);">Tournament</span>
          <select data-action="tournament-select" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:inherit;border-radius:8px;padding:9px 10px;font:inherit;">
            ${this.options.map((option) => `<option value="${escapeHtml(option.id)}"${option.id === this.selectedLeagueId ? ' selected' : ''}>${escapeHtml(option.name)}</option>`).join('')}
          </select>
        </label>
      </section>
    `;
  }

  private renderPanel(): void {
    const controlsHtml = this.renderControls();
    if (!this.data) {
      this.setContent(`${controlsHtml}<div style="font-size:12px;color:rgba(255,255,255,0.60);line-height:1.6;">Select a major tournament to load standings, scores, and recent stats.</div>`);
      return;
    }

    const league = this.data.league;
    const pills = [
      league.sport,
      league.country,
      buildSportsSeasonLabel(this.data),
      this.data.table?.updatedAt ? `Updated ${formatSportsUpdatedAt(this.data.table.updatedAt)}` : 'Current tournament view',
    ].filter((value): value is string => !!value)
      .map((value) => `
        <span style="display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;background:rgba(255,255,255,0.05);font-size:11px;color:rgba(255,255,255,0.72);">
          ${escapeHtml(value)}
        </span>
      `).join('');

    const cards = buildSportsLeagueStatCards(this.data);

    this.setContent(`
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        ${controlsHtml}

        <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));display:grid;gap:10px;">
          <div style="display:grid;gap:4px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Tournament Dashboard</div>
            <div style="font-size:20px;font-weight:800;line-height:1.2;">${escapeHtml(league.name)}</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.56);">Latest result, next fixture, and the most recent stat snapshot for the selected tournament.</div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">${pills}</div>
        </section>

        ${cards.length ? `
          <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;">
            ${cards.map((card) => `
              <article style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px;background:rgba(255,255,255,0.03);display:grid;gap:6px;min-width:0;">
                <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.46);">${escapeHtml(card.label)}</div>
                <div style="font-size:15px;font-weight:800;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(card.value)}</div>
                <div style="font-size:11px;color:rgba(255,255,255,0.54);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(card.detail || '')}</div>
              </article>
            `).join('')}
          </section>
        ` : ''}

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:8px;">
          ${renderSportsEventSection('Recent Results', this.data.recentEvents, 'result', 'No completed matches available for this tournament window.')}
          ${renderSportsEventSection('Upcoming Fixtures', this.data.upcomingEvents, 'fixture', 'No upcoming matches are scheduled in the current tournament window.')}
        </div>

        ${renderSportsStatSnapshotBlock('Latest Match Stats', this.data.statSnapshot)}
        ${renderSportsStandingsBlock('Tournament Table', buildSportsSeasonLabel(this.data), this.data.table, 'The active feed does not return a current standings table for this tournament.')}
      </div>
    `);
  }
}
