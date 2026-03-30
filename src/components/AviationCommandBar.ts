import { fetchFlightStatus, fetchAirportOpsSummary, fetchFlightPrices, fetchAviationNews, fetchGoogleFlights } from '@/services/aviation';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { MONITORED_AIRPORTS } from '@/config/airports';

// ---- Intent types ----

type Intent =
    | { type: 'OPS'; airports: string[] }
    | { type: 'FLIGHT_STATUS'; flightNumber: string; origin?: string }
    | { type: 'PRICE_WATCH'; origin: string; destination: string; date?: string }
    | { type: 'NEWS_BRIEF'; entities: string[] }
    | { type: 'TRACK'; callsign?: string; icao24?: string }
    | { type: 'UNKNOWN'; raw: string };

function fmtDur(m: number): string {
    if (!m) return '';
    const h = Math.floor(m / 60);
    const min = m % 60;
    return min > 0 ? `${h}h ${min}m` : `${h}h`;
}

// ---- Airport resolver (IATA or city/name fuzzy match) ----

// Airports not in MONITORED_AIRPORTS but commonly searched by city name
const EXTRA_CITY_IATA: Record<string, string> = {
    newcastle: 'NCL', manchester: 'MAN', birmingham: 'BHX', edinburgh: 'EDI',
    glasgow: 'GLA', brussels: 'BRU', milan: 'MXP', rome: 'FCO',
    moscow: 'SVO', bangkok: 'BKK', osaka: 'KIX', montreal: 'YUL',
    lagos: 'LOS', nairobi: 'NBO', casablanca: 'CMN', cairo: 'CAI',
    athens: 'ATH', oslo: 'OSL', stockholm: 'ARN', copenhagen: 'CPH',
    helsinki: 'HEL', vienna: 'VIE', warsaw: 'WAW', prague: 'PRG',
    budapest: 'BUD', bucharest: 'OTP',
};

function resolveIata(token: string): string | undefined {
    const up = token.toUpperCase();
    if (/^[A-Z]{3}$/.test(up)) return up;
    const low = token.toLowerCase();
    const cityMatch = MONITORED_AIRPORTS.find(a => a.city.toLowerCase() === low);
    if (cityMatch) return cityMatch.iata;
    if (EXTRA_CITY_IATA[low]) return EXTRA_CITY_IATA[low];
    // Whole-word name match — only if the token uniquely identifies one airport
    const nameMatches = MONITORED_AIRPORTS.filter(a =>
        a.name.toLowerCase().split(/[\s\-–./]+/).includes(low)
    );
    if (nameMatches.length === 1) return nameMatches[0]!.iata;
    return undefined;
}

function extractAirports(words: string[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    let i = 0;
    while (i < words.length) {
        if (i + 1 < words.length) {
            const two = `${words[i]} ${words[i + 1]}`;
            const m = MONITORED_AIRPORTS.find(a => a.city.toLowerCase() === two.toLowerCase());
            if (m) { if (!seen.has(m.iata)) { result.push(m.iata); seen.add(m.iata); } i += 2; continue; }
        }
        const iata = resolveIata(words[i]!);
        if (iata && !seen.has(iata)) { result.push(iata); seen.add(iata); }
        else if (iata) seen.add(iata); // consume the token even if already seen
        i++;
    }
    return result;
}

// ---- Intent parser ----

function parseIntent(raw: string): Intent {
    const q = raw.trim().toUpperCase();
    const words = q.split(/\s+/);

    // OPS <AIRPORT | city name ...>
    if (/^OPS\b/.test(q) || /^STATUS\s/.test(q)) {
        const airports = extractAirports(words.slice(1));
        if (airports.length) return { type: 'OPS', airports };
    }

    // FLIGHT <IATA-FLIGHT> or <IATA-FLIGHT> [STATUS|FLIGHT|FLT]
    if (/^(FLIGHT|FLT)\s+[A-Z]{2,3}\d{1,4}/.test(q) || /[A-Z]{2,3}\d{1,4}\s+(STATUS|FLIGHT|FLT)/.test(q) || /^STATUS\s+[A-Z]{2,3}\d{1,4}/.test(q)) {
        const match = q.match(/[A-Z]{2,3}\d{1,4}/);
        if (match) {
            const origin = words.find(w => /^[A-Z]{3}$/.test(w) && w !== match[0]);
            return { type: 'FLIGHT_STATUS', flightNumber: match[0], origin };
        }
    }

    // FLY / FLIGHTS / FARES / BOOK <ORG> <DST>  (supports city names)
    if (words.some(w => /^(FLY|FLIGHTS?|FARES?|BOOK)$/.test(w))) {
        const nonKeywords = words.filter(w => !/^(FLY|FLIGHTS?|FARES?|BOOK|TO|FROM|ON|FOR)$/.test(w) && !/^\d{4}-\d{2}-\d{2}$/.test(w));
        const priceAirports = extractAirports(nonKeywords);
        if (priceAirports.length >= 2) {
            const date = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
            return { type: 'PRICE_WATCH', origin: priceAirports[0]!, destination: priceAirports[1]!, date };
        }
    }

    // NEWS / BRIEF
    if (/^(NEWS|BRIEF)\s*/.test(q)) {
        const entities = words.slice(1).filter(w => w.length >= 2);
        return { type: 'NEWS_BRIEF', entities };
    }

    // TRACK <ICAO24 | callsign>
    if (/^TRACK\s/.test(q)) {
        const token = words[1] ?? '';
        if (/^[0-9A-F]{6}$/i.test(token)) return { type: 'TRACK', icao24: token.toLowerCase() };
        if (token) return { type: 'TRACK', callsign: token };
    }

    return { type: 'UNKNOWN', raw };
}

// ---- Result rendering ----

type CommandResult = { html: string; error?: boolean };

async function executeIntent(intent: Intent): Promise<CommandResult> {
    if (intent.type === 'OPS') {
        const summaries = await fetchAirportOpsSummary(intent.airports);
        if (!summaries.length) return { html: '<div class="cmd-empty">No ops data found.</div>' };
        const rows = summaries.map(s => `
      <div class="cmd-row">
        <strong>${escapeHtml(s.iata)}</strong>
        <span style="color:${s.severity === 'normal' ? '#22c55e' : s.severity === 'minor' ? '#f59e0b' : '#ef4444'}">${s.severity.toUpperCase()}</span>
        <span>${s.avgDelayMinutes > 0 ? `+${s.avgDelayMinutes}m delay` : 'Normal ops'}</span>
        ${s.closureStatus ? '<span style="color:#ef4444">CLOSED</span>' : ''}
      </div>`).join('');
        return { html: `<div class="cmd-section"><strong>✈️ Ops Snapshot</strong>${rows}</div>` };
    }

    if (intent.type === 'FLIGHT_STATUS') {
        const flights = await fetchFlightStatus(intent.flightNumber, undefined, intent.origin);
        if (!flights.length) return { html: `<div class="cmd-empty">No results for ${escapeHtml(intent.flightNumber)}.</div>` };
        const f = flights[0]!;
        const depStr = f.estimatedDeparture
            ? `Dep ${f.estimatedDeparture.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
            : '';
        const arrStr = f.estimatedArrival
            ? ` · Arr ${f.estimatedArrival.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
            : '';
        const carrierLabel = f.carrier.name || f.carrier.iata;
        const gateLine = (f.gate || f.terminal)
            ? `<div style="color:#9ca3af;font-size:11px">Gate ${escapeHtml(f.gate || '—')}${f.terminal ? ` · Terminal ${escapeHtml(f.terminal)}` : ''}</div>`
            : '';
        const acLine = f.aircraftType
            ? `<div style="color:#9ca3af;font-size:11px">${escapeHtml(f.aircraftType)}</div>`
            : '';
        return {
            html: `<div class="cmd-section">
      <strong>✈️ ${escapeHtml(f.flightNumber)}</strong>${carrierLabel ? ` <span style="color:#9ca3af">(${escapeHtml(carrierLabel)})</span>` : ''}
      <div>${escapeHtml(f.origin.iata)} → ${escapeHtml(f.destination.iata)} · ${f.status}${depStr ? ` · ${depStr}` : ''}${arrStr}</div>
      ${acLine}${gateLine}
      ${f.delayMinutes > 0 ? `<div style="color:#f97316">+${f.delayMinutes}m delay</div>` : ''}
    </div>` };
    }

    if (intent.type === 'PRICE_WATCH') {
        // Use local calendar arithmetic — never toISOString() which truncates at UTC midnight
        const addLocalDays = (n: number): string => {
            const d = new Date(); d.setDate(d.getDate() + n);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };
        const date = intent.date ?? addLocalDays(1); // default: tomorrow in user's local timezone
        const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
        const dateChips = ([1, 3, 7, 14, 30] as const).map(days => {
            const d = addLocalDays(days);
            const lbl = days === 1 ? 'Tomorrow' : `+${days}d`;
            const active = d === date;
            const cmd = `fly ${intent.origin} ${intent.destination} ${d}`;
            return `<button data-rerun="${escapeHtml(cmd)}" style="background:${active ? 'rgba(68,255,136,.1)' : 'none'};border:1px solid ${active ? 'var(--green,#44ff88)' : 'var(--border,#2a2a2a)'};border-radius:3px;color:${active ? 'var(--green,#44ff88)' : 'var(--text-dim,#6b7280)'};cursor:pointer;font-size:10px;padding:1px 6px">${lbl}</button>`;
        }).join('');
        const header = `<div style="margin-bottom:4px">
          <strong>💸 ${escapeHtml(intent.origin)} → ${escapeHtml(intent.destination)}</strong>
        </div>
        <div style="margin-bottom:8px;display:flex;gap:4px;align-items:center">
          <span style="color:#6b7280;font-size:10px;margin-right:2px">${escapeHtml(dateLabel)}</span>${dateChips}
        </div>`;

        // Try Google Flights first — sort nonstop first, then by price
        const gfResult = await fetchGoogleFlights({ origin: intent.origin, destination: intent.destination, departureDate: date });
        if (gfResult.flights.length) {
            const sorted = [...gfResult.flights].sort((a, b) => a.stops !== b.stops ? a.stops - b.stops : a.price - b.price);
            const rows = sorted.slice(0, 5).map(f => {
                const leg = f.legs[0];
                const carrier = leg ? `${escapeHtml(leg.airlineCode)} ${escapeHtml(leg.flightNumber)}` : '';
                const depTime = leg?.departureDatetime?.slice(11, 16) ?? '';
                const arrTime = f.legs[f.legs.length - 1]?.arrivalDatetime?.slice(11, 16) ?? '';
                const stopColor = f.stops === 0 ? 'var(--green,#44ff88)' : 'var(--text-dim,#9ca3af)';
                const stopLabel = f.stops === 0 ? 'nonstop' : `${f.stops} stop${f.stops > 1 ? 's' : ''}`;
                const safeDepTime = escapeHtml(depTime);
                const safeArrTime = escapeHtml(arrTime);
                const flightCode = leg ? `${leg.airlineCode}${leg.flightNumber}` : '';
                const qParam = flightCode
                    ? `${encodeURIComponent(flightCode)}+from+${encodeURIComponent(intent.origin)}+to+${encodeURIComponent(intent.destination)}+on+${encodeURIComponent(date)}`
                    : `Flights+from+${encodeURIComponent(intent.origin)}+to+${encodeURIComponent(intent.destination)}+on+${encodeURIComponent(date)}`;
                const rowUrl = sanitizeUrl(`https://www.google.com/travel/flights/search?q=${qParam}`);
                return `<a class="cmd-row" href="${rowUrl}" target="_blank" rel="noopener" style="padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05);text-decoration:none;cursor:pointer;color:var(--text,#e8e8e8)">
          <div style="flex:1;min-width:0">
            <span style="font-size:13px">${carrier}</span>
            <span style="color:${stopColor};font-size:11px;margin-left:6px">${stopLabel}</span>
          </div>
          <div style="color:#9ca3af;font-size:11px;margin:0 10px">${safeDepTime}${safeArrTime ? `–${safeArrTime}` : ''} · ${escapeHtml(fmtDur(f.durationMinutes))}</div>
          <div style="color:var(--green,#44ff88);font-weight:600">$${Math.round(f.price).toLocaleString()}</div>
        </a>`;
            }).join('');
            return {
                html: `<div class="cmd-section">${header}${rows}${gfResult.degraded ? '<div style="color:#f59e0b;font-size:11px;margin-top:4px">Partial results</div>' : ''}</div>`,
            };
        }

        // Fallback to TravelPayouts / demo
        const { quotes, isDemoMode } = await fetchFlightPrices({ origin: intent.origin, destination: intent.destination, departureDate: date });
        if (!quotes.length) return { html: '<div class="cmd-empty">No prices found.</div>' };
        const rows = [...quotes].sort((a, b) => a.stops !== b.stops ? a.stops - b.stops : a.priceAmount - b.priceAmount).slice(0, 5).map(q => {
            const stopColor = q.stops === 0 ? 'var(--green,#44ff88)' : 'var(--text-dim,#9ca3af)';
            const stopLabel = q.stops === 0 ? 'nonstop' : `${q.stops} stop${q.stops > 1 ? 's' : ''}`;
            const rowUrl = sanitizeUrl(`https://www.google.com/travel/flights/search?q=${encodeURIComponent(q.carrierIata)}+from+${encodeURIComponent(intent.origin)}+to+${encodeURIComponent(intent.destination)}+on+${encodeURIComponent(date)}`);
            return `<a class="cmd-row" href="${rowUrl}" target="_blank" rel="noopener" style="padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05);text-decoration:none;cursor:pointer;color:var(--text,#e8e8e8)">
          <div style="flex:1">${escapeHtml(q.carrierName || q.carrierIata)}<span style="color:${stopColor};font-size:11px;margin-left:6px">${stopLabel}</span></div>
          <div style="color:var(--green,#44ff88);font-weight:600">$${Math.round(q.priceAmount)}</div>
        </a>`;
        }).join('');
        return {
            html: `<div class="cmd-section">${header}${rows}${isDemoMode ? '<div style="color:#6b7280;font-size:11px;margin-top:4px">Indicative prices</div>' : ''}</div>`,
        };
    }

    if (intent.type === 'NEWS_BRIEF') {
        const items = await fetchAviationNews(intent.entities, 24, 5);
        if (!items.length) return { html: '<div class="cmd-empty">No recent aviation news.</div>' };
        const rows = items.map(n => `<div class="cmd-news-item"><a href="${sanitizeUrl(n.url)}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a></div>`).join('');
        return { html: `<div class="cmd-section"><strong>📰 Aviation News</strong>${rows}</div>` };
    }

    if (intent.type === 'TRACK') {
        return { html: `<div class="cmd-section">🛰️ Tracking <strong>${escapeHtml(intent.callsign ?? intent.icao24 ?? '?')}</strong> — open Tracking tab in Airline Intel panel for live positions.</div>` };
    }

    return {
        html: `<div class="cmd-empty">Try: <code>ops Dubai</code>, <code>flight EK3</code>, <code>fly London Dubai</code>, <code>brief TK</code></div>`,
        error: true,
    };
}

// ---- Command Bar Component ----

const HISTORY_KEY = 'aviation:cmdbar:history:v1';
const MAX_HISTORY = 20;

export class AviationCommandBar {
    private overlay: HTMLElement | null = null;
    private boundKeydown: (e: KeyboardEvent) => void;

    constructor() {
        this.boundKeydown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'j') {
                const tag = (document.activeElement as HTMLElement)?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA') return;
                e.preventDefault();
                this.open();
            }
        };
        document.addEventListener('keydown', this.boundKeydown);
        this.addStyles();
    }

    destroy(): void {
        document.removeEventListener('keydown', this.boundKeydown);
        this.close();
    }

    open(): void {
        if (this.overlay) { this.focus(); return; }

        this.overlay = document.createElement('div');
        this.overlay.id = 'aviation-cmd-overlay';
        this.overlay.innerHTML = `
      <div id="aviation-cmd-box">
        <div id="aviation-cmd-header">
          <span>✈️ Aviation Command</span>
          <button id="aviation-cmd-close">×</button>
        </div>
        <input id="aviation-cmd-input" type="text" placeholder="ops Dubai  ·  flight EK3  ·  fly London Dubai  ·  brief" autocomplete="off" spellcheck="false">
        <div id="aviation-cmd-suggestions"></div>
        <div id="aviation-cmd-result"></div>
        <div id="aviation-cmd-history-list"></div>
        <div id="aviation-cmd-hint">Press <kbd>Enter</kbd> to run · <kbd>Esc</kbd> to close · <kbd>Ctrl+J</kbd> to toggle</div>
      </div>`;

        document.body.appendChild(this.overlay);

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) { this.close(); return; }
            const rerunBtn = (e.target as HTMLElement).closest('[data-rerun]') as HTMLElement | null;
            if (rerunBtn?.dataset['rerun']) {
                const cmd = rerunBtn.dataset['rerun'];
                const inp = this.overlay?.querySelector('#aviation-cmd-input') as HTMLInputElement;
                if (inp && cmd) { inp.value = cmd; this.addToHistory(cmd); void this.run(cmd); }
            }
        });

        this.overlay.querySelector('#aviation-cmd-close')?.addEventListener('click', () => this.close());

        const input = this.overlay.querySelector('#aviation-cmd-input') as HTMLInputElement;
        input?.addEventListener('keydown', async (e) => {
            if (e.key === 'Escape') { this.close(); return; }
            if (e.key === 'Enter') {
                const val = input.value.trim();
                if (!val) return;
                this.addToHistory(val);
                await this.run(val);
            }
        });
        input?.addEventListener('input', () => this.updateSuggestions(input.value));

        this.renderHistory();
        this.focus();
    }

    private focus(): void {
        const input = this.overlay?.querySelector('#aviation-cmd-input') as HTMLInputElement;
        setTimeout(() => input?.focus(), 50);
    }

    private close(): void {
        this.overlay?.remove();
        this.overlay = null;
    }

    private async run(raw: string): Promise<void> {
        const resultEl = this.overlay?.querySelector('#aviation-cmd-result');
        if (!resultEl) return;
        resultEl.innerHTML = '<div style="color:var(--text-dim,#9ca3af);font-size:12px">Running…</div>';

        try {
            const intent = parseIntent(raw);
            const result = await executeIntent(intent);
            resultEl.innerHTML = result.html;
        } catch (err) {
            resultEl.innerHTML = `<div style="color:#ef4444">Error: ${err instanceof Error ? escapeHtml(err.message) : 'Unknown error'}</div>`;
        }
    }

    private getHistory(): string[] {
        try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { return []; }
    }

    private addToHistory(cmd: string): void {
        const h = this.getHistory().filter(h => h !== cmd);
        h.unshift(cmd);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY)));
        this.renderHistory();
    }

    private renderHistory(): void {
        const el = this.overlay?.querySelector('#aviation-cmd-history-list');
        if (!el) return;
        const h = this.getHistory().slice(0, 5);
        if (!h.length) { el.innerHTML = ''; return; }
        el.innerHTML = `<div style="font-size:11px;color:#6b7280;margin-top:4px">${h.map(c =>
            `<button class="cmd-hist-btn" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:11px;padding:1px 4px;border-radius:2px">${escapeHtml(c)}</button>`
        ).join('')}</div>`;
        el.querySelectorAll('.cmd-hist-btn').forEach((btn, i) => {
            btn.addEventListener('click', () => {
                const input = this.overlay?.querySelector('#aviation-cmd-input') as HTMLInputElement;
                if (input) { input.value = h[i]!; input.focus(); }
            });
        });
    }

    private updateSuggestions(val: string): void {
        const el = this.overlay?.querySelector('#aviation-cmd-suggestions');
        if (!el) return;
        const suggestions = [
            'ops IST', 'ops Dubai', 'ops London', 'ops LHR FRA', 'ops Lisbon',
            'flight TK1', 'flight EK3', 'ME426 status',
            'fly IST LHR', 'fly Dubai London', 'fly LHR to DXB', 'fly BEY DXB',
            'brief', 'brief TK',
        ].filter(s => s.toLowerCase().startsWith(val.toLowerCase()) && s.toLowerCase() !== val.toLowerCase());
        if (!val || !suggestions.length) { el.innerHTML = ''; return; }
        el.innerHTML = suggestions.slice(0, 4).map(s =>
            `<button class="cmd-sug-btn" style="background:none;border:1px solid var(--border,#2a2a2a);border-radius:3px;color:var(--text-dim,#9ca3af);cursor:pointer;font-size:11px;padding:2px 6px;margin:2px">${escapeHtml(s)}</button>`
        ).join('');
        el.querySelectorAll('.cmd-sug-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const input = this.overlay?.querySelector('#aviation-cmd-input') as HTMLInputElement;
                if (input) { input.value = (btn as HTMLElement).textContent ?? ''; void this.run(input.value); }
            });
        });
    }

    private addStyles(): void {
        if (document.getElementById('aviation-cmd-styles')) return;
        const style = document.createElement('style');
        style.id = 'aviation-cmd-styles';
        style.textContent = `
      #aviation-cmd-overlay { position:fixed;inset:0;background:var(--bg,#0a0a0a);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding-top:80px;backdrop-filter:blur(4px); }
      #aviation-cmd-box { background:var(--surface,#141414);border:1px solid var(--border,#2a2a2a);border-radius:8px;width:min(560px,92vw);box-shadow:0 20px 60px rgba(0,0,0,.8);max-height:80vh;overflow-y:auto; }
      #aviation-cmd-header { display:flex;justify-content:space-between;align-items:center;padding:12px 16px;font-size:13px;font-weight:600;color:var(--text,#e8e8e8);border-bottom:1px solid var(--border,#2a2a2a); }
      #aviation-cmd-close { background:none;border:none;color:var(--text-dim,#6b7280);cursor:pointer;font-size:16px;line-height:1; }
      #aviation-cmd-input { width:100%;box-sizing:border-box;background:transparent;border:none;border-bottom:1px solid var(--border,#2a2a2a);color:var(--text,#e8e8e8);font-family:inherit;font-size:14px;padding:12px 16px;outline:none; }
      #aviation-cmd-input:focus { border-bottom-color:var(--green,#44ff88); }
      #aviation-cmd-input::placeholder { color:var(--text-dim,#6b7280); }
      #aviation-cmd-suggestions { padding:4px 16px; }
      #aviation-cmd-result { padding:8px 16px 12px;font-size:13px; }
      #aviation-cmd-history-list { padding:0 16px; }
      .cmd-row { display:flex;gap:10px;align-items:center;font-size:13px;color:var(--text,#e8e8e8);text-decoration:none; }
      .cmd-section { padding:4px 0; }
      .cmd-empty { color:var(--text-dim,#6b7280);font-size:12px;padding:8px 0; }
      .cmd-news-item { padding:4px 0; }
      .cmd-news-item a { color:var(--text,#e8e8e8);text-decoration:none;font-size:12px; }
      .cmd-news-item a:hover { color:var(--green,#44ff88); }
      #aviation-cmd-hint { font-size:11px;color:var(--text-dim,#6b7280);padding:10px 16px;text-align:right;border-top:1px solid var(--border,#2a2a2a); }
      #aviation-cmd-hint kbd { background:var(--border,#2a2a2a);border-radius:3px;padding:1px 5px;font-family:inherit; }
    `;
        document.head.appendChild(style);
    }
}
