import { Panel } from './Panel';
import { fetchSportsPlayerDetails, fetchSportsPlayerSearch, type SportsPlayerDetails, type SportsPlayerSearchResult } from '@/services/sports';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { renderSportsBadge } from './sportsPanelShared';

const PLAYER_QUERY_KEY = 'wm-sports-player-query';
const PLAYER_ID_KEY = 'wm-sports-player-id';

type PlayerCard = {
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
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Ignore persistence failures.
  }
}

function formatDate(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function computeAge(value?: string): string | undefined {
  if (!value) return undefined;
  const birthDate = new Date(value);
  if (Number.isNaN(birthDate.getTime())) return undefined;
  const now = new Date();
  let age = now.getFullYear() - birthDate.getFullYear();
  const beforeBirthday = now.getMonth() < birthDate.getMonth()
    || (now.getMonth() === birthDate.getMonth() && now.getDate() < birthDate.getDate());
  if (beforeBirthday) age -= 1;
  return age > 0 ? `${age}` : undefined;
}

function buildPlayerCards(player: SportsPlayerDetails): PlayerCard[] {
  const age = computeAge(player.birthDate);
  const born = [formatDate(player.birthDate), age ? `${age} yrs` : ''].filter(Boolean).join(' · ');

  return [
    { label: 'Sport', value: player.sport || '—', detail: player.position || 'Position' },
    { label: 'Team', value: player.team || '—', detail: player.secondaryTeam || 'Current club/team' },
    { label: 'Nationality', value: player.nationality || '—', detail: player.birthLocation || 'Birthplace' },
    { label: 'Status', value: player.status || '—', detail: player.number ? `No. ${player.number}` : 'Roster status' },
    { label: 'Born', value: born || '—', detail: player.gender || 'Player profile' },
    { label: 'Physical', value: [player.height, player.weight].filter(Boolean).join(' · ') || '—', detail: player.handedness || 'Height / weight' },
    { label: 'Signed', value: formatDate(player.signedDate) || '—', detail: player.signing || player.agent || 'Contract / agent' },
    { label: 'Outfitter', value: player.outfitter || '—', detail: player.kit || 'Equipment' },
  ].filter((card) => card.value !== '—' || card.detail);
}

function normalizeExternalUrl(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^@/, '')}`;
  const sanitized = sanitizeUrl(withProtocol);
  return sanitized === '#' ? null : sanitized;
}

function buildPlayerLinks(player: SportsPlayerDetails): Array<{ label: string; url: string }> {
  const entries = [
    ['Website', normalizeExternalUrl(player.website)],
    ['Facebook', normalizeExternalUrl(player.facebook)],
    ['X', normalizeExternalUrl(player.twitter)],
    ['Instagram', normalizeExternalUrl(player.instagram)],
    ['YouTube', normalizeExternalUrl(player.youtube)],
  ] as const;

  const links: Array<{ label: string; url: string }> = [];
  for (const [label, url] of entries) {
    if (!url) continue;
    links.push({ label, url });
  }
  return links;
}

function buildPlayerDescription(player: SportsPlayerDetails): string {
  const description = (player.description || '').trim();
  if (!description) return '';
  return description.length > 520 ? `${description.slice(0, 517)}...` : description;
}

function renderPlayerImage(player: SportsPlayerDetails): string {
  const imageUrl = sanitizeUrl(player.cutout || player.thumb || player.banner || player.fanart || '');
  if (imageUrl && imageUrl !== '#') {
    return `
      <div style="width:88px;height:88px;border-radius:18px;overflow:hidden;background:rgba(255,255,255,0.06);flex:0 0 88px;">
        <img src="${imageUrl}" alt="${escapeHtml(player.name)}" style="width:100%;height:100%;object-fit:cover;display:block;" loading="lazy" />
      </div>
    `;
  }

  return renderSportsBadge(player.name, undefined, 88);
}

function renderSearchResults(results: SportsPlayerSearchResult[], selectedPlayerId: string): string {
  if (!results.length) return '';

  return `
    <section style="display:grid;gap:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Matches</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.46);">${results.length} result${results.length === 1 ? '' : 's'}</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;">
        ${results.map((player) => `
          <button
            type="button"
            data-action="player-select"
            data-player-id="${escapeHtml(player.id)}"
            style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:center;padding:10px 12px;border-radius:12px;border:1px solid ${player.id === selectedPlayerId ? 'rgba(59,130,246,0.48)' : 'rgba(255,255,255,0.08)'};background:${player.id === selectedPlayerId ? 'rgba(59,130,246,0.10)' : 'rgba(255,255,255,0.03)'};color:inherit;text-align:left;cursor:pointer;"
          >
            ${renderSportsBadge(player.name, player.thumb || player.cutout, 38)}
            <span style="display:grid;gap:3px;min-width:0;">
              <span style="font-size:13px;font-weight:700;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(player.name)}</span>
              <span style="font-size:11px;color:rgba(255,255,255,0.54);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml([player.team, player.sport].filter(Boolean).join(' · ') || player.nationality || 'Profile')}</span>
            </span>
          </button>
        `).join('')}
      </div>
    </section>
  `;
}

function renderPlayerProfile(player: SportsPlayerDetails): string {
  const cards = buildPlayerCards(player);
  const links = buildPlayerLinks(player);
  const description = buildPlayerDescription(player);
  const pills = [player.sport, player.team, player.secondaryTeam, player.position, player.nationality]
    .filter((value): value is string => !!value)
    .slice(0, 5);

  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;background:linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));display:grid;gap:12px;">
      <div style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:center;">
        ${renderPlayerImage(player)}
        <div style="display:grid;gap:6px;min-width:0;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Player Profile</div>
          <div style="font-size:22px;font-weight:800;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(player.name)}</div>
          ${player.alternateName ? `<div style="font-size:12px;color:rgba(255,255,255,0.58);">${escapeHtml(player.alternateName)}</div>` : ''}
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${pills.map((pill) => `
              <span style="display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;background:rgba(255,255,255,0.05);font-size:11px;color:rgba(255,255,255,0.72);">
                ${escapeHtml(pill)}
              </span>
            `).join('')}
          </div>
        </div>
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

      ${description ? `
        <div style="display:grid;gap:6px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Bio</div>
          <div style="font-size:12px;line-height:1.7;color:rgba(255,255,255,0.72);">${escapeHtml(description)}</div>
        </div>
      ` : ''}

      ${links.length ? `
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${links.map((link) => `
            <a href="${link.url}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);font-size:11px;color:rgba(255,255,255,0.76);text-decoration:none;">
              ${escapeHtml(link.label)}
            </a>
          `).join('')}
        </div>
      ` : ''}
    </section>
  `;
}

export class SportsPlayerSearchPanel extends Panel {
  private query = loadStored(PLAYER_QUERY_KEY);
  private selectedPlayerId = loadStored(PLAYER_ID_KEY);
  private searchResults: SportsPlayerSearchResult[] = [];
  private selectedPlayer: SportsPlayerDetails | null = null;
  private isLoading = false;
  private statusMessage = '';
  private errorMessage = '';
  private loadToken = 0;

  constructor() {
    super({
      id: 'sports-player-search',
      title: 'Player Search',
      showCount: true,
      className: 'panel-wide',
      defaultRowSpan: 4,
      infoTooltip: 'Search any player across football, basketball, motorsport, baseball, and more to load profile stats and bio data.',
    });

    this.content.addEventListener('submit', (event) => {
      const form = (event.target as HTMLElement).closest('form[data-action="player-search"]') as HTMLFormElement | null;
      if (!form) return;
      event.preventDefault();
      const input = form.querySelector('input[name="player-query"]') as HTMLInputElement | null;
      void this.searchPlayers(input?.value || '');
    });

    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const button = target.closest('button[data-action="player-select"]') as HTMLButtonElement | null;
      const playerId = button?.dataset.playerId;
      if (!playerId || playerId === this.selectedPlayerId) return;
      void this.loadPlayer(playerId);
    });
  }

  public async fetchData(): Promise<boolean> {
    if (this.query) {
      return this.searchPlayers(this.query, this.selectedPlayerId || undefined);
    }
    if (this.selectedPlayerId) {
      return this.loadPlayer(this.selectedPlayerId);
    }
    this.setCount(0);
    this.renderPanel();
    return true;
  }

  private async searchPlayers(rawQuery: string, preferredPlayerId?: string): Promise<boolean> {
    const trimmedQuery = rawQuery.trim();
    this.query = trimmedQuery;
    saveStored(PLAYER_QUERY_KEY, trimmedQuery);
    this.errorMessage = '';
    this.statusMessage = '';

    if (!trimmedQuery) {
      this.searchResults = [];
      this.selectedPlayer = null;
      this.selectedPlayerId = '';
      saveStored(PLAYER_ID_KEY, '');
      this.setCount(0);
      this.renderPanel();
      return true;
    }

    const token = ++this.loadToken;
    this.isLoading = true;
    this.renderPanel();

    try {
      const results = await fetchSportsPlayerSearch(trimmedQuery);
      if (token !== this.loadToken) return false;

      this.searchResults = results;
      this.setCount(results.length);

      if (!results.length) {
        this.selectedPlayer = null;
        this.selectedPlayerId = '';
        saveStored(PLAYER_ID_KEY, '');
        this.isLoading = false;
        this.statusMessage = `No players found for "${trimmedQuery}".`;
        this.renderPanel();
        return false;
      }

      const fallbackPlayer = results[0];
      if (!fallbackPlayer) {
        this.selectedPlayer = null;
        this.selectedPlayerId = '';
        saveStored(PLAYER_ID_KEY, '');
        this.isLoading = false;
        this.statusMessage = `No players found for "${trimmedQuery}".`;
        this.renderPanel();
        return false;
      }

      const nextPlayerId = preferredPlayerId && results.some((player) => player.id === preferredPlayerId)
        ? preferredPlayerId
        : fallbackPlayer.id;

      return this.loadPlayer(nextPlayerId, token);
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.isLoading = false;
      this.selectedPlayer = null;
      this.errorMessage = 'Failed to search players.';
      this.renderPanel();
      return false;
    }
  }

  private async loadPlayer(playerId: string, existingToken?: number): Promise<boolean> {
    const token = existingToken ?? ++this.loadToken;
    this.selectedPlayerId = playerId;
    saveStored(PLAYER_ID_KEY, playerId);
    this.errorMessage = '';
    this.statusMessage = '';
    this.isLoading = true;
    this.renderPanel();

    try {
      const player = await fetchSportsPlayerDetails(playerId);
      if (token !== this.loadToken) return false;

      this.isLoading = false;
      if (!player) {
        this.selectedPlayer = null;
        this.errorMessage = 'Player details are unavailable right now.';
        this.renderPanel();
        return false;
      }

      this.selectedPlayer = player;
      this.renderPanel();
      return true;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      this.isLoading = false;
      this.selectedPlayer = null;
      this.errorMessage = 'Failed to load player details.';
      this.renderPanel();
      return false;
    }
  }

  private renderPanel(): void {
    const intro = this.query
      ? `Search results for ${this.query}. Pick any player to load the latest open profile data.`
      : 'Search any player in the world across major sports. The panel loads profile stats, team info, and biography data from the open sports directory.';

    this.setContent(`
      <div style="display:grid;gap:10px;padding:2px 2px 8px;">
        <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
          <div style="display:grid;gap:4px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">Player Finder</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.56);">${escapeHtml(intro)}</div>
          </div>
          <form data-action="player-search" style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;">
            <input
              type="text"
              name="player-query"
              value="${escapeHtml(this.query)}"
              placeholder="Search Lionel Messi, LeBron James, Max Verstappen..."
              style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:inherit;border-radius:10px;padding:10px 12px;font:inherit;"
            />
            <button type="submit" style="padding:10px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.10);background:rgba(59,130,246,0.18);color:#bfdbfe;font:inherit;font-weight:700;cursor:pointer;">
              Search
            </button>
          </form>
          ${this.isLoading ? '<div style="font-size:12px;color:rgba(255,255,255,0.56);">Loading player data...</div>' : ''}
          ${this.errorMessage ? `<div style="font-size:12px;color:#fca5a5;">${escapeHtml(this.errorMessage)}</div>` : ''}
          ${this.statusMessage ? `<div style="font-size:12px;color:rgba(255,255,255,0.60);">${escapeHtml(this.statusMessage)}</div>` : ''}
        </section>

        ${renderSearchResults(this.searchResults, this.selectedPlayerId)}
        ${this.selectedPlayer ? renderPlayerProfile(this.selectedPlayer) : ''}
      </div>
    `);
  }
}
