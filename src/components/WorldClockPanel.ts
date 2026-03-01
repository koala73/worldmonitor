import { Panel } from './Panel';

interface CityEntry {
  id: string;
  city: string;
  label: string;
  timezone: string;
  marketOpen?: number;
  marketClose?: number;
}

const WORLD_CITIES: CityEntry[] = [
  { id: 'new-york', city: 'New York', label: 'NYSE', timezone: 'America/New_York', marketOpen: 9, marketClose: 16 },
  { id: 'chicago', city: 'Chicago', label: 'CME', timezone: 'America/Chicago', marketOpen: 8, marketClose: 15 },
  { id: 'sao-paulo', city: 'São Paulo', label: 'B3', timezone: 'America/Sao_Paulo', marketOpen: 10, marketClose: 17 },
  { id: 'london', city: 'London', label: 'LSE', timezone: 'Europe/London', marketOpen: 8, marketClose: 16 },
  { id: 'paris', city: 'Paris', label: 'Euronext', timezone: 'Europe/Paris', marketOpen: 9, marketClose: 17 },
  { id: 'frankfurt', city: 'Frankfurt', label: 'XETRA', timezone: 'Europe/Berlin', marketOpen: 9, marketClose: 17 },
  { id: 'zurich', city: 'Zurich', label: 'SIX', timezone: 'Europe/Zurich', marketOpen: 9, marketClose: 17 },
  { id: 'moscow', city: 'Moscow', label: 'MOEX', timezone: 'Europe/Moscow', marketOpen: 10, marketClose: 18 },
  { id: 'istanbul', city: 'Istanbul', label: 'BIST', timezone: 'Europe/Istanbul', marketOpen: 10, marketClose: 18 },
  { id: 'riyadh', city: 'Riyadh', label: 'Tadawul', timezone: 'Asia/Riyadh', marketOpen: 10, marketClose: 15 },
  { id: 'dubai', city: 'Dubai', label: 'DFM', timezone: 'Asia/Dubai', marketOpen: 10, marketClose: 14 },
  { id: 'mumbai', city: 'Mumbai', label: 'NSE', timezone: 'Asia/Kolkata', marketOpen: 9, marketClose: 15 },
  { id: 'bangkok', city: 'Bangkok', label: 'SET', timezone: 'Asia/Bangkok', marketOpen: 10, marketClose: 16 },
  { id: 'singapore', city: 'Singapore', label: 'SGX', timezone: 'Asia/Singapore', marketOpen: 9, marketClose: 17 },
  { id: 'hong-kong', city: 'Hong Kong', label: 'HKEX', timezone: 'Asia/Hong_Kong', marketOpen: 9, marketClose: 16 },
  { id: 'shanghai', city: 'Shanghai', label: 'SSE', timezone: 'Asia/Shanghai', marketOpen: 9, marketClose: 15 },
  { id: 'seoul', city: 'Seoul', label: 'KRX', timezone: 'Asia/Seoul', marketOpen: 9, marketClose: 15 },
  { id: 'tokyo', city: 'Tokyo', label: 'TSE', timezone: 'Asia/Tokyo', marketOpen: 9, marketClose: 15 },
  { id: 'sydney', city: 'Sydney', label: 'ASX', timezone: 'Australia/Sydney', marketOpen: 10, marketClose: 16 },
  { id: 'auckland', city: 'Auckland', label: 'NZX', timezone: 'Pacific/Auckland', marketOpen: 10, marketClose: 16 },
  { id: 'toronto', city: 'Toronto', label: 'TSX', timezone: 'America/Toronto', marketOpen: 9, marketClose: 16 },
  { id: 'mexico-city', city: 'Mexico City', label: 'BMV', timezone: 'America/Mexico_City', marketOpen: 8, marketClose: 15 },
  { id: 'buenos-aires', city: 'Buenos Aires', label: 'BYMA', timezone: 'America/Argentina/Buenos_Aires', marketOpen: 11, marketClose: 17 },
  { id: 'johannesburg', city: 'Johannesburg', label: 'JSE', timezone: 'Africa/Johannesburg', marketOpen: 9, marketClose: 17 },
  { id: 'cairo', city: 'Cairo', label: 'EGX', timezone: 'Africa/Cairo', marketOpen: 10, marketClose: 14 },
  { id: 'lagos', city: 'Lagos', label: 'NGX', timezone: 'Africa/Lagos', marketOpen: 10, marketClose: 14 },
  { id: 'los-angeles', city: 'Los Angeles', label: 'Pacific', timezone: 'America/Los_Angeles' },
  { id: 'jakarta', city: 'Jakarta', label: 'IDX', timezone: 'Asia/Jakarta', marketOpen: 9, marketClose: 16 },
  { id: 'taipei', city: 'Taipei', label: 'TWSE', timezone: 'Asia/Taipei', marketOpen: 9, marketClose: 13 },
  { id: 'kuala-lumpur', city: 'Kuala Lumpur', label: 'Bursa', timezone: 'Asia/Kuala_Lumpur', marketOpen: 9, marketClose: 17 },
];

const TIMEZONE_TO_CITY: Record<string, string> = {};
for (const c of WORLD_CITIES) {
  TIMEZONE_TO_CITY[c.timezone] = c.id;
}
TIMEZONE_TO_CITY['America/Detroit'] = 'new-york';
TIMEZONE_TO_CITY['US/Eastern'] = 'new-york';
TIMEZONE_TO_CITY['US/Central'] = 'chicago';
TIMEZONE_TO_CITY['US/Pacific'] = 'los-angeles';
TIMEZONE_TO_CITY['US/Mountain'] = 'new-york';
TIMEZONE_TO_CITY['Asia/Calcutta'] = 'mumbai';
TIMEZONE_TO_CITY['Asia/Saigon'] = 'bangkok';
TIMEZONE_TO_CITY['Pacific/Sydney'] = 'sydney';

const STORAGE_KEY = 'worldmonitor-world-clock-cities';
const DEFAULT_CITIES = ['new-york', 'london', 'dubai', 'bangkok', 'tokyo', 'sydney'];

function detectHomeCity(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONE_TO_CITY[tz] ?? null;
  } catch {
    return null;
  }
}

function loadSelectedCities(): string[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as string[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore */ }
  const home = detectHomeCity();
  const defaults = [...DEFAULT_CITIES];
  if (home && !defaults.includes(home)) defaults.unshift(home);
  return defaults;
}

function saveSelectedCities(ids: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

function getTimeInZone(tz: string): { h: number; m: number; s: number; dayOfWeek: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false, weekday: 'short',
  }).formatToParts(now);
  let h = 0, m = 0, s = 0, dayOfWeek = '';
  for (const p of parts) {
    if (p.type === 'hour') h = parseInt(p.value, 10);
    if (p.type === 'minute') m = parseInt(p.value, 10);
    if (p.type === 'second') s = parseInt(p.value, 10);
    if (p.type === 'weekday') dayOfWeek = p.value;
  }
  if (h === 24) h = 0;
  return { h, m, s, dayOfWeek };
}

function getTzAbbr(tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
    const parts = fmt.formatToParts(new Date());
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    return tzPart?.value ?? '';
  } catch {
    return '';
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

const STYLE = `
<style>
.wc-rows { display:flex; flex-direction:column; gap:0; }
.wc-row { display:grid; grid-template-columns:1fr auto; align-items:center; padding:6px 8px; border-bottom:1px solid var(--border); gap:4px; }
.wc-row:last-child { border-bottom:none; }
.wc-row.wc-home { background:rgba(68,255,136,0.06); }
.wc-city { font-weight:600; font-size:13px; color:var(--text); line-height:1.3; }
.wc-label { font-size:11px; color:var(--text-dim); }
.wc-right { display:flex; flex-direction:column; align-items:flex-end; gap:2px; }
.wc-time { font-family:var(--font-mono); font-size:16px; font-weight:700; color:var(--text); letter-spacing:0.5px; }
.wc-meta { font-size:10px; color:var(--text-dim); display:flex; gap:6px; align-items:center; }
.wc-bar-wrap { width:60px; height:6px; background:var(--surface); border-radius:3px; overflow:hidden; }
.wc-bar { height:100%; border-radius:3px; transition:width 1s linear; }
.wc-bar.day { background:linear-gradient(90deg,#44ff88,#88ff44); }
.wc-bar.night { background:linear-gradient(90deg,#334,#556); }
.wc-market-open { color:#44ff88; font-weight:600; }
.wc-market-closed { color:var(--text-dim); }
.wc-settings-btn { background:none; border:none; color:var(--text-dim); cursor:pointer; font-size:14px; padding:2px 6px; border-radius:4px; }
.wc-settings-btn:hover { background:var(--surface); color:var(--text); }
.wc-popover { position:absolute; top:32px; right:4px; background:var(--bg, #1a1c1e); border:1px solid var(--border); border-radius:8px; padding:8px; z-index:100; max-height:320px; overflow-y:auto; min-width:200px; box-shadow:0 4px 16px rgba(0,0,0,0.4); }
.wc-popover label { display:flex; align-items:center; gap:6px; padding:4px 6px; font-size:12px; color:var(--text); cursor:pointer; border-radius:4px; white-space:nowrap; }
.wc-popover label:hover { background:var(--surface); }
.wc-popover input[type=checkbox] { accent-color:#44ff88; }
.wc-header-right { position:relative; display:flex; align-items:center; }
</style>
`;

export class WorldClockPanel extends Panel {
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private selectedCities: string[] = [];
  private homeCityId: string | null = null;
  private popoverEl: HTMLElement;
  private outsideClickHandler: (e: MouseEvent) => void;

  constructor() {
    super({ id: 'world-clock', title: 'World Clock', trackActivity: false });
    this.homeCityId = detectHomeCity();
    this.selectedCities = loadSelectedCities();

    this.popoverEl = document.createElement('div');
    this.popoverEl.className = 'wc-popover';
    this.popoverEl.style.display = 'none';
    this.element.style.position = 'relative';
    this.element.appendChild(this.popoverEl);

    this.popoverEl.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.tagName !== 'INPUT') return;
      const cityId = target.dataset.cityId;
      if (!cityId) return;
      if (target.checked) {
        if (!this.selectedCities.includes(cityId)) this.selectedCities.push(cityId);
      } else {
        this.selectedCities = this.selectedCities.filter(id => id !== cityId);
      }
      saveSelectedCities(this.selectedCities);
      this.renderClocks();
    });

    this.outsideClickHandler = (e: MouseEvent) => {
      if (this.popoverEl.style.display === 'none') return;
      if (!this.popoverEl.contains(e.target as Node) && !(e.target as HTMLElement).closest('.wc-settings-btn')) {
        this.closePopover();
      }
    };
    document.addEventListener('click', this.outsideClickHandler);

    this.setupHeader();
    this.renderClocks();
    this.tickInterval = setInterval(() => this.renderClocks(), 1000);
  }

  private setupHeader(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'wc-header-right';
    const btn = document.createElement('button');
    btn.className = 'wc-settings-btn';
    btn.textContent = '\u2699';
    btn.title = 'Settings';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePopover();
    });
    wrapper.appendChild(btn);
    this.header.appendChild(wrapper);
  }

  private togglePopover(): void {
    if (this.popoverEl.style.display === 'none') {
      this.openPopover();
    } else {
      this.closePopover();
    }
  }

  private openPopover(): void {
    let html = '';
    for (const city of WORLD_CITIES) {
      const checked = this.selectedCities.includes(city.id) ? 'checked' : '';
      html += `<label><input type="checkbox" data-city-id="${city.id}" ${checked}> ${city.city} (${city.label})</label>`;
    }
    this.popoverEl.innerHTML = html;
    this.popoverEl.style.display = 'block';
  }

  private closePopover(): void {
    this.popoverEl.style.display = 'none';
  }

  private renderClocks(): void {
    const sorted = this.selectedCities
      .map(id => WORLD_CITIES.find(c => c.id === id))
      .filter((c): c is CityEntry => !!c);

    let html = STYLE + '<div class="wc-rows">';
    for (const city of sorted) {
      const { h, m, s, dayOfWeek } = getTimeInZone(city.timezone);
      const isDay = h >= 6 && h < 20;
      const pct = ((h * 3600 + m * 60 + s) / 86400) * 100;
      const abbr = getTzAbbr(city.timezone);
      const isHome = city.id === this.homeCityId;
      let marketStatus = '';
      if (city.marketOpen !== undefined && city.marketClose !== undefined) {
        const open = h >= city.marketOpen && h < city.marketClose;
        marketStatus = open
          ? '<span class="wc-market-open">OPEN</span>'
          : '<span class="wc-market-closed">CLOSED</span>';
      }
      html += `<div class="wc-row${isHome ? ' wc-home' : ''}">
        <div>
          <div class="wc-city">${city.city}${isHome ? ' \u2302' : ''}</div>
          <div class="wc-label">${city.label}</div>
        </div>
        <div class="wc-right">
          <div class="wc-time">${pad2(h)}:${pad2(m)}:${pad2(s)}</div>
          <div class="wc-meta">
            ${marketStatus}
            <div class="wc-bar-wrap"><div class="wc-bar ${isDay ? 'day' : 'night'}" style="width:${pct.toFixed(1)}%"></div></div>
            <span>${dayOfWeek} ${abbr}</span>
          </div>
        </div>
      </div>`;
    }
    html += '</div>';
    this.setContent(html);
  }

  destroy(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    document.removeEventListener('click', this.outsideClickHandler);
    super.destroy();
  }
}
