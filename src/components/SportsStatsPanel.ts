import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { fetchFeaturedSportsStats, parseEventTimestamp, type SportsEvent, type SportsStatSnapshot } from '@/services/sports';
import { renderSportsTeamIdentity } from './sportsPanelShared';

function formatEventMeta(event: SportsEvent): string {
  const timestamp = parseEventTimestamp(event);
  const parts: string[] = [];
  if (timestamp !== Number.MAX_SAFE_INTEGER) {
    parts.push(new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  } else if (event.dateEvent) {
    parts.push(event.dateEvent);
  }
  if (event.strVenue) parts.push(event.strVenue);
  return parts.join(' | ');
}

export class SportsStatsPanel extends Panel {
  private snapshots: SportsStatSnapshot[] = [];

  constructor() {
    super({
      id: 'sports-stats',
      title: 'Match Stats',
      showCount: false,
      infoTooltip: 'Recent match stat snapshots powered by ESPN match summaries across featured competitions.',
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading('Loading match stats...');
    try {
      this.snapshots = await fetchFeaturedSportsStats();
      if (this.snapshots.length === 0) {
        this.showError('No match stats available right now.', () => void this.fetchData());
        return false;
      }
      this.renderPanel();
      return true;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.showError('Failed to load match stats.', () => void this.fetchData());
      return false;
    }
  }

  private renderPanel(): void {
    const html = `
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        ${this.snapshots.map((snapshot) => `
          <section style="border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 12px;background:rgba(255,255,255,0.02);">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px;">
              <div>
                <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.58);">${escapeHtml(snapshot.league.shortName)}</div>
                <div style="font-size:14px;font-weight:700;line-height:1.35;">${escapeHtml(snapshot.event.strEvent || `${snapshot.event.strHomeTeam || ''} vs ${snapshot.event.strAwayTeam || ''}`)}</div>
              </div>
              <div style="font-size:11px;color:rgba(255,255,255,0.48);text-align:right;">${escapeHtml(formatEventMeta(snapshot.event))}</div>
            </div>
            <div style="display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;font-size:12px;margin-bottom:8px;">
              ${renderSportsTeamIdentity(snapshot.event.strHomeTeam || 'Home', snapshot.event.strHomeBadge)}
              <div style="font-weight:700;color:rgba(255,255,255,0.74);">${escapeHtml((snapshot.event.intHomeScore || snapshot.event.intAwayScore) ? `${snapshot.event.intHomeScore || '-'} - ${snapshot.event.intAwayScore || '-'}` : 'vs')}</div>
              ${renderSportsTeamIdentity(snapshot.event.strAwayTeam || 'Away', snapshot.event.strAwayBadge, { align: 'right' })}
            </div>
            <div style="display:grid;gap:6px;">
              ${snapshot.stats.map((stat) => `
                <div style="display:grid;grid-template-columns:40px minmax(0,1fr) 40px;gap:10px;align-items:center;">
                  <span style="font-size:12px;font-weight:600;">${escapeHtml(stat.homeValue || '-')}</span>
                  <span style="font-size:11px;color:rgba(255,255,255,0.48);text-align:center;text-transform:uppercase;letter-spacing:0.06em;">${escapeHtml(stat.label)}</span>
                  <span style="font-size:12px;font-weight:600;text-align:right;">${escapeHtml(stat.awayValue || '-')}</span>
                </div>
              `).join('')}
            </div>
          </section>
        `).join('')}
      </div>
    `;

    this.setContent(html);
  }
}
