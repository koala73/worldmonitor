import {
    fetchAirportOpsSummary,
    fetchAirportFlights,
    fetchCarrierOps,
    fetchAircraftPositions,
    fetchFlightPrices,
    fetchAviationNews,
    isPriceExpired,
    type AirportOpsSummary,
    type FlightInstance,
    type CarrierOps,
    type PositionSample,
    type PriceQuote,
    type AviationNewsItem,
    type FlightDelaySeverity,
} from '@/services/aviation';
import { aviationWatchlist } from '@/services/aviation/watchlist';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { Panel } from './Panel';

// ---- Helpers ----

const SEVERITY_COLOR: Record<FlightDelaySeverity, string> = {
    normal: 'var(--color-success, #22c55e)',
    minor: '#f59e0b',
    moderate: '#f97316',
    major: '#ef4444',
    severe: '#dc2626',
};

const STATUS_BADGE: Record<string, string> = {
    scheduled: '#6b7280', boarding: '#3b82f6', departed: '#8b5cf6',
    airborne: '#22c55e', landed: '#14b8a6', arrived: '#0ea5e9',
    cancelled: '#ef4444', diverted: '#f59e0b', unknown: '#6b7280',
};

function fmt(n: number | null | undefined): string { return n == null ? '—' : String(Math.round(n)); }
function fmtTime(dt: Date | null | undefined): string {
    if (!dt) return '—';
    return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtMin(m: number): string {
    if (!m) return '—';
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function expCountdown(exp: Date | null, now: number): string {
    if (!exp) return '';
    const ms = exp.getTime() - now;
    if (ms <= 0) return '<span style="color:#ef4444;font-size:10px">EXPIRED</span>';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const color = h < 1 ? '#f97316' : '#6b7280';
    return `<span style="font-size:10px;color:${color}">exp ${h > 0 ? `${h}h ` : ''}${m}m</span>`;
}

const TABS = ['ops', 'flights', 'airlines', 'tracking', 'news', 'prices'] as const;
type Tab = typeof TABS[number];

const TAB_LABELS: Record<Tab, string> = {
    ops: '🛫 Ops', flights: '✈️ Flights', airlines: '🏢 Airlines',
    tracking: '📡 Track', news: '📰 News', prices: '💸 Prices',
};

// ---- Panel class ----

export class AirlineIntelPanel extends Panel {
    private activeTab: Tab = 'ops';
    private airports: string[];
    private opsData: AirportOpsSummary[] = [];
    private flightsData: FlightInstance[] = [];
    private carriersData: CarrierOps[] = [];
    private trackingData: PositionSample[] = [];
    private newsData: AviationNewsItem[] = [];
    private pricesData: PriceQuote[] = [];
    private pricesProvider = 'demo';
    private pricesOrigin = 'IST';
    private pricesDest = 'LHR';
    private pricesDep = '';
    private pricesCurrency = 'usd';
    private loading = false;
    private refreshTimer: ReturnType<typeof setInterval> | null = null;
    private liveIndicator!: HTMLElement;
    private tabBar!: HTMLElement;

    constructor() {
        super({ id: 'airline-intel', title: t('panels.airlineIntel'), trackActivity: true });

        const wl = aviationWatchlist.get();
        this.airports = wl.airports.slice(0, 8);

        // Add refresh button to header
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'icon-btn';
        refreshBtn.title = t('common.refresh');
        refreshBtn.textContent = '↻';
        refreshBtn.addEventListener('click', () => this.refresh());
        this.header.appendChild(refreshBtn);

        // Add LIVE indicator badge to the title
        this.liveIndicator = document.createElement('span');
        this.liveIndicator.className = 'live-badge';
        this.liveIndicator.textContent = '\u25CF LIVE';
        this.liveIndicator.style.cssText = 'display:none;color:#22c55e;font-size:10px;font-weight:700;margin-left:8px;letter-spacing:0.5px;';
        this.header.querySelector('.panel-title')?.appendChild(this.liveIndicator);

        // Insert tab bar between header and content
        this.tabBar = document.createElement('div');
        this.tabBar.className = 'panel-tabs';
        TABS.forEach(tab => {
            const btn = document.createElement('button');
            btn.className = `panel-tab${tab === this.activeTab ? ' active' : ''}`;
            btn.textContent = TAB_LABELS[tab];
            btn.dataset.tab = tab;
            btn.addEventListener('click', () => this.switchTab(tab as Tab));
            this.tabBar.appendChild(btn);
        });
        this.element.insertBefore(this.tabBar, this.content);

        // Add styling class to inherited content div
        this.content.classList.add('airline-intel-content');

        // Event delegation on stable content element (survives innerHTML replacements)
        this.content.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.id === 'priceSearchBtn' || target.closest('#priceSearchBtn')) {
                this.pricesOrigin = ((this.content.querySelector('#priceFromInput') as HTMLInputElement)?.value || 'IST').toUpperCase();
                this.pricesDest = ((this.content.querySelector('#priceToInput') as HTMLInputElement)?.value || 'LHR').toUpperCase();
                this.pricesDep = (this.content.querySelector('#priceDepInput') as HTMLInputElement)?.value || '';
                this.pricesCurrency = (this.content.querySelector('#priceCurrencySelect') as HTMLSelectElement)?.value || 'usd';
                void this.loadTab('prices');
            }
        });

        void this.refresh();

        // Auto-refresh every 5 min — refresh() loads ops + active tab
        this.refreshTimer = setInterval(() => void this.refresh(), 5 * 60_000);
    }

    toggle(visible: boolean): void {
        this.element.style.display = visible ? '' : 'none';
    }

    destroy(): void {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        super.destroy();
    }

    /** Called by the map when new aircraft positions arrive. */
    updateLivePositions(positions: PositionSample[]): void {
        this.trackingData = positions;
        if (this.activeTab === 'tracking') this.renderTab();
    }

    /** Toggle the LIVE indicator badge. */
    setLiveMode(active: boolean): void {
        this.liveIndicator.style.display = active ? '' : 'none';
    }

    private switchTab(tab: Tab): void {
        this.activeTab = tab;
        this.tabBar.querySelectorAll('.panel-tab').forEach(b => {
            b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab);
        });
        this.renderTab();
        if ((tab === 'ops' && !this.opsData.length) ||
            (tab === 'flights' && !this.flightsData.length) ||
            (tab === 'airlines' && !this.carriersData.length) ||
            (tab === 'tracking' && !this.trackingData.length) ||
            (tab === 'news' && !this.newsData.length) ||
            (tab === 'prices' && !this.pricesData.length)) {
            void this.loadTab(tab);
        }
    }

    private async refresh(): Promise<void> {
        void this.loadOps();
        void this.loadTab(this.activeTab);
    }

    private async loadOps(): Promise<void> {
        this.opsData = await fetchAirportOpsSummary(this.airports);
        if (this.activeTab === 'ops') this.renderTab();
    }

    private async loadTab(tab: Tab): Promise<void> {
        this.loading = true;
        this.renderTab();
        try {
            switch (tab) {
                case 'ops':
                    this.opsData = await fetchAirportOpsSummary(this.airports);
                    break;
                case 'flights':
                    this.flightsData = await fetchAirportFlights(this.airports[0] ?? 'IST', 'both', 30);
                    break;
                case 'airlines':
                    this.carriersData = await fetchCarrierOps(this.airports);
                    break;
                case 'tracking':
                    this.trackingData = await fetchAircraftPositions({});
                    break;
                case 'news': {
                    const entities = [...this.airports, ...aviationWatchlist.get().airlines];
                    this.newsData = await fetchAviationNews(entities, 24, 20);
                    break;
                }
                case 'prices': {
                    const dep = this.pricesDep || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
                    const result = await fetchFlightPrices({
                        origin: this.pricesOrigin, destination: this.pricesDest,
                        departureDate: dep, currency: this.pricesCurrency,
                    });
                    this.pricesData = result.quotes;
                    this.pricesProvider = result.provider;
                    break;
                }
            }
        } catch { /* silent */ }
        this.loading = false;
        this.renderTab();
    }

    private renderLoading(): void {
        this.content.innerHTML = `<div class="panel-loading">${t('common.loading')}</div>`;
    }

    private renderTab(): void {
        if (this.loading) { this.renderLoading(); return; }
        switch (this.activeTab) {
            case 'ops': this.renderOps(); break;
            case 'flights': this.renderFlights(); break;
            case 'airlines': this.renderAirlines(); break;
            case 'tracking': this.renderTracking(); break;
            case 'news': this.renderNews(); break;
            case 'prices': this.renderPrices(); break;
        }
    }

    // ---- Ops tab ----
    private renderOps(): void {
        if (!this.opsData.length) {
            this.content.innerHTML = `<div class="no-data">${t('components.airlineIntel.noOpsData')}</div>`;
            return;
        }
        const rows = this.opsData.map(s => `
      <div class="ops-row">
        <div class="ops-iata">${escapeHtml(s.iata)}</div>
        <div class="ops-name">${escapeHtml(s.name || s.iata)}</div>
        <div class="ops-severity" style="color:${SEVERITY_COLOR[s.severity] ?? '#aaa'}">${s.severity.toUpperCase()}</div>
        <div class="ops-delay">${s.avgDelayMinutes > 0 ? `+${s.avgDelayMinutes}m` : '—'}</div>
        <div class="ops-cancel">${s.cancellationRate > 0 ? `${s.cancellationRate.toFixed(1)}% cxl` : ''}</div>
        ${s.closureStatus ? '<div class="ops-closed">CLOSED</div>' : ''}
        ${s.notamFlags.length ? `<div class="ops-notam">⚠️ NOTAM</div>` : ''}
      </div>`).join('');
        this.content.innerHTML = `<div class="ops-grid">${rows}</div>`;
    }

    // ---- Flights tab ----
    private renderFlights(): void {
        if (!this.flightsData.length) {
            this.content.innerHTML = `<div class="no-data">${t('components.airlineIntel.noFlights')}</div>`;
            return;
        }
        const rows = this.flightsData.map(f => {
            const color = STATUS_BADGE[f.status] ?? '#6b7280';
            return `
        <div class="flight-row">
          <div class="flight-num">${escapeHtml(f.flightNumber)}</div>
          <div class="flight-route">${escapeHtml(f.origin.iata)} → ${escapeHtml(f.destination.iata)}</div>
          <div class="flight-time">${fmtTime(f.scheduledDeparture)}</div>
          <div class="flight-delay" style="color:${f.delayMinutes > 0 ? '#f97316' : '#aaa'}">${f.delayMinutes > 0 ? `+${f.delayMinutes}m` : ''}</div>
          <div class="flight-status" style="color:${color}">${f.status}</div>
        </div>`;
        }).join('');
        this.content.innerHTML = `<div class="flights-list">${rows}</div>`;
    }

    // ---- Airlines tab ----
    private renderAirlines(): void {
        if (!this.carriersData.length) {
            this.content.innerHTML = `<div class="no-data">${t('components.airlineIntel.noCarrierData')}</div>`;
            return;
        }
        const rows = this.carriersData.slice(0, 15).map(c => `
      <div class="carrier-row">
        <div class="carrier-name">${escapeHtml(c.carrierName || c.carrierIata)}</div>
        <div class="carrier-flights">${c.totalFlights} flt</div>
        <div class="carrier-delay" style="color:${c.delayPct > 30 ? '#ef4444' : '#aaa'}">${c.delayPct.toFixed(1)}% delayed</div>
        <div class="carrier-cancel">${c.cancellationRate.toFixed(1)}% cxl</div>
      </div>`).join('');
        this.content.innerHTML = `<div class="carriers-list">${rows}</div>`;
    }

    // ---- Tracking tab ----
    private renderTracking(): void {
        if (!this.trackingData.length) {
            this.content.innerHTML = `<div class="no-data">${t('components.airlineIntel.noTrackingData')}</div>`;
            return;
        }
        const rows = this.trackingData.slice(0, 20).map(p => `
      <div class="track-row">
        <div class="track-cs">${escapeHtml(p.callsign || p.icao24)}</div>
        <div class="track-alt">${fmt(p.altitudeFt)} ft</div>
        <div class="track-spd">${fmt(p.groundSpeedKts)} kts</div>
        <div class="track-pos">${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</div>
      </div>`).join('');
        this.content.innerHTML = `<div class="tracking-list">${rows}</div>`;
    }

    // ---- News tab ----
    private renderNews(): void {
        if (!this.newsData.length) {
            this.content.innerHTML = `<div class="no-data">${t('components.airlineIntel.noNews')}</div>`;
            return;
        }
        const items = this.newsData.map(n => `
      <div class="news-item" style="padding:8px 0;border-bottom:1px solid var(--border,#2a2a2a)">
        <a href="${sanitizeUrl(n.url)}" target="_blank" rel="noopener" class="news-link">${escapeHtml(n.title)}</a>
        <div class="news-meta" style="font-size:11px;color:var(--text-dim,#888);margin-top:2px">${escapeHtml(n.sourceName)} · ${n.publishedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>`).join('');
        this.content.innerHTML = `<div class="news-list" style="padding:0 4px">${items}</div>`;
    }

    // ---- Prices tab ----
    private renderPrices(): void {
        const provider = this.pricesProvider;
        const providerBadge = provider === 'travelpayouts_data'
            ? `<span class="tp-badge">${t('components.airlineIntel.cachedInsight')} · Travelpayouts</span>`
            : `<span class="demo-badge">${t('components.airlineIntel.demoMode')}</span>`;

        const searchForm = `
      <div class="price-controls" style="display:flex;gap:6px;flex-wrap:wrap;padding:8px 0;align-items:center">
        <input id="priceFromInput" class="price-input" placeholder="From" maxlength="3" value="${escapeHtml(this.pricesOrigin)}" style="width:54px">
        <span style="color:#6b7280">\u2192</span>
        <input id="priceToInput" class="price-input" placeholder="To" maxlength="3" value="${escapeHtml(this.pricesDest)}" style="width:54px">
        <input id="priceDepInput" class="price-input" type="date" value="${escapeHtml(this.pricesDep)}" style="width:128px">
        <select id="priceCurrencySelect" class="price-input" style="width:58px">
          <option value="usd"${this.pricesCurrency === 'usd' ? ' selected' : ''}>USD</option>
          <option value="eur"${this.pricesCurrency === 'eur' ? ' selected' : ''}>EUR</option>
          <option value="try"${this.pricesCurrency === 'try' ? ' selected' : ''}>TRY</option>
          <option value="gbp"${this.pricesCurrency === 'gbp' ? ' selected' : ''}>GBP</option>
        </select>
        <button id="priceSearchBtn" class="icon-btn" style="padding:4px 10px">${t('common.search')}</button>
      </div>
      <div style="margin-bottom:6px">${providerBadge}<span style="font-size:10px;color:#6b7280;margin-left:6px">${t('components.airlineIntel.pricesIndicative')}</span></div>`;

        if (!this.pricesData.length) {
            this.content.innerHTML = `${searchForm}<div class="no-data">${t('components.airlineIntel.enterRoute')}</div>`;
        } else {
            const now = Date.now();
            const active = this.pricesData.filter(q => !isPriceExpired(q));
            const expired = this.pricesData.filter(q => isPriceExpired(q));
            const sorted = [...active, ...expired];

            const rows = sorted.map(q => {
                const exp = isPriceExpired(q);
                const currency = q.currency || this.pricesCurrency.toUpperCase();
                return `
          <div class="price-row" style="${exp ? 'opacity:0.4;' : ''}">
            <div class="price-carrier">${escapeHtml(q.carrierName || q.carrierIata || '\u2014')}</div>
            <div class="price-route" style="flex:1">${escapeHtml(q.origin)} \u2192 ${escapeHtml(q.destination)}</div>
            <div class="price-amount" style="font-weight:700;color:${exp ? '#6b7280' : 'var(--accent,#60a5fa)'}">${currency} ${Math.round(q.priceAmount)}</div>
            <div class="price-dur">${fmtMin(q.durationMinutes)}</div>
            <div class="price-stops">${q.stops === 0 ? 'nonstop' : `${q.stops} stop`}</div>
            ${expCountdown(q.expiresAt, now)}
          </div>`;
            }).join('');
            this.content.innerHTML = `${searchForm}<div class="prices-list">${rows}</div>`;
        }

    }

    /* Styles moved to panels.css (PERF-012) */
}
