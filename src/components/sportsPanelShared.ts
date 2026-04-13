import {
  parseEventTimestamp,
  type SportsEvent,
  type SportsLeagueCenterData,
  type SportsStandingRow,
  type SportsStatSnapshot,
  type SportsTableGroup,
} from '@/services/sports';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

export type SportsLeagueStatCard = {
  label: string;
  value: string;
  detail?: string;
};

type SportsIdentityOptions = {
  align?: 'left' | 'right';
  size?: number;
  secondary?: string;
};

type SportsEventCardOptions = {
  showTitle?: boolean;
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

export function formatSportsForm(form?: string): string {
  const cleaned = (form || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 5);
  return cleaned || '—';
}

export function formatSportsUpdatedAt(value?: string): string {
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

export function buildSportsSeasonLabel(data: SportsLeagueCenterData): string {
  return data.table?.season || data.league.currentSeason || data.selectedSeason || 'Current season';
}

export function buildSportsLeagueStatCards(data: SportsLeagueCenterData): SportsLeagueStatCard[] {
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

  const cards: SportsLeagueStatCard[] = [
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
      value: formatSportsForm(bestForm.form),
      detail: bestForm.team,
    });
  }

  return cards;
}

export function formatSportsEventTime(event: SportsEvent): string {
  const timestamp = parseEventTimestamp(event);
  if (timestamp !== Number.MAX_SAFE_INTEGER) {
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  if (event.dateEvent && event.strTime) return `${event.dateEvent} ${event.strTime}`;
  return event.dateEvent || event.strTime || 'TBD';
}

export function formatSportsEventResult(event: SportsEvent): string {
  if (event.intHomeScore || event.intAwayScore) {
    return `${event.strHomeTeam || 'Home'} ${event.intHomeScore || '-'} - ${event.intAwayScore || '-'} ${event.strAwayTeam || 'Away'}`;
  }
  return event.strEvent || `${event.strHomeTeam || 'Home'} vs ${event.strAwayTeam || 'Away'}`;
}

export function formatSportsFixture(event: SportsEvent): string {
  return event.strEvent || `${event.strHomeTeam || 'Home'} vs ${event.strAwayTeam || 'Away'}`;
}

function buildSportsMonogram(name?: string): string {
  const parts = (name || '')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0] || '';
  const second = parts[1] || '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return `${first[0] || ''}${second[0] || ''}`.toUpperCase();
}

export function renderSportsBadge(name?: string, badge?: string, size = 24): string {
  const px = `${size}px`;
  const safeBadge = badge ? sanitizeUrl(badge) : '';
  if (safeBadge) {
    return `
      <span style="display:inline-flex;align-items:center;justify-content:center;width:${px};height:${px};flex:0 0 ${px};border-radius:999px;background:rgba(255,255,255,0.08);overflow:hidden;">
        <img src="${safeBadge}" alt="${escapeHtml(name || 'Team')}" style="width:${px};height:${px};object-fit:cover;display:block;" loading="lazy" />
      </span>
    `;
  }

  return `
    <span style="display:inline-flex;align-items:center;justify-content:center;width:${px};height:${px};flex:0 0 ${px};border-radius:999px;background:rgba(255,255,255,0.08);font-size:${Math.max(size - 13, 9)}px;font-weight:800;letter-spacing:0.04em;color:rgba(255,255,255,0.78);">
      ${escapeHtml(buildSportsMonogram(name))}
    </span>
  `;
}

export function renderSportsTeamIdentity(
  name: string | undefined,
  badge?: string,
  options: SportsIdentityOptions = {},
): string {
  const align = options.align === 'right' ? 'right' : 'left';
  const secondary = options.secondary
    ? `<div style="font-size:10px;color:rgba(255,255,255,0.46);letter-spacing:0.04em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${escapeHtml(options.secondary)}</div>`
    : '';

  return `
    <div style="display:flex;align-items:center;gap:10px;min-width:0;flex-direction:${align === 'right' ? 'row-reverse' : 'row'};text-align:${align};">
      ${renderSportsBadge(name, badge, options.size || 24)}
      <div style="display:grid;gap:2px;min-width:0;justify-items:${align === 'right' ? 'end' : 'start'};flex:1 1 auto;">
        <div style="font-size:13px;font-weight:700;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${escapeHtml(name || 'TBD')}</div>
        ${secondary}
      </div>
    </div>
  `;
}

export function renderSportsMatchup(event: SportsEvent, mode: 'result' | 'fixture'): string {
  const statusDetail = event.strProgress && event.strProgress !== event.strStatus
    ? event.strProgress
    : event.strStatus;
  const centerLabel = mode === 'result' && (event.intHomeScore || event.intAwayScore)
    ? `${event.intHomeScore || '-'} - ${event.intAwayScore || '-'}`
    : 'vs';

  return `
    <div style="display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:center;">
      ${renderSportsTeamIdentity(event.strHomeTeam, event.strHomeBadge)}
      <div style="display:grid;justify-items:center;gap:2px;min-width:56px;">
        <div style="font-size:${mode === 'result' ? '15px' : '12px'};font-weight:800;color:#f8fafc;">${escapeHtml(centerLabel)}</div>
        ${statusDetail ? `<div style="font-size:10px;color:rgba(255,255,255,0.46);text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(statusDetail)}</div>` : ''}
      </div>
      ${renderSportsTeamIdentity(event.strAwayTeam, event.strAwayBadge, { align: 'right' })}
    </div>
  `;
}

export function renderSportsFormBadges(form?: string): string {
  const values = formatSportsForm(form);
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

export function renderSportsTableRows(table: SportsTableGroup): string {
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
        <td style="padding:10px 8px;text-align:right;">${renderSportsFormBadges(row.form)}</td>
      </tr>
    `;
  }).join('');
}

export function renderSportsTableNotes(rows: SportsStandingRow[]): string {
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

export function renderSportsStandingsBlock(
  title: string,
  seasonLabel: string,
  table: SportsTableGroup | null,
  emptyMessage: string,
): string {
  if (!table?.rows.length) {
    return `
      <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:rgba(255,255,255,0.02);display:grid;gap:8px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(title)}</div>
        <div style="font-size:12px;line-height:1.6;color:rgba(255,255,255,0.62);">${escapeHtml(emptyMessage)}</div>
      </section>
    `;
  }

  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
        <div style="display:grid;gap:3px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(title)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.54);">${escapeHtml(seasonLabel)}</div>
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.46);text-align:right;">
          ${escapeHtml(table.updatedAt ? `Updated ${formatSportsUpdatedAt(table.updatedAt)}` : 'Live feed')}
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
            ${renderSportsTableRows(table)}
          </tbody>
        </table>
      </div>

      ${renderSportsTableNotes(table.rows)}
    </section>
  `;
}

export function renderSportsEventCard(
  title: string,
  event: SportsEvent | undefined,
  mode: 'result' | 'fixture',
  options: SportsEventCardOptions = {},
): string {
  const showTitle = options.showTitle !== false;
  if (!event) {
    return `
      <article style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.03);display:grid;gap:6px;">
        ${showTitle ? `<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.48);">${escapeHtml(title)}</div>` : ''}
        <div style="font-size:13px;font-weight:700;line-height:1.4;">No ${mode === 'result' ? 'recent result' : 'upcoming event'} available.</div>
      </article>
    `;
  }

  const headline = mode === 'result' ? formatSportsEventResult(event) : formatSportsFixture(event);
  const meta = [
    event.strVenue,
    event.strRound ? `Round ${event.strRound}` : '',
    event.strSeason,
  ].filter(Boolean).join(' · ');

  return `
    <article style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.03);display:grid;gap:6px;">
      ${showTitle ? `<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.48);">${escapeHtml(title)}</div>` : ''}
      ${(event.strHomeTeam || event.strAwayTeam) ? renderSportsMatchup(event, mode) : `<div style="font-size:13px;font-weight:700;line-height:1.45;">${escapeHtml(headline)}</div>`}
      <div style="font-size:11px;color:rgba(255,255,255,0.54);">${escapeHtml(formatSportsEventTime(event))}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.44);">${escapeHtml(meta || 'Live sports feed')}</div>
    </article>
  `;
}

export function renderSportsEventSection(
  title: string,
  events: SportsEvent[],
  mode: 'result' | 'fixture',
  emptyMessage: string,
): string {
  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.03);display:grid;gap:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(title)}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.46);">${events.length ? `${events.length} match${events.length === 1 ? '' : 'es'}` : 'No events'}</div>
      </div>
      ${events.length
        ? `<div style="display:grid;gap:8px;">${events.map((event) => renderSportsEventCard('', event, mode, { showTitle: false })).join('')}</div>`
        : `<div style="font-size:12px;color:rgba(255,255,255,0.60);line-height:1.6;">${escapeHtml(emptyMessage)}</div>`}
    </section>
  `;
}

export function renderSportsStatSnapshotBlock(title: string, snapshot: SportsStatSnapshot | null): string {
  if (!snapshot) {
    return `
      <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.03);display:grid;gap:8px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(title)}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.60);">No recent stat snapshot available.</div>
      </section>
    `;
  }

  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.03);display:grid;gap:8px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(title)}</div>
          <div style="font-size:13px;font-weight:700;line-height:1.35;">${escapeHtml(snapshot.event.strEvent || formatSportsEventResult(snapshot.event))}</div>
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.48);text-align:right;">${escapeHtml(formatSportsEventTime(snapshot.event))}</div>
      </div>
      ${renderSportsMatchup(snapshot.event, 'result')}
      <div style="display:grid;gap:6px;">
        ${snapshot.stats.map((stat) => `
          <div style="display:grid;grid-template-columns:44px minmax(0,1fr) 44px;gap:10px;align-items:center;">
            <span style="font-size:12px;font-weight:600;">${escapeHtml(stat.homeValue || '-')}</span>
            <span style="font-size:11px;color:rgba(255,255,255,0.48);text-align:center;text-transform:uppercase;letter-spacing:0.06em;">${escapeHtml(stat.label)}</span>
            <span style="font-size:12px;font-weight:600;text-align:right;">${escapeHtml(stat.awayValue || '-')}</span>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}
