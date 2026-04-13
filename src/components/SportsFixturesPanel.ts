import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { fetchFeaturedSportsFixtures, parseEventTimestamp, type SportsEvent, type SportsFixtureGroup } from '@/services/sports';
import { renderSportsTeamIdentity } from './sportsPanelShared';

function formatFixtureDayLabel(date = new Date()): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function formatEventClock(event: SportsEvent): string {
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

export class SportsFixturesPanel extends Panel {
  private groups: SportsFixtureGroup[] = [];

  constructor() {
    super({
      id: 'sports-fixtures',
      title: 'Daily Fixtures',
      showCount: true,
      infoTooltip: 'Today\'s fixtures across top football leagues, the NBA, and motorsport calendars from open sports schedule feeds.',
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading('Loading daily fixtures...');
    try {
      this.groups = await fetchFeaturedSportsFixtures();
      if (this.groups.length === 0) {
        this.setCount(0);
        this.showError('No daily fixture data available right now.', () => void this.fetchData());
        return false;
      }
      this.setCount(this.groups.reduce((sum, group) => sum + group.events.length, 0));
      this.renderPanel();
      return true;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.setCount(0);
      this.showError('Failed to load fixtures.', () => void this.fetchData());
      return false;
    }
  }

  private renderPanel(): void {
    const dayLabel = formatFixtureDayLabel();
    const html = `
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.58);">Daily Schedule</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.48);">${escapeHtml(dayLabel)}</div>
        </div>
        ${this.groups.map((group) => `
          <section style="border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 12px;background:rgba(255,255,255,0.02);">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
              <div>
                <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.58);">${escapeHtml(group.league.sport)}</div>
                <div style="font-size:14px;font-weight:700;">${escapeHtml(group.league.name)}</div>
              </div>
              <div style="font-size:11px;color:rgba(255,255,255,0.48);text-align:right;">${escapeHtml(group.league.country || group.league.shortName)}</div>
            </div>
            <div style="display:grid;gap:8px;">
              ${group.events.map((event) => `
                <div style="display:grid;gap:4px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.03);">
                  <div style="display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:center;">
                    ${renderSportsTeamIdentity(event.strHomeTeam || 'Home', event.strHomeBadge)}
                    <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.58);white-space:nowrap;text-align:center;">${escapeHtml(formatEventClock(event))}</div>
                    ${renderSportsTeamIdentity(event.strAwayTeam || 'Away', event.strAwayBadge, { align: 'right' })}
                  </div>
                  <div style="font-size:12px;color:rgba(255,255,255,0.72);">${escapeHtml(event.strEvent || `${event.strHomeTeam || 'Home'} vs ${event.strAwayTeam || 'Away'}`)}</div>
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;color:rgba(255,255,255,0.48);">
                    <span>${escapeHtml(event.strVenue || 'Venue TBD')}</span>
                    <span>${escapeHtml(event.strRound ? `Round ${event.strRound}` : event.strSeason || '')}</span>
                  </div>
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
