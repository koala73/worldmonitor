import type {
  EconomicServiceClient,
  GetChinaMacroSnapshotResponse,
} from '@/generated/client/worldmonitor/economic/v1/service_client';
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { getEurostatCountryData } from '@/services/economic';
import type { GetEurostatCountryDataResponse } from '@/services/economic';
import { getHydratedData } from '@/services/bootstrap';
import {
  chinaTileHtml,
  hasChinaMacroData,
  isChinaLaunchReady,
  normalizeHydratedChina,
} from './macro-tiles-china';

let _client: EconomicServiceClient | null = null;
async function getEconomicClient(): Promise<EconomicServiceClient> {
  if (!_client) {
    const { EconomicServiceClient } = await import('@/generated/client/worldmonitor/economic/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _client;
}

type Tab = 'us' | 'eu' | 'cn';

interface MacroTile {
  id: string;
  label: string;
  value: number | null;
  prior: number | null;
  date: string;
  lowerIsBetter: boolean;
  neutral?: boolean;
  format: (v: number) => string;
  deltaFormat?: (v: number) => string;
}

function pctFmt(v: number): string {
  return `${v.toFixed(1)}%`;
}

function gdpFmt(v: number): string {
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}B`;
}

function cpiYoY(obs: { date: string; value: number }[]): { value: number | null; prior: number | null; date: string } {
  if (obs.length < 13) return { value: null, prior: null, date: '' };
  const latest = obs[obs.length - 1];
  const yearAgo = obs[obs.length - 13];
  const priorMonth = obs[obs.length - 2];
  const priorYearAgo = obs[obs.length - 14] ?? obs[obs.length - 13];
  if (!latest || !yearAgo) return { value: null, prior: null, date: '' };
  const yoy = yearAgo.value > 0 ? ((latest.value - yearAgo.value) / yearAgo.value) * 100 : null;
  const priorYoy = (priorYearAgo && priorMonth && priorYearAgo.value > 0)
    ? ((priorMonth.value - priorYearAgo.value) / priorYearAgo.value) * 100
    : null;
  return { value: yoy, prior: priorYoy, date: latest.date };
}

function lastTwo(obs: { date: string; value: number }[]): { value: number | null; prior: number | null; date: string } {
  const last = obs[obs.length - 1];
  if (!obs.length || !last) return { value: null, prior: null, date: '' };
  const prev = obs[obs.length - 2];
  return { value: last.value, prior: prev?.value ?? null, date: last.date };
}

function deltaColor(delta: number, lowerIsBetter: boolean, neutral: boolean): string {
  if (neutral) return 'var(--text-dim)';
  if (delta === 0) return 'var(--text-dim)';
  return (lowerIsBetter ? delta < 0 : delta > 0) ? '#27ae60' : '#e74c3c';
}

function tileHtml(tile: MacroTile): string {
  const val = tile.value !== null ? escapeHtml(tile.format(tile.value)) : 'N/A';
  const delta = tile.value !== null && tile.prior !== null ? tile.value - tile.prior : null;
  const fmt = tile.deltaFormat ?? tile.format;
  const deltaStr = delta !== null ? `${delta >= 0 ? '+' : ''}${fmt(delta)} vs prior` : '';
  const color = delta !== null ? deltaColor(delta, tile.lowerIsBetter, tile.neutral ?? false) : 'var(--text-dim)';
  return `<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;padding:14px 12px;display:flex;flex-direction:column;gap:4px">
    <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.07em">${escapeHtml(tile.label)}</div>
    <div style="font-size:28px;font-weight:700;color:var(--text);line-height:1.1;font-variant-numeric:tabular-nums">${val}</div>
    ${deltaStr ? `<div style="font-size:11px;color:${color}">${escapeHtml(deltaStr)}</div>` : ''}
    <div style="font-size:10px;color:var(--text-dim)">${escapeHtml(tile.date)}</div>
  </div>`;
}

const EU_CORE = ['DE', 'FR', 'IT', 'ES'];

function fmtEuDate(d: string): string {
  if (!d) return '';
  // YYYY-MM → "Jan 2026"; YYYY-QN stays as-is
  const parts = /^(\d{4})-(\d{2})$/.exec(d);
  if (parts) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mon = months[parseInt(parts[2] ?? '0', 10) - 1];
    return mon ? `${mon} ${parts[1] ?? d}` : d;
  }
  return d;
}

function euAvg(
  eurostat: GetEurostatCountryDataResponse,
  key: 'cpi' | 'unemployment' | 'gdpGrowth',
): { value: number | null; prior: number | null; date: string } {
  const values: number[] = [];
  const priorValues: number[] = [];
  let latestDate = '';
  for (const code of EU_CORE) {
    const m = eurostat.countries[code]?.[key];
    if (m && typeof m.value === 'number' && Number.isFinite(m.value)) {
      values.push(m.value);
      if (!latestDate || m.date > latestDate) latestDate = m.date;
    }
    if (m?.hasPrior && Number.isFinite(m.priorValue)) {
      priorValues.push(m.priorValue);
    }
  }
  if (values.length === 0) return { value: null, prior: null, date: '' };
  const avg = Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
  const priorAvg = priorValues.length === values.length
    ? Math.round((priorValues.reduce((s, v) => s + v, 0) / priorValues.length) * 100) / 100
    : null;
  return { value: avg, prior: priorAvg, date: fmtEuDate(latestDate) };
}

export class MacroTilesPanel extends Panel {
  private _hasData = false;
  private _tab: Tab = 'us';
  private _usTiles: MacroTile[] = [];
  private _eurostat: GetEurostatCountryDataResponse | null = null;
  private _estrObs: { date: string; value: number }[] = [];
  private _china: GetChinaMacroSnapshotResponse | null = null;

  constructor() {
    super({ id: 'macro-tiles', title: 'Macro Indicators', showCount: false, infoTooltip: t('components.macroTiles.infoTooltip') });

    this.content.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (btn?.dataset.tab === 'us' || btn?.dataset.tab === 'eu' || btn?.dataset.tab === 'cn') {
        this._tab = btn.dataset.tab as Tab;
        this._render();
      }
    });
    this.content.addEventListener('keydown', (e) => {
      if (!(e instanceof KeyboardEvent)) return;
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"][data-tab]');
      if (!btn || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      const tabs = this._availableTabs();
      const current = tabs.indexOf(btn.dataset.tab as Tab);
      if (current < 0) return;
      e.preventDefault();
      const next = e.key === 'Home'
        ? tabs[0]
        : e.key === 'End'
          ? tabs[tabs.length - 1]
          : tabs[(current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      if (!next) return;
      this._tab = next;
      this._render(() => {
        this.content.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
      });
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const client = await getEconomicClient();
      const hydratedMacro = getHydratedData('chinaMacro');
      const hydratedCalendar = getHydratedData('chinaReleaseCalendar');
      const hydratedChina = normalizeHydratedChina(hydratedMacro, hydratedCalendar);
      const [fredResp, eurostatResp, chinaResp] = await Promise.allSettled([
        client.getFredSeriesBatch({
          seriesIds: ['CPIAUCSL', 'UNRATE', 'GDP', 'FEDFUNDS', 'ESTR'],
          limit: 14,
        }),
        getEurostatCountryData(),
        hydratedChina ?? client.getChinaMacroSnapshot({}),
      ]);

      const results = fredResp.status === 'fulfilled' ? (fredResp.value.results ?? {}) : {};
      this._estrObs = results['ESTR']?.observations ?? [];

      if (eurostatResp.status === 'fulfilled' && !eurostatResp.value.unavailable) {
        this._eurostat = eurostatResp.value;
      }
      this._china = chinaResp.status === 'fulfilled' ? chinaResp.value : null;

      const cpi = cpiYoY(results['CPIAUCSL']?.observations ?? []);
      const unrate = lastTwo(results['UNRATE']?.observations ?? []);
      const gdp = lastTwo(results['GDP']?.observations ?? []);
      const fed = lastTwo(results['FEDFUNDS']?.observations ?? []);

      this._usTiles = [
        { id: 'cpi', label: 'CPI (YoY)', ...cpi, lowerIsBetter: true, format: pctFmt, deltaFormat: (v) => v.toFixed(2) },
        { id: 'unrate', label: 'Unemployment', ...unrate, lowerIsBetter: true, format: pctFmt },
        { id: 'gdp', label: 'GDP (Billions)', ...gdp, lowerIsBetter: false, format: gdpFmt, deltaFormat: (v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}B` },
        { id: 'fed', label: 'Fed Funds Rate', ...fed, lowerIsBetter: false, neutral: true, format: pctFmt },
      ];

      const hasUs = this._usTiles.some(t => t.value !== null);
      const hasEu = this._eurostat !== null;
      const hasChina = hasChinaMacroData(this._china);
      if (!hasUs && !hasEu && !hasChina) {
        if (!this._hasData) this.showError('Macro data unavailable', () => void this.fetchData());
        return false;
      }
      if (!hasUs && this._tab === 'us') this._tab = hasChina ? 'cn' : 'eu';
      if (!hasChina && this._tab === 'cn') this._tab = hasUs ? 'us' : 'eu';

      this._hasData = true;
      this._render();
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  private _render(afterUpdate?: () => void): void {
    const tabs = this._availableTabs();
    const labels: Record<Tab, string> = { us: 'US', eu: 'Euro Area', cn: 'China' };
    const tabBar = `<div role="tablist" aria-label="Macro economy" style="display:flex;gap:4px;margin-bottom:10px;overflow-x:auto">
      ${tabs.map((tab) => `<button id="macro-tiles-tab-${tab}" role="tab" aria-selected="${this._tab === tab}" aria-controls="macro-tiles-tabpanel" tabindex="${this._tab === tab ? '0' : '-1'}" class="panel-tab${this._tab === tab ? ' active' : ''}" data-tab="${tab}" style="font-size:11px;padding:6px 10px;min-height:44px">${labels[tab]}</button>`).join('')}
    </div>`;

    let body: string;
    if (this._tab === 'us') {
      body = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px">${this._usTiles.map(tileHtml).join('')}</div>`;
    } else if (this._tab === 'eu') {
      body = this._buildEuBody();
    } else {
      body = this._buildChinaBody();
    }

    const labelledBy = `macro-tiles-tab-${this._tab}`;
    this.setSafeContent(
      unsafeRawHtml(`${tabBar}<div id="macro-tiles-tabpanel" role="tabpanel" aria-labelledby="${labelledBy}">${body}</div>`, 'legacy Panel.setContent() migration'),
      afterUpdate,
    );
  }

  private _availableTabs(): Tab[] {
    return hasChinaMacroData(this._china) ? ['us', 'eu', 'cn'] : ['us', 'eu'];
  }

  private _buildChinaBody(): string {
    if (!hasChinaMacroData(this._china) || !this._china) {
      return '<div style="padding:8px;color:var(--text-dim);font-size:12px">China macro data unavailable</div>';
    }
    const quality = isChinaLaunchReady(this._china)
      ? ''
      : '<div style="margin-bottom:8px;padding:7px 9px;border:1px solid #f39c12;border-radius:5px;color:#f39c12;font-size:10px">Official China macro pulse is degraded; stale or delayed observations remain visible below.</div>';
    const tiles = this._china.indicators.map(chinaTileHtml).join('');
    const today = new Date().toISOString().slice(0, 10);
    const events = this._china.releaseEvents
      .filter((event) => event.countryCode === 'CN' && event.releaseDate >= today)
      .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate))
      .slice(0, 3);
    const calendar = events.length > 0
      ? `<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px">
          <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:5px">China release calendar</div>
          ${events.map((event) => `<div style="display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--text-dim);margin-top:3px"><span>${escapeHtml(event.event)}</span><span>${escapeHtml(event.releaseDate)} · ${escapeHtml(event.status)}</span></div>`).join('')}
        </div>`
      : '<div style="margin-top:8px;font-size:10px;color:var(--text-dim)">China release calendar unavailable</div>';
    return `${quality}<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px">${tiles}</div>${calendar}`;
  }

  private _buildEuBody(): string {
    if (!this._eurostat) {
      return '<div style="padding:8px;color:var(--text-dim);font-size:12px">Euro Area data unavailable</div>';
    }
    const cpiAvg = euAvg(this._eurostat, 'cpi');
    const unAvg = euAvg(this._eurostat, 'unemployment');
    const gdpAvg = euAvg(this._eurostat, 'gdpGrowth');
    const estr = lastTwo(this._estrObs);

    const euTiles: MacroTile[] = [
      { id: 'eu-cpi', label: 'HICP (YoY)', value: cpiAvg.value, prior: cpiAvg.prior, date: cpiAvg.date, lowerIsBetter: true, format: pctFmt },
      { id: 'eu-un', label: 'Unemployment', value: unAvg.value, prior: unAvg.prior, date: unAvg.date, lowerIsBetter: true, format: pctFmt },
      { id: 'eu-gdp', label: 'GDP Growth (QoQ)', value: gdpAvg.value, prior: gdpAvg.prior, date: gdpAvg.date, lowerIsBetter: false, format: pctFmt },
      { id: 'eu-estr', label: '€STR (ECB Rate)', ...estr, lowerIsBetter: false, neutral: true, format: pctFmt },
    ];

    if (!euTiles.some(t => t.value !== null)) {
      return '<div style="padding:8px;color:var(--text-dim);font-size:12px">Euro Area data unavailable</div>';
    }

    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px">${euTiles.map(tileHtml).join('')}</div>
      <div style="margin-top:8px;font-size:9px;color:var(--text-dim)">Eurostat · ECB · avg DE, FR, IT, ES</div>`;
  }
}
