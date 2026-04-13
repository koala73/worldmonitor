import { Panel } from './Panel';
import { fetchFormulaOneStandingsData, type FormulaOneStandingsData, type MotorsportStandingRow } from '@/services/sports';
import { escapeHtml } from '@/utils/sanitize';
import { renderSportsTeamIdentity } from './sportsPanelShared';

type MotorsportCard = {
  label: string;
  value: string;
  detail?: string;
};

function sanitizeHexColor(value?: string): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(normalized) ? `#${normalized}` : null;
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

function formatRaceDate(date?: string, time?: string): string {
  if (!date) return 'TBD';
  const stamp = Date.parse(time ? `${date}T${time}` : `${date}T00:00:00Z`);
  if (Number.isNaN(stamp)) return [date, time].filter(Boolean).join(' ');
  return new Date(stamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: time ? 'numeric' : undefined,
    minute: time ? '2-digit' : undefined,
  });
}

function buildCards(data: FormulaOneStandingsData): MotorsportCard[] {
  const driverLeader = data.driverStandings[0];
  const constructorLeader = data.constructorStandings[0];
  const cards: MotorsportCard[] = [];

  if (driverLeader) {
    cards.push({ label: 'Driver Leader', value: driverLeader.name, detail: `${driverLeader.points} pts` });
  }
  if (constructorLeader) {
    cards.push({ label: 'Constructor Leader', value: constructorLeader.name, detail: `${constructorLeader.points} pts` });
  }
  if (data.lastRace?.winner) {
    cards.push({ label: 'Last Winner', value: data.lastRace.winner, detail: data.lastRace.raceName });
  }
  if (data.nextRace) {
    cards.push({ label: 'Next Race', value: data.nextRace.raceName, detail: formatRaceDate(data.nextRace.date, data.nextRace.time) });
  }

  return cards;
}

function renderCards(cards: MotorsportCard[]): string {
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

function renderRaceCard(title: string, summary: FormulaOneStandingsData['lastRace'] | FormulaOneStandingsData['nextRace']): string {
  if (!summary) {
    return `
      <article style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.03);display:grid;gap:6px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.48);">${escapeHtml(title)}</div>
        <div style="font-size:13px;font-weight:700;line-height:1.45;">No race data available.</div>
      </article>
    `;
  }

  const meta = [summary.circuitName, summary.locality, summary.country].filter(Boolean).join(' · ');
  const extra = summary.podium.length
    ? `Podium: ${summary.podium.join(' · ')}`
    : summary.fastestLap
      ? `Fastest lap: ${summary.fastestLap}`
      : '';

  return `
    <article style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.03);display:grid;gap:6px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.48);">${escapeHtml(title)}</div>
      <div style="font-size:13px;font-weight:700;line-height:1.45;">${escapeHtml(summary.raceName)}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.54);">${escapeHtml(formatRaceDate(summary.date, summary.time))}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.44);">${escapeHtml(meta || `Round ${summary.round}`)}</div>
      ${extra ? `<div style="font-size:11px;color:rgba(255,255,255,0.58);line-height:1.5;">${escapeHtml(extra)}</div>` : ''}
    </article>
  `;
}

function renderStandingsRows(rows: MotorsportStandingRow[]): string {
  return rows.map((row) => {
    const teamAccent = sanitizeHexColor(row.teamColor);
    const rowBackground = row.rank === 1 ? 'background:rgba(16,185,129,0.05);' : '';
    const accentBar = teamAccent ? `box-shadow:inset 3px 0 0 ${teamAccent};` : '';
    const secondary = [row.code, row.driverNumber ? `#${row.driverNumber}` : row.nationality].filter(Boolean).join(' · ');

    return `
    <tr style="border-top:1px solid rgba(255,255,255,0.06);${rowBackground}">
      <td style="padding:10px 8px;font-size:12px;font-weight:700;color:#f8fafc;">${row.rank}</td>
      <td style="padding:10px 8px;min-width:200px;${accentBar}">
        <div style="display:grid;gap:4px;">
          ${renderSportsTeamIdentity(row.name, row.badge, { secondary, size: 28 })}
        </div>
      </td>
      <td style="padding:10px 8px;text-align:left;font-size:12px;color:rgba(255,255,255,0.76);${accentBar}">
        ${row.team ? renderSportsTeamIdentity(row.team, row.teamBadge, { size: 22 }) : '—'}
      </td>
      <td style="padding:10px 8px;text-align:center;font-size:12px;font-weight:700;color:#f8fafc;">${row.points}</td>
      <td style="padding:10px 8px;text-align:center;font-size:12px;color:rgba(255,255,255,0.76);">${row.wins}</td>
      <td style="padding:10px 8px;text-align:right;font-size:12px;color:rgba(255,255,255,0.76);">${escapeHtml(row.nationality || '—')}</td>
    </tr>
  `;
  }).join('');
}

function renderStandingsTable(title: string, rows: MotorsportStandingRow[]): string {
  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(title)}</div>

      <div style="overflow:auto;margin:0 -2px;padding:0 2px;">
        <table style="width:100%;border-collapse:collapse;min-width:760px;">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
              <th style="padding:0 8px 8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Pos</th>
              <th style="padding:0 8px 8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Name</th>
              <th style="padding:0 8px 8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Team</th>
              <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Pts</th>
              <th style="padding:0 8px 8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Wins</th>
              <th style="padding:0 8px 8px;text-align:right;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.44);">Nation</th>
            </tr>
          </thead>
          <tbody>
            ${renderStandingsRows(rows)}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

export class SportsMotorsportPanel extends Panel {
  private data: FormulaOneStandingsData | null = null;

  constructor() {
    super({
      id: 'sports-motorsport-standings',
      title: 'Motorsport Scores',
      showCount: true,
      className: 'panel-wide',
      defaultRowSpan: 4,
      infoTooltip: 'Live Formula 1 driver and constructor standings with the latest and next race summary.',
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading('Loading motorsport standings...');
    try {
      const data = await fetchFormulaOneStandingsData();
      if (!data) {
        this.setCount(0);
        this.showError('Motorsport standings are unavailable right now.', () => void this.fetchData());
        return false;
      }

      this.data = data;
      this.setCount(data.driverStandings.length);
      this.renderPanel();
      return true;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.setCount(0);
      this.showError('Failed to load motorsport standings.', () => void this.fetchData());
      return false;
    }
  }

  private renderPanel(): void {
    if (!this.data) {
      this.setContent('<div style="font-size:12px;color:rgba(255,255,255,0.60);line-height:1.6;">Loading motorsport standings.</div>');
      return;
    }

    const cards = buildCards(this.data);
    this.setContent(`
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));display:grid;gap:6px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Formula 1</div>
          <div style="font-size:20px;font-weight:800;line-height:1.2;">${escapeHtml(this.data.season)} Championship Standings</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.56);">Driver and constructor tables with the latest completed race and the next scheduled Grand Prix.</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.48);">Round ${escapeHtml(this.data.round || '—')} · Updated ${escapeHtml(formatUpdatedAt(this.data.updatedAt))}</div>
        </section>

        ${renderCards(cards)}

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px;">
          ${renderRaceCard('Last Race', this.data.lastRace)}
          ${renderRaceCard('Next Race', this.data.nextRace)}
        </div>

        ${renderStandingsTable('Driver Standings', this.data.driverStandings)}
        ${renderStandingsTable('Constructor Standings', this.data.constructorStandings)}
      </div>
    `);
  }
}
