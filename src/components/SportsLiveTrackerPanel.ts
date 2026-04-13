import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import {
  fetchSportsFixtureSnapshot,
  parseEventTimestamp,
  searchFeaturedSportsFixtures,
  type SportsEvent,
  type SportsFixtureSearchMatch,
  type SportsStatSnapshot,
} from '@/services/sports';
import { renderSportsTeamIdentity } from './sportsPanelShared';

const TRACKER_QUERY_KEY = 'wm-sports-live-tracker-query';
const TRACKER_SELECTION_KEY = 'wm-sports-live-tracker-selection';
const MAX_TRACKED_FIXTURES = 8;

type TrackedFixture = {
  eventId: string;
  leagueId?: string;
  leagueName?: string;
  sport?: string;
  label?: string;
  homeTeam?: string;
  awayTeam?: string;
  homeBadge?: string;
  awayBadge?: string;
};

const LIVE_STATUS_MARKERS = ['live', 'in progress', 'halftime', 'quarter', 'period', 'overtime', 'extra time'];

function toOptionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

function loadStoredString(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function saveStoredString(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

function sanitizeTrackedFixture(raw: unknown): TrackedFixture | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const eventId = toOptionalString(source.eventId);
  if (!eventId) return null;

  return {
    eventId,
    leagueId: toOptionalString(source.leagueId),
    leagueName: toOptionalString(source.leagueName),
    sport: toOptionalString(source.sport),
    label: toOptionalString(source.label),
    homeTeam: toOptionalString(source.homeTeam),
    awayTeam: toOptionalString(source.awayTeam),
    homeBadge: toOptionalString(source.homeBadge),
    awayBadge: toOptionalString(source.awayBadge),
  };
}

function loadTrackedFixtures(): TrackedFixture[] {
  try {
    const raw = localStorage.getItem(TRACKER_SELECTION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const fixtures: TrackedFixture[] = [];
    for (const entry of parsed) {
      const fixture = sanitizeTrackedFixture(entry);
      if (!fixture || seen.has(fixture.eventId)) continue;
      seen.add(fixture.eventId);
      fixtures.push(fixture);
      if (fixtures.length >= MAX_TRACKED_FIXTURES) break;
    }
    return fixtures;
  } catch {
    return [];
  }
}

function saveTrackedFixtures(fixtures: TrackedFixture[]): void {
  try {
    if (!fixtures.length) {
      localStorage.removeItem(TRACKER_SELECTION_KEY);
      return;
    }
    localStorage.setItem(TRACKER_SELECTION_KEY, JSON.stringify(fixtures.slice(0, MAX_TRACKED_FIXTURES)));
  } catch {
    // Ignore storage failures.
  }
}

function toTrackedFixture(match: SportsFixtureSearchMatch): TrackedFixture {
  const { league, event } = match;
  const title = event.strEvent || [event.strHomeTeam, event.strAwayTeam].filter(Boolean).join(' vs ') || league.name;
  return {
    eventId: event.idEvent,
    leagueId: event.idLeague || league.id,
    leagueName: event.strLeague || league.name,
    sport: event.strSport || league.sport,
    label: title,
    homeTeam: event.strHomeTeam,
    awayTeam: event.strAwayTeam,
    homeBadge: event.strHomeBadge,
    awayBadge: event.strAwayBadge,
  };
}

function formatFixtureTime(event: Pick<SportsEvent, 'strTimestamp' | 'dateEvent' | 'strTime'>): string {
  const ts = parseEventTimestamp(event);
  if (ts !== Number.MAX_SAFE_INTEGER) {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  if (event.dateEvent && event.strTime) return `${event.dateEvent} ${event.strTime}`;
  return event.dateEvent || event.strTime || 'TBD';
}

function getFixtureLabel(event: Pick<SportsEvent, 'strEvent' | 'strHomeTeam' | 'strAwayTeam'>, fallback = 'Fixture'): string {
  return event.strEvent || [event.strHomeTeam, event.strAwayTeam].filter(Boolean).join(' vs ') || fallback;
}

function isLiveFixture(event: Pick<SportsEvent, 'strStatus' | 'strProgress' | 'intHomeScore' | 'intAwayScore'>): boolean {
  const status = `${event.strStatus || ''} ${event.strProgress || ''}`.toLowerCase();
  if (LIVE_STATUS_MARKERS.some((marker) => status.includes(marker))) return true;
  if ((event.intHomeScore || event.intAwayScore) && status && !status.includes('final')) return true;
  return false;
}

function getFixtureStatusLabel(event: Pick<SportsEvent, 'strStatus' | 'strProgress' | 'strTimestamp' | 'dateEvent' | 'strTime'>): string {
  if (event.strProgress && event.strProgress !== event.strStatus) return event.strProgress;
  if (event.strStatus) return event.strStatus;
  return formatFixtureTime(event);
}

function renderSearchResults(results: SportsFixtureSearchMatch[], trackedEventIds: Set<string>): string {
  if (!results.length) return '';

  return `
    <section style="display:grid;gap:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Fixture Matches</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.44);">${results.length} result${results.length === 1 ? '' : 's'}</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;">
        ${results.map((match) => {
          const { event, league } = match;
          const tracked = trackedEventIds.has(event.idEvent);
          const live = isLiveFixture(event);
          return `
            <article style="border:1px solid ${tracked ? 'rgba(34,197,94,0.34)' : 'rgba(255,255,255,0.08)'};border-radius:12px;padding:10px;background:${tracked ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.03)'};display:grid;gap:8px;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <div style="font-size:11px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:rgba(255,255,255,0.58);">${escapeHtml(event.strLeague || league.shortName || league.name)}</div>
                <div style="font-size:10px;padding:3px 7px;border-radius:999px;border:1px solid ${live ? 'rgba(34,197,94,0.5)' : 'rgba(148,163,184,0.35)'};color:${live ? '#86efac' : 'rgba(226,232,240,0.86)'};background:${live ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.12)'};">
                  ${escapeHtml(getFixtureStatusLabel(event))}
                </div>
              </div>
              <div style="display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;align-items:center;">
                ${renderSportsTeamIdentity(event.strHomeTeam || 'Home', event.strHomeBadge)}
                <div style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.74);">${event.intHomeScore || event.intAwayScore ? `${escapeHtml(event.intHomeScore || '-')}-${escapeHtml(event.intAwayScore || '-')}` : 'vs'}</div>
                ${renderSportsTeamIdentity(event.strAwayTeam || 'Away', event.strAwayBadge, { align: 'right' })}
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                <div style="font-size:11px;color:rgba(255,255,255,0.48);">${escapeHtml(formatFixtureTime(event))}</div>
                <button
                  type="button"
                  data-action="fixture-track"
                  data-event-id="${escapeHtml(event.idEvent)}"
                  style="padding:5px 10px;border-radius:999px;border:1px solid ${tracked ? 'rgba(34,197,94,0.5)' : 'rgba(59,130,246,0.45)'};background:${tracked ? 'rgba(34,197,94,0.14)' : 'rgba(59,130,246,0.13)'};color:${tracked ? '#86efac' : '#bfdbfe'};font-size:11px;font-weight:700;cursor:${tracked ? 'default' : 'pointer'};"
                  ${tracked ? 'disabled' : ''}
                >
                  ${tracked ? 'Tracking' : 'Track'}
                </button>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function renderTrackedFixtureCard(fixture: TrackedFixture, snapshot: SportsStatSnapshot | undefined): string {
  const event = snapshot?.event || {
    idEvent: fixture.eventId,
    strLeague: fixture.leagueName,
    strSport: fixture.sport,
    strEvent: fixture.label,
    strHomeTeam: fixture.homeTeam,
    strAwayTeam: fixture.awayTeam,
    strHomeBadge: fixture.homeBadge,
    strAwayBadge: fixture.awayBadge,
  } satisfies SportsEvent;

  const leagueLabel = snapshot?.league.shortName || event.strLeague || fixture.sport || 'Fixture';
  const live = isLiveFixture(event);
  const stats = snapshot?.stats || [];
  const score = event.intHomeScore || event.intAwayScore
    ? `${event.intHomeScore || '-'} - ${event.intAwayScore || '-'}`
    : 'vs';

  return `
    <article style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px;background:rgba(255,255,255,0.03);display:grid;gap:10px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
        <div style="display:grid;gap:4px;min-width:0;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.54);">${escapeHtml(leagueLabel)}</div>
          <div style="font-size:14px;font-weight:700;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(getFixtureLabel(event, fixture.label || 'Selected fixture'))}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.5);">${escapeHtml(formatFixtureTime(event))}</div>
        </div>
        <div style="display:grid;justify-items:end;gap:6px;">
          <span style="font-size:10px;padding:3px 7px;border-radius:999px;border:1px solid ${live ? 'rgba(34,197,94,0.5)' : 'rgba(148,163,184,0.35)'};color:${live ? '#86efac' : 'rgba(226,232,240,0.86)'};background:${live ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.12)'};">
            ${escapeHtml(getFixtureStatusLabel(event))}
          </span>
          <button type="button" data-action="fixture-remove" data-event-id="${escapeHtml(fixture.eventId)}" style="padding:4px 8px;border-radius:999px;border:1px solid rgba(239,68,68,0.35);background:rgba(239,68,68,0.08);color:#fecaca;font-size:10px;font-weight:700;cursor:pointer;">
            Remove
          </button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;align-items:center;">
        ${renderSportsTeamIdentity(event.strHomeTeam || fixture.homeTeam || 'Home', event.strHomeBadge || fixture.homeBadge)}
        <div style="font-size:15px;font-weight:800;color:#f8fafc;">${escapeHtml(score)}</div>
        ${renderSportsTeamIdentity(event.strAwayTeam || fixture.awayTeam || 'Away', event.strAwayBadge || fixture.awayBadge, { align: 'right' })}
      </div>
      <div style="display:grid;gap:6px;">
        ${stats.length > 0
          ? stats.map((stat) => `
            <div style="display:grid;grid-template-columns:46px minmax(0,1fr) 46px;gap:8px;align-items:center;">
              <span style="font-size:12px;font-weight:700;">${escapeHtml(stat.homeValue || '-')}</span>
              <span style="font-size:10px;letter-spacing:0.06em;text-transform:uppercase;text-align:center;color:rgba(255,255,255,0.48);">${escapeHtml(stat.label)}</span>
              <span style="font-size:12px;font-weight:700;text-align:right;">${escapeHtml(stat.awayValue || '-')}</span>
            </div>
          `).join('')
          : '<div style="font-size:11px;color:rgba(255,255,255,0.5);">Waiting for live stats feed.</div>'}
      </div>
    </article>
  `;
}

export class SportsLiveTrackerPanel extends Panel {
  private query = loadStoredString(TRACKER_QUERY_KEY);
  private searchResults: SportsFixtureSearchMatch[] = [];
  private trackedFixtures: TrackedFixture[] = loadTrackedFixtures();
  private snapshots = new Map<string, SportsStatSnapshot>();
  private isSearching = false;
  private isRefreshingTracked = false;
  private statusMessage = '';
  private errorMessage = '';
  private loadToken = 0;

  constructor() {
    super({
      id: 'sports-live-tracker',
      title: 'Live Fixture Tracker',
      showCount: true,
      className: 'panel-wide',
      defaultRowSpan: 4,
      infoTooltip: 'Search fixtures, add multiple matches to your watchlist, and track score plus live stat updates in one panel.',
    });

    this.content.addEventListener('submit', (event) => {
      const form = (event.target as HTMLElement).closest('form[data-action="fixture-search"]') as HTMLFormElement | null;
      if (!form) return;
      event.preventDefault();
      const input = form.querySelector('input[name="fixture-query"]') as HTMLInputElement | null;
      void this.searchFixtures(input?.value || '');
    });

    this.content.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      const action = target?.dataset.action;
      if (!action) return;

      if (action === 'fixture-refresh') {
        void this.refreshTrackedFixtures();
        return;
      }

      const eventId = target?.dataset.eventId;
      if (!eventId) return;

      if (action === 'fixture-track') {
        const match = this.searchResults.find((entry) => entry.event.idEvent === eventId);
        if (match) this.addTrackedFixture(match);
        return;
      }

      if (action === 'fixture-remove') {
        this.removeTrackedFixture(eventId);
      }
    });
  }

  public async fetchData(): Promise<boolean> {
    this.setCount(this.trackedFixtures.length);

    if (this.trackedFixtures.length > 0) {
      return this.refreshTrackedFixtures();
    }

    if (this.query && this.searchResults.length === 0) {
      return this.searchFixtures(this.query);
    }

    this.renderPanel();
    return true;
  }

  private async searchFixtures(rawQuery: string): Promise<boolean> {
    const trimmed = rawQuery.trim();
    this.query = trimmed;
    saveStoredString(TRACKER_QUERY_KEY, trimmed);
    this.errorMessage = '';
    this.statusMessage = '';

    if (!trimmed) {
      this.searchResults = [];
      this.renderPanel();
      return true;
    }

    const token = ++this.loadToken;
    this.isSearching = true;
    this.renderPanel();

    try {
      const results = await searchFeaturedSportsFixtures(trimmed, 24);
      if (token !== this.loadToken) return false;
      this.searchResults = results;
      this.isSearching = false;
      if (!results.length) {
        this.statusMessage = `No fixtures found for "${trimmed}".`;
      }
      this.renderPanel();
      return results.length > 0;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.isSearching = false;
      this.errorMessage = 'Failed to search fixtures.';
      this.renderPanel();
      return false;
    }
  }

  private addTrackedFixture(match: SportsFixtureSearchMatch): void {
    if (this.trackedFixtures.some((fixture) => fixture.eventId === match.event.idEvent)) {
      this.statusMessage = 'This fixture is already being tracked.';
      this.renderPanel();
      return;
    }
    if (this.trackedFixtures.length >= MAX_TRACKED_FIXTURES) {
      this.statusMessage = `Tracker limit reached (${MAX_TRACKED_FIXTURES} fixtures). Remove one first.`;
      this.renderPanel();
      return;
    }

    this.trackedFixtures = [...this.trackedFixtures, toTrackedFixture(match)];
    saveTrackedFixtures(this.trackedFixtures);
    this.setCount(this.trackedFixtures.length);
    this.statusMessage = `Tracking ${getFixtureLabel(match.event, 'fixture')}.`;
    this.renderPanel();
    void this.refreshTrackedFixtures();
  }

  private removeTrackedFixture(eventId: string): void {
    const next = this.trackedFixtures.filter((fixture) => fixture.eventId !== eventId);
    if (next.length === this.trackedFixtures.length) return;
    this.trackedFixtures = next;
    saveTrackedFixtures(next);
    this.snapshots.delete(eventId);
    this.setCount(this.trackedFixtures.length);
    this.statusMessage = '';
    this.errorMessage = '';
    this.renderPanel();
  }

  private async refreshTrackedFixtures(): Promise<boolean> {
    this.setCount(this.trackedFixtures.length);
    if (!this.trackedFixtures.length) {
      this.renderPanel();
      return true;
    }

    const token = ++this.loadToken;
    this.isRefreshingTracked = true;
    this.errorMessage = '';
    this.renderPanel();

    try {
      const responses = await Promise.all(
        this.trackedFixtures.map(async (fixture) => ({
          fixture,
          snapshot: await fetchSportsFixtureSnapshot(fixture.eventId, fixture.leagueId, fixture.leagueName).catch(() => null),
        })),
      );
      if (token !== this.loadToken) return false;

      const nextSnapshots = new Map<string, SportsStatSnapshot>();
      let resolvedCount = 0;
      for (const { fixture, snapshot } of responses) {
        if (snapshot) {
          nextSnapshots.set(fixture.eventId, snapshot);
          resolvedCount += 1;
          continue;
        }
        const previous = this.snapshots.get(fixture.eventId);
        if (previous) nextSnapshots.set(fixture.eventId, previous);
      }

      this.snapshots = nextSnapshots;
      this.isRefreshingTracked = false;
      this.statusMessage = '';
      if (resolvedCount === 0) {
        this.errorMessage = 'Unable to refresh selected fixture stats right now.';
      }
      this.renderPanel();
      return resolvedCount > 0;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.isRefreshingTracked = false;
      this.errorMessage = 'Failed to refresh tracked fixtures.';
      this.renderPanel();
      return false;
    }
  }

  private renderPanel(): void {
    const trackedEventIds = new Set(this.trackedFixtures.map((fixture) => fixture.eventId));
    const trackedCards = this.trackedFixtures
      .map((fixture) => renderTrackedFixtureCard(fixture, this.snapshots.get(fixture.eventId)))
      .join('');

    const intro = this.trackedFixtures.length > 0
      ? 'Track multiple selected fixtures and monitor live score/stat updates in one place.'
      : 'Search for any match, add it to the tracker, and keep its live score and team stats visible.';

    this.setCount(this.trackedFixtures.length);
    this.setContent(`
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
            <div style="display:grid;gap:4px;">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Fixture Search</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.56);">${escapeHtml(intro)}</div>
            </div>
            <button type="button" data-action="fixture-refresh" style="padding:5px 10px;border-radius:999px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.76);font-size:11px;font-weight:700;cursor:pointer;">
              Refresh
            </button>
          </div>
          <form data-action="fixture-search" style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;">
            <input
              type="search"
              name="fixture-query"
              value="${escapeHtml(this.query)}"
              placeholder="Search by teams or fixture (e.g. Arsenal vs Liverpool)"
              autocomplete="off"
              style="padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:rgba(15,23,42,0.35);color:inherit;font-size:13px;"
            />
            <button type="submit" style="padding:10px 14px;border-radius:10px;border:1px solid rgba(59,130,246,0.5);background:rgba(59,130,246,0.15);color:#bfdbfe;font-size:12px;font-weight:700;cursor:pointer;">
              ${this.isSearching ? 'Searching...' : 'Search'}
            </button>
          </form>
          ${this.errorMessage ? `<div style="font-size:11px;color:#fca5a5;">${escapeHtml(this.errorMessage)}</div>` : ''}
          ${this.statusMessage ? `<div style="font-size:11px;color:rgba(255,255,255,0.56);">${escapeHtml(this.statusMessage)}</div>` : ''}
          ${this.searchResults.length > 0 ? renderSearchResults(this.searchResults, trackedEventIds) : ''}
        </section>

        <section style="display:grid;gap:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Tracked Fixtures</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.46);">${this.trackedFixtures.length}/${MAX_TRACKED_FIXTURES}</div>
          </div>
          ${this.isRefreshingTracked ? '<div style="font-size:11px;color:rgba(255,255,255,0.5);">Refreshing live fixture stats...</div>' : ''}
          ${trackedCards || '<div style="font-size:12px;color:rgba(255,255,255,0.58);border:1px dashed rgba(255,255,255,0.16);border-radius:10px;padding:12px;">No fixtures tracked yet. Search a match above and click <strong>Track</strong>.</div>'}
        </section>
      </div>
    `);
  }
}
