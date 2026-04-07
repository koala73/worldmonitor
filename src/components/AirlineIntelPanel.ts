import {
    fetchAirportOpsSummary,
    fetchAirportFlights,
    fetchCarrierOps,
    fetchAircraftPositions,
    fetchFlightStatus,
    fetchAviationNews,
    fetchGoogleFlights,
    fetchGoogleDates,
    type AirportOpsSummary,
    type FlightInstance,
    type CarrierOps,
    type PositionSample,
    type AviationNewsItem,
    type FlightDelaySeverity,
    type GoogleFlightItinerary,
    type DatePrice,
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
function localDateStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const TABS = ['ops', 'flights', 'airlines', 'tracking', 'news', 'prices'] as const;
type Tab = typeof TABS[number];

const TAB_LABELS: Record<Tab, string> = {
    ops: 'Ops', flights: 'Flights', airlines: 'Airlines',
    tracking: 'Track', news: 'News', prices: 'Prices',
};

// ---- Panel class ----

export class AirlineIntelPanel extends Panel {
    private activeTab: Tab = 'ops';
    private airports: string[];
    private opsData: AirportOpsSummary[] = [];
    private flightsData: FlightInstance[] = [];
    private carriersData: CarrierOps[] = [];
    private trackingData: PositionSample[] = [];
    private trackingFlightData: FlightInstance[] = [];
    private trackingQuery = '';
    private newsData: AviationNewsItem[] = [];
    private googleFlightsData: GoogleFlightItinerary[] = [];
    private datesData: DatePrice[] = [];
    private pricesMode: 'search' | 'dates' = 'search';
    private pricesCabin = 'ECONOMY';
    private pricesDegraded = false;
    private pricesError = '';
    private pricesOrigin = 'IST';
    private pricesDest = '';
    private pricesDep = '';
    private datesStart = '';
    private datesEnd = '';
    private datesTripDuration = 7;
    private datesRoundTrip = true;
    private loading = false;
    private refreshTimer: ReturnType<typeof setInterval> | null = null;
    private liveIndicator!: HTMLElement;
    private tabBar!: HTMLElement;

    constructor() {
        super({ id: 'airline-intel', title: t('panels.airlineIntel'), trackActivity: true, infoTooltip: t('components.airlineIntel.infoTooltip') });

        const wl = aviationWatchlist.get();
        this.airports = wl.airports.slice(0, 8);

        const firstRoute = wl.routes[0];
        if (firstRoute) {
            const parts = firstRoute.split('-');
            if (parts[0]) this.pricesOrigin = parts[0];
            if (parts[1]) this.pricesDest = parts[1];
        } else {
            this.pricesOrigin = this.airports[0] ?? 'IST';
            this.pricesDest = this.airports[1] ?? '';
        }

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
            const modeBtn = target.closest('[data-price-mode]') as HTMLElement | null;
            if (modeBtn) {
                this.pricesMode = modeBtn.dataset.priceMode as 'search' | 'dates';
                this.pricesError = '';
                this.pricesDegraded = false;
                this.renderTab();
                return;
            }
            if (target.id === 'priceSearchBtn' || target.closest('#priceSearchBtn')) {
                this.handleFlightSearch();
            }
            if (target.id === 'datesSearchBtn' || target.closest('#datesSearchBtn')) {
                this.handleDatesSearch();
            }
            if (target.id === 'trackSearchBtn' || target.closest('#trackSearchBtn')) {
                this.handleTrackSearch();
            }
            if (target.id === 'trackClearBtn' || target.closest('#trackClearBtn')) {
                this.trackingQuery = '';
                this.trackingFlightData = [];
                this.trackingData = [];
                void this.loadTab('tracking');
            }
        });

        this.content.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.target as HTMLElement).id === 'trackQueryInput') {
                this.handleTrackSearch();
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
        if (this.trackingQuery) return; // preserve filtered search results
        this.trackingData = positions;
        if (this.activeTab === 'tracking') this.renderTab();
    }

    /** Toggle the LIVE indicator badge. */
    setLiveMode(active: boolean): void {
        this.liveIndicator.style.display = active ? '' : 'none';
    }

    private handleFlightSearch(): void {
        const origin = ((this.content.querySelector('#priceFromInput') as HTMLInputElement)?.value || '').toUpperCase().trim();
        const dest = ((this.content.querySelector('#priceToInput') as HTMLInputElement)?.value || '').toUpperCase().trim();
        const dep = (this.content.querySelector('#priceDepInput') as HTMLInputElement)?.value || '';
        const cabin = (this.content.querySelector('#priceCabinSelect') as HTMLSelectElement)?.value || 'ECONOMY';
        const errEl = this.content.querySelector('#priceInlineErr') as HTMLElement | null;
        const iataRe = /^[A-Z]{3}$/;
        if (!iataRe.test(origin) || !iataRe.test(dest)) {
            if (errEl) errEl.textContent = 'Enter valid 3-letter IATA codes';
            return;
        }
        const today = localDateStr();
        if (dep && dep < today) {
            if (errEl) errEl.textContent = 'Departure date must be today or future';
            return;
        }
        if (errEl) errEl.textContent = '';
        this.pricesOrigin = origin;
        this.pricesDest = dest;
        this.pricesDep = dep;
        this.pricesCabin = cabin;
        void this.loadTab('prices');
    }

    private handleDatesSearch(): void {
        const origin = ((this.content.querySelector('#datesFromInput') as HTMLInputElement)?.value || '').toUpperCase().trim();
        const dest = ((this.content.querySelector('#datesToInput') as HTMLInputElement)?.value || '').toUpperCase().trim();
        const start = (this.content.querySelector('#datesStartInput') as HTMLInputElement)?.value || '';
        const end = (this.content.querySelector('#datesEndInput') as HTMLInputElement)?.value || '';
        const rt = (this.content.querySelector('#datesRoundTripCheck') as HTMLInputElement)?.checked ?? true;
        const dur = parseInt((this.content.querySelector('#datesTripDurInput') as HTMLInputElement)?.value || '7', 10);
        const cabin = (this.content.querySelector('#datesCabinSelect') as HTMLSelectElement)?.value || 'ECONOMY';
        const errEl = this.content.querySelector('#datesInlineErr') as HTMLElement | null;
        const iataRe = /^[A-Z]{3}$/;
        if (!iataRe.test(origin) || !iataRe.test(dest)) {
            if (errEl) errEl.textContent = 'Enter valid 3-letter IATA codes';
            return;
        }
        if (!start || !end) {
            if (errEl) errEl.textContent = 'Enter start and end dates';
            return;
        }
        if (start < localDateStr()) {
            if (errEl) errEl.textContent = 'Start date must be today or future';
            return;
        }
        if (start >= end) {
            if (errEl) errEl.textContent = 'Start date must be before end date';
            return;
        }
        if (rt && (Number.isNaN(dur) || dur < 1)) {
            if (errEl) errEl.textContent = 'Trip duration must be at least 1 day';
            return;
        }
        const daysDiff = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
        if (errEl) errEl.textContent = daysDiff > 90 ? 'Range exceeds 90 days — results may be incomplete' : '';
        this.pricesOrigin = origin;
        this.pricesDest = dest;
        this.datesStart = start;
        this.datesEnd = end;
        this.datesRoundTrip = rt;
        this.datesTripDuration = Number.isNaN(dur) ? 7 : dur;
        this.pricesCabin = cabin;
        void this.loadTab('prices');
    }

    private handleTrackSearch(): void {
        const q = ((this.content.querySelector('#trackQueryInput') as HTMLInputElement)?.value || '').trim().toUpperCase();
        this.trackingQuery = q;
        this.trackingFlightData = [];
        this.trackingData = [];
        void this.loadTab('tracking');
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
            (tab === 'news' && !this.newsData.length)) {
            void this.loadTab(tab);
        }
        // prices tab: never auto-fetch — only on explicit search button click
    }

    private async refresh(): Promise<void> {
        if (this.activeTab !== 'ops') void this.loadOps();
        if (this.activeTab !== 'prices') void this.loadTab(this.activeTab);
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
                    if (this.trackingQuery) {
                        if (/^[A-Z]{2}\d{1,4}$/.test(this.trackingQuery)) {
                            this.trackingFlightData = await fetchFlightStatus(this.trackingQuery);
                        } else if (/^[0-9A-F]{6}$/i.test(this.trackingQuery)) {
                            this.trackingData = await fetchAircraftPositions({ icao24: this.trackingQuery.toLowerCase() });
                        } else {
                            this.trackingData = await fetchAircraftPositions({ callsign: this.trackingQuery });
                        }
                    } else {
                        this.trackingData = await fetchAircraftPositions({});
                    }
                    break;
                case 'news': {
                    const entities = [...this.airports, ...aviationWatchlist.get().airlines];
                    this.newsData = await fetchAviationNews(entities, 24, 20);
                    break;
                }
                case 'prices': {
                    if (this.pricesMode === 'dates') {
                        const r = await fetchGoogleDates({
                            origin: this.pricesOrigin, destination: this.pricesDest,
                            startDate: this.datesStart, endDate: this.datesEnd,
                            tripDuration: this.datesTripDuration, isRoundTrip: this.datesRoundTrip,
                            cabinClass: this.pricesCabin,
                        });
                        this.datesData = r.dates;
                        this.pricesDegraded = r.degraded;
                        this.pricesError = r.error;
                    } else {
                        const dep = this.pricesDep || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
                        const r = await fetchGoogleFlights({
                            origin: this.pricesOrigin, destination: this.pricesDest,
                            departureDate: dep, cabinClass: this.pricesCabin,
                        });
                        this.googleFlightsData = r.flights;
                        this.pricesDegraded = r.degraded;
                        this.pricesError = r.error;
                    }
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
        const clearBtn = this.trackingQuery
            ? `<button id="trackClearBtn" class="icon-btn" style="padding:4px 8px;color:#9ca3af" title="Back to live feed">×</button>`
            : '';
        const searchBar = `
      <div class="track-search" style="display:flex;gap:6px;padding:8px 0 6px">
        <input id="trackQueryInput" class="price-input" placeholder="Flight (EK3) or callsign (UAE3)" value="${escapeHtml(this.trackingQuery)}" style="flex:1;min-width:0">
        ${clearBtn}<button id="trackSearchBtn" class="icon-btn" style="padding:4px 10px">Track</button>
      </div>`;

        if (this.loading) {
            this.content.innerHTML = `${searchBar}<div class="panel-loading">${t('common.loading')}</div>`;
            return;
        }

        // Flight status results (searched by IATA flight number)
        if (this.trackingFlightData.length) {
            const rows = this.trackingFlightData.map(f => {
                const depStr = f.estimatedDeparture
                    ? `Dep ${fmtTime(f.estimatedDeparture)}`
                    : '';
                const arrStr = f.estimatedArrival
                    ? ` · Arr ${fmtTime(f.estimatedArrival)}`
                    : '';
                const color = STATUS_BADGE[f.status] ?? '#6b7280';
                return `
          <div class="track-flight-card" style="padding:8px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;gap:8px;align-items:baseline">
              <strong>${escapeHtml(f.flightNumber)}</strong>
              <span style="color:#9ca3af;font-size:11px">${escapeHtml(f.carrier.name || f.carrier.iata)}</span>
              <span style="color:${color};font-size:11px;margin-left:auto">${f.status}</span>
            </div>
            <div style="font-size:12px;color:var(--text-dim)">${escapeHtml(f.origin.iata)} → ${escapeHtml(f.destination.iata)}${depStr ? ` · ${depStr}` : ''}${arrStr}</div>
            ${f.aircraftType ? `<div style="font-size:11px;color:#6b7280">${escapeHtml(f.aircraftType)}</div>` : ''}
            ${(f.gate || f.terminal) ? `<div style="font-size:11px;color:#6b7280">${f.gate ? `Gate ${escapeHtml(f.gate)}` : ''}${f.terminal ? `${f.gate ? ' · ' : ''}T${escapeHtml(f.terminal)}` : ''}</div>` : ''}
            ${f.delayMinutes > 0 ? `<div style="color:#f97316;font-size:12px">+${f.delayMinutes}m delay</div>` : ''}
          </div>`;
            }).join('');
            this.content.innerHTML = `${searchBar}<div>${rows}</div>`;
            return;
        }

        // Position results (searched by callsign/ICAO24 or default global fetch)
        if (this.trackingData.length) {
            const rows = this.trackingData.slice(0, 20).map(p => `
        <div class="track-row">
          <div class="track-cs">${escapeHtml(p.callsign || p.icao24)}</div>
          <div class="track-alt">${fmt(p.altitudeFt)} ft</div>
          <div class="track-spd">${fmt(p.groundSpeedKts)} kts</div>
          <div class="track-pos">${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</div>
        </div>`).join('');
            this.content.innerHTML = `${searchBar}<div class="tracking-list">${rows}</div>`;
            return;
        }

        const emptyMsg = this.trackingQuery
            ? `<div class="no-data">No results for <strong>${escapeHtml(this.trackingQuery)}</strong>.</div>`
            : `<div class="no-data">${t('components.airlineIntel.noTrackingData')}</div>`;
        this.content.innerHTML = `${searchBar}${emptyMsg}`;
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
        const isSearch = this.pricesMode === 'search';
        const toggle = `
      <div class="price-mode-toggle">
        <button class="price-mode-btn${isSearch ? ' active' : ''}" data-price-mode="search">${escapeHtml(t('components.airlineIntel.searchFlights'))}</button>
        <button class="price-mode-btn${!isSearch ? ' active' : ''}" data-price-mode="dates">${escapeHtml(t('components.airlineIntel.bestDates'))}</button>
      </div>`;

        const degradedBanner = this.pricesDegraded
            ? `<div class="gf-degraded">${escapeHtml(t('components.airlineIntel.degradedResults'))}</div>`
            : '';

        if (isSearch) {
            const dep = this.pricesDep || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
            const form = `
        <div class="price-controls">
          <input id="priceFromInput" class="price-input" placeholder="From" maxlength="3" value="${escapeHtml(this.pricesOrigin)}" style="width:54px">
          <span style="color:#6b7280">\u2192</span>
          <input id="priceToInput" class="price-input" placeholder="To" maxlength="3" value="${escapeHtml(this.pricesDest)}" style="width:54px">
          <input id="priceDepInput" class="price-input" type="date" value="${escapeHtml(dep)}" style="width:128px">
          <select id="priceCabinSelect" class="price-input" style="width:110px">
            <option value="ECONOMY"${this.pricesCabin === 'ECONOMY' ? ' selected' : ''}>Economy</option>
            <option value="PREMIUM_ECONOMY"${this.pricesCabin === 'PREMIUM_ECONOMY' ? ' selected' : ''}>Premium Economy</option>
            <option value="BUSINESS"${this.pricesCabin === 'BUSINESS' ? ' selected' : ''}>Business</option>
            <option value="FIRST"${this.pricesCabin === 'FIRST' ? ' selected' : ''}>First</option>
          </select>
          <button id="priceSearchBtn" class="icon-btn" style="padding:4px 10px">${t('header.search')}</button>
        </div>
        <div id="priceInlineErr" style="color:#ef4444;font-size:11px;min-height:14px"></div>`;

            let body: string;
            if (this.googleFlightsData.length) {
                const cards = this.googleFlightsData.map(it => {
                    const stops = it.stops === 0
                        ? t('components.airlineIntel.nonstop')
                        : `${it.stops} stop`;
                    const legs = it.legs.map(leg => `
              <div class="gf-leg">
                <span class="gf-airline">${escapeHtml(leg.airlineCode)} ${escapeHtml(leg.flightNumber)}</span>
                <span>${escapeHtml(leg.departureAirport)} ${escapeHtml(leg.departureDatetime.slice(11, 16))}</span>
                <span>\u2192</span>
                <span>${escapeHtml(leg.arrivalAirport)} ${escapeHtml(leg.arrivalDatetime.slice(11, 16))}</span>
                <span class="gf-dur">(${fmtMin(leg.durationMinutes)})</span>
              </div>`).join('');
                    return `
            <div class="gf-card">
              <div class="gf-summary">
                <span class="gf-price">${Math.round(it.price).toLocaleString()}</span>
                <span class="gf-total-dur">${fmtMin(it.durationMinutes)}</span>
                <span class="gf-stops">${escapeHtml(stops)}</span>
              </div>
              ${legs}
            </div>`;
                }).join('');
                body = `<div class="gf-list">${cards}</div>`;
            } else if (this.pricesError) {
                body = `<div class="no-data" style="color:#ef4444">${escapeHtml(this.pricesError)}</div>`;
            } else {
                body = `<div class="no-data">${escapeHtml(t('components.airlineIntel.enterRouteAndDate'))}</div>`;
            }
            this.content.innerHTML = `${toggle}${form}${degradedBanner}${body}`;
        } else {
            const form = `
        <div class="price-controls">
          <input id="datesFromInput" class="price-input" placeholder="From" maxlength="3" value="${escapeHtml(this.pricesOrigin)}" style="width:54px">
          <span style="color:#6b7280">\u2192</span>
          <input id="datesToInput" class="price-input" placeholder="To" maxlength="3" value="${escapeHtml(this.pricesDest)}" style="width:54px">
          <input id="datesStartInput" class="price-input" type="date" value="${escapeHtml(this.datesStart || localDateStr())}" style="width:128px">
          <input id="datesEndInput" class="price-input" type="date" value="${escapeHtml(this.datesEnd)}" style="width:128px">
          <label style="display:flex;align-items:center;gap:4px;font-size:12px">
            <input id="datesRoundTripCheck" type="checkbox" ${this.datesRoundTrip ? 'checked' : ''}>${escapeHtml(t('components.airlineIntel.roundTrip'))}
          </label>
          <label style="display:flex;align-items:center;gap:4px;font-size:12px">
            ${escapeHtml(t('components.airlineIntel.tripDays'))}:
            <input id="datesTripDurInput" class="price-input" type="number" min="1" value="${this.datesTripDuration}" style="width:44px">
          </label>
          <select id="datesCabinSelect" class="price-input" style="width:110px">
            <option value="ECONOMY"${this.pricesCabin === 'ECONOMY' ? ' selected' : ''}>Economy</option>
            <option value="PREMIUM_ECONOMY"${this.pricesCabin === 'PREMIUM_ECONOMY' ? ' selected' : ''}>Premium Economy</option>
            <option value="BUSINESS"${this.pricesCabin === 'BUSINESS' ? ' selected' : ''}>Business</option>
            <option value="FIRST"${this.pricesCabin === 'FIRST' ? ' selected' : ''}>First</option>
          </select>
          <button id="datesSearchBtn" class="icon-btn" style="padding:4px 10px">${t('header.search')}</button>
        </div>
        <div id="datesInlineErr" style="color:#ef4444;font-size:11px;min-height:14px"></div>`;

            let body: string;
            if (this.datesData.length) {
                const sorted = [...this.datesData].sort((a, b) => a.price - b.price);
                const prices = sorted.map(d => d.price);
                const cheapThreshold = prices[Math.floor(prices.length * 0.2)] ?? Infinity;
                const expThreshold = prices[Math.floor(prices.length * 0.8)] ?? -Infinity;
                const rows = sorted.map(d => {
                    const cls = d.price <= cheapThreshold ? 'dp-cheap' : d.price >= expThreshold ? 'dp-expensive' : '';
                    return `
            <div class="dp-row">
              <span class="dp-date">${escapeHtml(d.date)}</span>
              ${d.returnDate ? `<span class="dp-return">${escapeHtml(d.returnDate)}</span>` : ''}
              <span class="dp-price ${cls}">${Math.round(d.price).toLocaleString()}</span>
            </div>`;
                }).join('');
                body = `<div class="dp-list">${rows}</div>`;
            } else if (this.pricesError) {
                body = `<div class="no-data" style="color:#ef4444">${escapeHtml(this.pricesError)}</div>`;
            } else {
                body = `<div class="no-data">${escapeHtml(t('components.airlineIntel.enterDateRange'))}</div>`;
            }
            this.content.innerHTML = `${toggle}${form}${degradedBanner}${body}`;
        }
    }

    /* Styles moved to panels.css (PERF-012) */
}
