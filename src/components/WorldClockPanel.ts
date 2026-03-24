import { Panel } from './Panel';
import { getLocale } from '@/services/i18n';

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

const CITY_REGIONS: { name: string; ids: string[] }[] = [
  { name: 'Americas', ids: ['new-york', 'chicago', 'toronto', 'los-angeles', 'mexico-city', 'sao-paulo', 'buenos-aires'] },
  { name: 'Europe', ids: ['london', 'paris', 'frankfurt', 'zurich', 'moscow', 'istanbul'] },
  { name: 'Middle East & Africa', ids: ['riyadh', 'dubai', 'cairo', 'lagos', 'johannesburg'] },
  { name: 'Asia-Pacific', ids: ['mumbai', 'bangkok', 'jakarta', 'kuala-lumpur', 'singapore', 'hong-kong', 'shanghai', 'taipei', 'seoul', 'tokyo', 'sydney', 'auckland'] },
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
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat(getLocale(), {
      timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric',
      hour12: false, weekday: 'short',
      numberingSystem: 'latn',
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
  } catch {
    return { h: 0, m: 0, s: 0, dayOfWeek: '' };
  }
}

function getTzAbbr(tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat(getLocale(), { timeZone: tz, timeZoneName: 'short' });
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

/* Styles moved to panels.css (PERF-012) */

export class WorldClockPanel extends Panel {
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private selectedCities: string[] = [];
  private homeCityId: string | null = null;
  private showingSettings = false;
  private settingsBtn: HTMLButtonElement;
  private dragging = false;
  private dragCityId: string | null = null;
  private dragStartY = 0;

  constructor() {
    super({ id: 'world-clock', title: 'World Clock', trackActivity: false });
    this.homeCityId = detectHomeCity();
    this.selectedCities = loadSelectedCities();

    this.settingsBtn = document.createElement('button');
    this.settingsBtn.className = 'wc-settings-btn';
    this.settingsBtn.textContent = '\u2699';
    this.settingsBtn.title = 'Select cities';
    this.settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSettings();
    });
    this.header.appendChild(this.settingsBtn);

    this.content.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.type === 'checkbox' && target.dataset.cityId) {
        const cityId = target.dataset.cityId;
        if (target.checked) {
          if (!this.selectedCities.includes(cityId)) this.selectedCities.push(cityId);
        } else {
          this.selectedCities = this.selectedCities.filter(id => id !== cityId);
        }
        saveSelectedCities(this.selectedCities);
      }
    });

    this.setupDragHandlers();
    this.renderClocks();
    this.tickInterval = setInterval(() => {
      if (!this.showingSettings && !this.dragging) this.renderClocks();
    }, 1000);
  }

  private toggleSettings(): void {
    this.showingSettings = !this.showingSettings;
    if (this.showingSettings) {
      this.settingsBtn.textContent = '\u2713';
      this.settingsBtn.title = 'Done';
      this.settingsBtn.classList.add('wc-active');
      this.renderSettings();
    } else {
      this.settingsBtn.textContent = '\u2699';
      this.settingsBtn.title = 'Select cities';
      this.settingsBtn.classList.remove('wc-active');
      this.renderClocks();
    }
  }

  private renderSettings(): void {
    let html = '<div class="wc-settings-view">';
    for (const region of CITY_REGIONS) {
      html += `<div class="wc-region-header">${region.name}</div><div class="wc-region-grid">`;
      for (const id of region.ids) {
        const city = WORLD_CITIES.find(c => c.id === id);
        if (!city) continue;
        const checked = this.selectedCities.includes(city.id) ? 'checked' : '';
        html += `<label class="wc-city-option"><input type="checkbox" data-city-id="${city.id}" ${checked}><span class="wc-opt-name">${city.city}</span><span class="wc-opt-label">${city.label}</span></label>`;
      }
      html += '</div>';
    }
    html += '</div>';
    this.setContent(html);
  }

  private setupDragHandlers(): void {
    const content = this.content;

    content.addEventListener('mousedown', (e: MouseEvent) => {
      const handle = (e.target as HTMLElement).closest('.wc-drag-handle') as HTMLElement | null;
      if (!handle) return;
      const row = handle.closest('.wc-row') as HTMLElement | null;
      if (!row) return;
      e.preventDefault();
      this.dragCityId = row.dataset.cityId ?? null;
      this.dragStartY = e.clientY;
      this.dragging = false;
      row.classList.add('wc-dragging');
      content.classList.add('wc-content-dragging');
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!this.dragCityId) return;
      if (!this.dragging && Math.abs(e.clientY - this.dragStartY) < 8) return;
      this.dragging = true;
      e.preventDefault();
      const rows = content.querySelectorAll('.wc-row[data-city-id]');
      rows.forEach(r => r.classList.remove('wc-drag-over-above', 'wc-drag-over-below'));
      for (const row of rows) {
        if ((row as HTMLElement).dataset.cityId === this.dragCityId) continue;
        const rect = row.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          row.classList.add(e.clientY < rect.top + rect.height / 2 ? 'wc-drag-over-above' : 'wc-drag-over-below');
        }
      }
    });

    document.addEventListener('mouseup', (e: MouseEvent) => {
      if (!this.dragCityId) return;
      const dragId = this.dragCityId;
      this.dragCityId = null;
      const rows = content.querySelectorAll('.wc-row[data-city-id]');
      rows.forEach(r => r.classList.remove('wc-dragging', 'wc-drag-over-above', 'wc-drag-over-below'));
      content.classList.remove('wc-content-dragging');

      if (this.dragging) {
        let targetId: string | null = null;
        let insertBefore = true;
        for (const row of rows) {
          const el = row as HTMLElement;
          if (el.dataset.cityId === dragId) continue;
          const rect = el.getBoundingClientRect();
          if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
            targetId = el.dataset.cityId ?? null;
            insertBefore = e.clientY < rect.top + rect.height / 2;
            break;
          }
        }
        if (targetId && targetId !== dragId) {
          const fromIdx = this.selectedCities.indexOf(dragId);
          if (fromIdx !== -1) {
            this.selectedCities.splice(fromIdx, 1);
            let toIdx = this.selectedCities.indexOf(targetId);
            if (!insertBefore) toIdx++;
            this.selectedCities.splice(toIdx, 0, dragId);
            saveSelectedCities(this.selectedCities);
          }
        }
      }
      this.dragging = false;
      this.renderClocks();
    });
  }

  private renderClocks(): void {
    const sorted = this.selectedCities
      .map(id => WORLD_CITIES.find(c => c.id === id))
      .filter((c): c is CityEntry => !!c);

    if (sorted.length === 0) {
      this.setContent('<div class="wc-empty">No cities selected. Click \u2699 to add cities.</div>');
      return;
    }

    let html = '<div class="wc-container" translate="no">';
    for (const city of sorted) {
      const { h, m, s, dayOfWeek } = getTimeInZone(city.timezone);
      const isDay = h >= 6 && h < 20;
      const pct = ((h * 3600 + m * 60 + s) / 86400) * 100;
      const abbr = getTzAbbr(city.timezone);
      const isHome = city.id === this.homeCityId;
      const isWeekday = dayOfWeek !== 'Sat' && dayOfWeek !== 'Sun';

      let statusHtml = '';
      if (city.marketOpen !== undefined && city.marketClose !== undefined) {
        const isOpen = isWeekday && h >= city.marketOpen && h < city.marketClose;
        statusHtml = isOpen
          ? '<span class="wc-status open"><span class="wc-dot open"></span>OPEN</span>'
          : '<span class="wc-status closed"><span class="wc-dot closed"></span>CLSD</span>';
      }

      const rowCls = ['wc-row'];
      if (isHome) rowCls.push('wc-home');
      if (!isDay) rowCls.push('wc-night');

      html += `<div class="${rowCls.join(' ')}" data-city-id="${city.id}"><div class="wc-drag-handle" title="Drag to reorder">\u22EE</div><div class="wc-info"><div class="wc-name">${city.city}${isHome ? '<span class="wc-home-tag">\u2302</span>' : ''}</div><div class="wc-detail"><span class="wc-exchange">${city.label}</span>${statusHtml}</div></div><div class="wc-clock"><div class="wc-time">${pad2(h)}:${pad2(m)}:${pad2(s)}</div><div class="wc-tz"><div class="wc-bar-wrap"><div class="wc-bar ${isDay ? 'day' : 'night'}" style="width:${pct.toFixed(1)}%"></div></div><span>${dayOfWeek} ${abbr}</span></div></div></div>`;
    }
    html += '</div>';
    this.setContent(html);
  }

  destroy(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    super.destroy();
  }
}
