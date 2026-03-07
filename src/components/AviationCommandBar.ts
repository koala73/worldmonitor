import { fetchFlightStatus, fetchAirportOpsSummary, fetchFlightPrices, fetchAviationNews } from '@/services/aviation';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

// ---- Intent types ----

type Intent =
    | { type: 'OPS'; airports: string[] }
    | { type: 'FLIGHT_STATUS'; flightNumber: string; origin?: string }
    | { type: 'PRICE_WATCH'; origin: string; destination: string; date?: string }
    | { type: 'NEWS_BRIEF'; entities: string[] }
    | { type: 'TRACK'; callsign?: string; icao24?: string }
    | { type: 'UNKNOWN'; raw: string };

// ---- Intent parser ----

function parseIntent(raw: string): Intent {
    const q = raw.trim().toUpperCase();
    const words = q.split(/\s+/);

    // OPS <AIRPORT...>
    if (/^OPS\s/.test(q) || /^STATUS\s/.test(q)) {
        const airports = words.slice(1).filter(w => /^[A-Z]{3}$/.test(w));
        if (airports.length) return { type: 'OPS', airports };
    }

    // FLIGHT <IATA-FLIGHT>
    if (/^(FLIGHT|FLT|STATUS)\s+[A-Z]{2}\d{1,4}/.test(q)) {
        const match = q.match(/[A-Z]{2}\d{1,4}/);
        if (match) {
            const origin = words.find(w => /^[A-Z]{3}$/.test(w) && w !== match[0]);
            return { type: 'FLIGHT_STATUS', flightNumber: match[0], origin };
        }
    }

    // PRICE / PRICES <ORG> <DST>
    if (/^PRICE[S]?\s+[A-Z]{3}\s+[A-Z]{3}/.test(q)) {
        const airports = words.slice(1).filter(w => /^[A-Z]{3}$/.test(w));
        if (airports.length >= 2) {
            const date = words.find(w => /^\d{4}-\d{2}-\d{2}$/.test(w));
            return { type: 'PRICE_WATCH', origin: airports[0]!, destination: airports[1]!, date };
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
        const timeStr = f.estimatedDeparture
            ? `Dep ${f.estimatedDeparture.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
            : '';
        return {
            html: `<div class="cmd-section">
      <strong>✈️ ${escapeHtml(f.flightNumber)}</strong>
      <div>${escapeHtml(f.origin.iata)} → ${escapeHtml(f.destination.iata)} · ${f.status} · ${timeStr}</div>
      ${f.delayMinutes > 0 ? `<div style="color:#f97316">+${f.delayMinutes}m delay</div>` : ''}
    </div>` };
    }

    if (intent.type === 'PRICE_WATCH') {
        const date = intent.date ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        const { quotes, isDemoMode } = await fetchFlightPrices({ origin: intent.origin, destination: intent.destination, departureDate: date });
        if (!quotes.length) return { html: '<div class="cmd-empty">No prices found.</div>' };
        const best = quotes[0]!;
        return {
            html: `<div class="cmd-section">
      <strong>💸 ${escapeHtml(intent.origin)} → ${escapeHtml(intent.destination)}</strong>
      ${isDemoMode ? '<span class="demo-badge" style="margin-left:6px">DEMO</span>' : ''}
      <div>Best: <strong style="color:#60a5fa">$${Math.round(best.priceAmount)}</strong> via ${escapeHtml(best.carrierName || best.carrierIata)} · ${best.stops === 0 ? 'nonstop' : `${best.stops} stop`}</div>
    </div>` };
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
        html: `<div class="cmd-empty">Unrecognized command. Try: <code>ops IST</code>, <code>flight TK1</code>, <code>price IST LHR</code>, <code>brief</code></div>`,
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
        <input id="aviation-cmd-input" type="text" placeholder="ops IST  /  flight TK1  /  price IST LHR  /  brief" autocomplete="off" spellcheck="false">
        <div id="aviation-cmd-suggestions"></div>
        <div id="aviation-cmd-result"></div>
        <div id="aviation-cmd-history-list"></div>
        <div id="aviation-cmd-hint">Press <kbd>Enter</kbd> to run · <kbd>Esc</kbd> to close · <kbd>Ctrl+J</kbd> to toggle</div>
      </div>`;

        document.body.appendChild(this.overlay);

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
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
        resultEl.innerHTML = '<div style="color:#9ca3af;font-size:12px">Running…</div>';

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
            'ops IST', 'ops LHR FRA', 'flight TK1', 'price IST LHR', 'brief', 'brief TK',
        ].filter(s => s.toLowerCase().startsWith(val.toLowerCase()) && s.toLowerCase() !== val.toLowerCase());
        if (!val || !suggestions.length) { el.innerHTML = ''; return; }
        el.innerHTML = suggestions.slice(0, 4).map(s =>
            `<button class="cmd-sug-btn" style="background:none;border:1px solid #374151;border-radius:3px;color:#9ca3af;cursor:pointer;font-size:11px;padding:2px 6px;margin:2px">${escapeHtml(s)}</button>`
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
      #aviation-cmd-overlay { position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding-top:80px; }
      #aviation-cmd-box { background:var(--surface,#141414);border:1px solid var(--border,#2a2a2a);border-radius:10px;padding:16px;width:min(560px,92vw);box-shadow:0 24px 60px rgba(0,0,0,.7);max-height:80vh;overflow-y:auto; }
      #aviation-cmd-header { display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:14px;font-weight:600;color:var(--text,#e8e8e8); }
      #aviation-cmd-close { background:none;border:none;color:#6b7280;cursor:pointer;font-size:18px;line-height:1; }
      #aviation-cmd-input { width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid var(--border,#2a2a2a);border-radius:6px;color:var(--text,#e8e8e8);font-size:14px;padding:10px;outline:none; }
      #aviation-cmd-input:focus { border-color:var(--accent,#60a5fa); }
      #aviation-cmd-result { margin-top:12px;font-size:13px; }
      .cmd-row { display:flex;gap:10px;align-items:center;padding:4px 0;font-size:13px; }
      .cmd-section { padding:8px 0; }
      .cmd-empty { color:#6b7280;font-size:12px;padding:8px 0; }
      .cmd-news-item { padding:4px 0; }
      .cmd-news-item a { color:var(--text,#e8e8e8);text-decoration:none;font-size:12px; }
      .cmd-news-item a:hover { color:var(--accent,#60a5fa); }
      #aviation-cmd-hint { font-size:11px;color:#4b5563;margin-top:10px;text-align:right; }
      #aviation-cmd-hint kbd { background:#374151;border-radius:2px;padding:1px 4px;font-family:monospace; }
    `;
        document.head.appendChild(style);
    }
}
