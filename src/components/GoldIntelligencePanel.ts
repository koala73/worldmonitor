import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { toApiUrl } from '@/services/runtime';
import { miniSparkline } from '@/utils/sparkline';

interface CrossCurrencyPrice { currency: string; flag: string; price: number }
interface CotCategory { longPositions: string; shortPositions: string; netPct: number; oiSharePct: number; wowNetDelta: string }
interface CotData {
  reportDate: string;
  nextReleaseDate: string;
  openInterest: string;
  managedMoney?: CotCategory;
  producerSwap?: CotCategory;
}
interface SessionRange { dayHigh: number; dayLow: number; prevClose: number }
interface Returns { w1: number; m1: number; ytd: number; y1: number }
interface Range52w { hi: number; lo: number; positionPct: number }
interface Driver { symbol: string; label: string; value: number; changePct: number; correlation30d: number }
interface CbHolder { iso3: string; name: string; tonnes: number; pctOfReserves: number }
interface CbMover { iso3: string; name: string; deltaTonnes12m: number }
interface CbReserves {
  asOfMonth: string;
  totalTonnes: number;
  topHolders: CbHolder[];
  topBuyers12m: CbMover[];
  topSellers12m: CbMover[];
}

interface EtfFlows {
  asOfDate: string;
  tonnes: number;
  aumUsd: number;
  nav: number;
  changeW1Tonnes: number;
  changeM1Tonnes: number;
  changeY1Tonnes: number;
  changeW1Pct: number;
  changeM1Pct: number;
  changeY1Pct: number;
  sparkline90d: number[];
}

interface GoldIntelligenceData {
  goldPrice: number;
  goldChangePct: number;
  goldSparkline: number[];
  silverPrice: number;
  platinumPrice: number;
  palladiumPrice: number;
  goldSilverRatio?: number;
  goldPlatinumPremiumPct?: number;
  crossCurrencyPrices: CrossCurrencyPrice[];
  cot?: CotData;
  session?: SessionRange;
  returns?: Returns;
  range52w?: Range52w;
  drivers: Driver[];
  etfFlows?: EtfFlows;
  cbReserves?: CbReserves;
  updatedAt: string;
  unavailable?: boolean;
}

function fmtPrice(v: number, decimals = 2): string {
  if (!Number.isFinite(v) || v <= 0) return '--';
  return v >= 10000 ? Math.round(v).toLocaleString() : v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtInt(raw: string | number): string {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  if (!Number.isFinite(n)) return '--';
  return Math.round(n).toLocaleString();
}

function fmtPct(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '--';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(decimals)}%`;
}

function fmtSignedInt(raw: string | number): string {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  if (!Number.isFinite(n)) return '--';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${Math.round(n).toLocaleString()}`;
}

function freshnessLabel(iso: string): { text: string; dot: string } {
  if (!iso) return { text: 'Updated —', dot: 'var(--text-dim)' };
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return { text: 'Updated now', dot: '#2ecc71' };
  const mins = Math.floor(diffMs / 60000);
  const dot = mins < 10 ? '#2ecc71' : mins < 30 ? '#f5a623' : '#e74c3c';
  if (mins < 1) return { text: 'Updated just now', dot };
  if (mins < 60) return { text: `Updated ${mins}m ago`, dot };
  const hrs = Math.floor(mins / 60);
  return { text: `Updated ${hrs}h ago`, dot };
}

function renderRangeBar(lo: number, hi: number, current: number, positionPct: number): string {
  const clamped = Math.max(0, Math.min(100, positionPct));
  return `
    <div style="position:relative;height:8px;background:linear-gradient(90deg,rgba(231,76,60,0.25),rgba(245,166,35,0.25),rgba(46,204,113,0.25));border-radius:4px;margin:6px 0">
      <div style="position:absolute;top:-3px;bottom:-3px;left:${clamped.toFixed(1)}%;width:3px;background:#fff;border-radius:1px;box-shadow:0 0 4px rgba(255,255,255,0.8);transform:translateX(-50%)"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim)">
      <span>Low $${escapeHtml(fmtPrice(lo))}</span>
      <span style="color:var(--text);font-weight:600">$${escapeHtml(fmtPrice(current))} • ${clamped.toFixed(0)}% of range</span>
      <span>High $${escapeHtml(fmtPrice(hi))}</span>
    </div>`;
}

function renderPositionBar(netPct: number, label: string, wow: string): string {
  const clamped = Math.max(-100, Math.min(100, netPct));
  const halfWidth = Math.abs(clamped) / 100 * 50;
  const color = clamped >= 0 ? '#2ecc71' : '#e74c3c';
  const leftPct = clamped >= 0 ? 50 : 50 - halfWidth;
  const sign = clamped >= 0 ? '+' : '';
  const wowN = parseInt(wow, 10);
  const wowStr = Number.isFinite(wowN) && wowN !== 0 ? ` <span style="font-size:9px;color:${wowN >= 0 ? '#2ecc71' : '#e74c3c'};font-weight:500">Δ ${fmtSignedInt(wow)}</span>` : '';
  return `
    <div style="margin:4px 0">
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim);margin-bottom:2px">
        <span>${escapeHtml(label)}${wowStr}</span>
        <span style="color:${color};font-weight:600">${sign}${clamped.toFixed(1)}%</span>
      </div>
      <div style="position:relative;height:8px;background:rgba(255,255,255,0.06);border-radius:2px">
        <div style="position:absolute;top:0;bottom:0;left:50%;width:1px;background:rgba(255,255,255,0.15)"></div>
        <div style="position:absolute;top:0;bottom:0;left:${leftPct.toFixed(2)}%;width:${halfWidth.toFixed(2)}%;background:${color};border-radius:1px"></div>
      </div>
    </div>`;
}

function ratioLabel(ratio: number): { text: string; color: string } {
  if (ratio > 80) return { text: 'Silver undervalued', color: '#f5a623' };
  if (ratio < 60) return { text: 'Gold undervalued', color: '#f5a623' };
  return { text: 'Neutral', color: 'var(--text-dim)' };
}

function returnChip(label: string, pct: number): string {
  const color = pct >= 0 ? '#2ecc71' : '#e74c3c';
  return `<div style="flex:1;text-align:center;padding:4px;background:rgba(255,255,255,0.03);border-radius:4px">
    <div style="font-size:9px;color:var(--text-dim)">${escapeHtml(label)}</div>
    <div style="font-size:11px;font-weight:600;color:${color}">${escapeHtml(fmtPct(pct, 1))}</div>
  </div>`;
}

export class GoldIntelligencePanel extends Panel {
  private _hasData = false;

  constructor() {
    super({ id: 'gold-intelligence', title: t('panels.goldIntelligence'), infoTooltip: t('components.goldIntelligence.infoTooltip') });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const url = toApiUrl('/api/market/v1/get-gold-intelligence');
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: GoldIntelligenceData = await resp.json();

      if (data.unavailable) {
        if (!this._hasData) this.showError('Gold data unavailable', () => void this.fetchData());
        return false;
      }

      if (!this.element?.isConnected) return false;
      this._hasData = true;
      this.render(data);
      return true;
    } catch (e) {
      if (this.isAbortError(e)) return false;
      if (!this.element?.isConnected) return false;
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  private renderHeader(d: GoldIntelligenceData): string {
    const changePct = d.goldChangePct;
    const changeColor = changePct >= 0 ? '#2ecc71' : '#e74c3c';
    const spark = miniSparkline(d.goldSparkline, changePct, 80, 20);
    const fresh = freshnessLabel(d.updatedAt);

    const sessionLine = d.session && d.session.dayHigh > 0
      ? `<div style="font-size:9px;color:var(--text-dim);margin-top:2px">
          Session H $${escapeHtml(fmtPrice(d.session.dayHigh))} • L $${escapeHtml(fmtPrice(d.session.dayLow))} • Prev $${escapeHtml(fmtPrice(d.session.prevClose))}
        </div>`
      : '';

    return `
      <div class="energy-tape-section">
        <div class="energy-section-title">Price &amp; Performance</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:16px;font-weight:700">$${escapeHtml(fmtPrice(d.goldPrice))}</span>
          <span style="font-size:11px;font-weight:600;color:${changeColor};padding:1px 6px;border-radius:3px;background:${changeColor}22">${fmtPct(changePct)}</span>
          ${spark}
        </div>
        <div style="display:flex;align-items:center;gap:6px;font-size:9px;color:var(--text-dim)">
          <span style="width:6px;height:6px;border-radius:50%;background:${fresh.dot};display:inline-block"></span>
          <span>${escapeHtml(fresh.text)} • GC=F front-month</span>
        </div>
        ${sessionLine}
      </div>`;
  }

  private renderReturns(d: GoldIntelligenceData): string {
    if (!d.returns && !d.range52w) return '';
    const chips = d.returns
      ? `<div style="display:flex;gap:4px;margin-top:6px">
          ${returnChip('1W', d.returns.w1)}
          ${returnChip('1M', d.returns.m1)}
          ${returnChip('YTD', d.returns.ytd)}
          ${returnChip('1Y', d.returns.y1)}
        </div>`
      : '';
    const range = d.range52w && d.range52w.hi > 0
      ? `<div style="margin-top:8px">
          <div style="font-size:9px;color:var(--text-dim)">52-week range</div>
          ${renderRangeBar(d.range52w.lo, d.range52w.hi, d.goldPrice, d.range52w.positionPct)}
        </div>`
      : '';
    return `<div class="energy-tape-section" style="margin-top:10px">
      <div class="energy-section-title">Returns</div>
      ${chips}
      ${range}
    </div>`;
  }

  private renderMetals(d: GoldIntelligenceData): string {
    const ratioHtml = d.goldSilverRatio != null && Number.isFinite(d.goldSilverRatio)
      ? (() => {
        const rl = ratioLabel(d.goldSilverRatio!);
        return `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
          <span style="font-size:10px;color:var(--text-dim)">Gold/Silver Ratio</span>
          <span style="font-size:11px;font-weight:600">${escapeHtml(d.goldSilverRatio!.toFixed(1))} <span style="font-size:9px;color:${rl.color};font-weight:400">${escapeHtml(rl.text)}</span></span>
        </div>`;
      })()
      : '';

    const premiumHtml = d.goldPlatinumPremiumPct != null && Number.isFinite(d.goldPlatinumPremiumPct)
      ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
          <span style="font-size:10px;color:var(--text-dim)">Gold vs Platinum</span>
          <span style="font-size:11px;font-weight:600">${escapeHtml(fmtPct(d.goldPlatinumPremiumPct, 1))} premium</span>
        </div>`
      : '';

    const tiles = [
      { label: 'Silver', price: d.silverPrice },
      { label: 'Platinum', price: d.platinumPrice },
      { label: 'Palladium', price: d.palladiumPrice },
    ].map(m =>
      `<div style="flex:1;text-align:center;padding:4px;background:rgba(255,255,255,0.03);border-radius:4px">
        <div style="font-size:9px;color:var(--text-dim)">${escapeHtml(m.label)}</div>
        <div style="font-size:11px;font-weight:600">$${escapeHtml(fmtPrice(m.price))}</div>
      </div>`).join('');

    return `<div class="energy-tape-section" style="margin-top:10px">
      <div class="energy-section-title">Metals Complex</div>
      ${ratioHtml}
      ${premiumHtml}
      <div style="display:flex;gap:6px;margin-top:8px">${tiles}</div>
    </div>`;
  }

  private renderFx(d: GoldIntelligenceData): string {
    if (!d.crossCurrencyPrices.length) return '';
    const rows = d.crossCurrencyPrices.map(c =>
      `<div style="text-align:center;padding:4px;background:rgba(255,255,255,0.03);border-radius:4px">
        <div style="font-size:9px;color:var(--text-dim)">${escapeHtml(c.flag)} XAU/${escapeHtml(c.currency)}</div>
        <div style="font-size:11px;font-weight:600">${escapeHtml(fmtPrice(c.price, 0))}</div>
      </div>`).join('');
    return `<div class="energy-tape-section" style="margin-top:10px">
      <div class="energy-section-title">Gold in Major Currencies</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">${rows}</div>
    </div>`;
  }

  private renderPositioning(d: GoldIntelligenceData): string {
    const c = d.cot;
    if (!c) return '';
    const mm = c.managedMoney;
    const ps = c.producerSwap;
    const mmBar = mm ? renderPositionBar(mm.netPct, 'Managed Money (speculators)', mm.wowNetDelta) : '';
    const psBar = ps ? renderPositionBar(ps.netPct, 'Producer/Swap (commercials)', ps.wowNetDelta) : '';

    const detail = (cat: CotCategory | undefined, label: string) => cat
      ? `<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim);padding:2px 0">
          <span>${escapeHtml(label)}</span>
          <span>L ${escapeHtml(fmtInt(cat.longPositions))} / S ${escapeHtml(fmtInt(cat.shortPositions))} • ${cat.oiSharePct.toFixed(1)}% OI</span>
        </div>`
      : '';

    const releaseLine = c.reportDate
      ? `<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim);margin-top:6px">
          <span>As of ${escapeHtml(c.reportDate)}${c.nextReleaseDate ? ` • next release ${escapeHtml(c.nextReleaseDate)}` : ''}</span>
          <span>OI ${escapeHtml(fmtInt(c.openInterest))}</span>
        </div>`
      : '';

    return `<div class="energy-tape-section" style="margin-top:10px">
      <div class="energy-section-title">CFTC Positioning</div>
      ${mmBar}
      ${detail(mm, 'MM breakdown')}
      ${psBar}
      ${detail(ps, 'P/S breakdown')}
      ${releaseLine}
    </div>`;
  }

  private renderCbReserves(d: GoldIntelligenceData): string {
    const cb = d.cbReserves;
    if (!cb || !cb.topHolders.length) return '';

    const holderRow = (h: CbHolder, rank: number) => `<div style="display:flex;justify-content:space-between;font-size:10px;padding:1px 0">
      <span style="color:var(--text-dim)">${rank}. ${escapeHtml(h.name)}</span>
      <span style="font-weight:600">${h.tonnes > 0 ? `${h.tonnes.toFixed(1)}t` : '—'}</span>
    </div>`;
    const moverRow = (m: CbMover) => {
      const color = m.deltaTonnes12m >= 0 ? '#2ecc71' : '#e74c3c';
      const sign = m.deltaTonnes12m >= 0 ? '+' : '';
      return `<div style="display:flex;justify-content:space-between;font-size:10px;padding:1px 0">
        <span style="color:var(--text-dim)">${escapeHtml(m.name)}</span>
        <span style="color:${color};font-weight:600">${sign}${m.deltaTonnes12m.toFixed(1)}t</span>
      </div>`;
    };

    const holders = cb.topHolders.slice(0, 10).map((h, i) => holderRow(h, i + 1)).join('');
    const buyers = cb.topBuyers12m.slice(0, 5).map(moverRow).join('');
    const sellers = cb.topSellers12m.slice(0, 5).map(moverRow).join('');

    const moversHtml = (buyers || sellers)
      ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
          <div>
            <div style="font-size:9px;color:var(--text-dim);text-transform:uppercase;margin-bottom:2px">Buyers 12M</div>
            ${buyers || '<div style="font-size:9px;color:var(--text-dim)">—</div>'}
          </div>
          <div>
            <div style="font-size:9px;color:var(--text-dim);text-transform:uppercase;margin-bottom:2px">Sellers 12M</div>
            ${sellers || '<div style="font-size:9px;color:var(--text-dim)">—</div>'}
          </div>
        </div>`
      : '';

    return `<div class="energy-tape-section" style="margin-top:10px">
      <div class="energy-section-title">Central-Bank Reserves</div>
      <div style="font-size:9px;color:var(--text-dim);margin-bottom:4px">Top holders (tonnes)</div>
      ${holders}
      ${moversHtml}
      <div style="font-size:9px;color:var(--text-dim);margin-top:6px;text-align:right">IMF IFS • as of ${escapeHtml(cb.asOfMonth)}</div>
    </div>`;
  }

  private renderEtfFlows(d: GoldIntelligenceData): string {
    const f = d.etfFlows;
    if (!f || !Number.isFinite(f.tonnes) || f.tonnes <= 0) return '';

    const chip = (label: string, deltaT: number, deltaPct: number) => {
      const color = deltaT >= 0 ? '#2ecc71' : '#e74c3c';
      const tSign = deltaT >= 0 ? '+' : '';
      const pSign = deltaPct >= 0 ? '+' : '';
      return `<div style="flex:1;text-align:center;padding:4px;background:rgba(255,255,255,0.03);border-radius:4px">
        <div style="font-size:9px;color:var(--text-dim)">${escapeHtml(label)}</div>
        <div style="font-size:11px;font-weight:600;color:${color}">${tSign}${deltaT.toFixed(1)}t</div>
        <div style="font-size:9px;color:${color}">${pSign}${deltaPct.toFixed(2)}%</div>
      </div>`;
    };

    const aumStr = f.aumUsd >= 1e9 ? `$${(f.aumUsd / 1e9).toFixed(1)}B` : f.aumUsd > 0 ? `$${(f.aumUsd / 1e6).toFixed(0)}M` : '--';
    const spark = f.sparkline90d.length > 1 ? miniSparkline(f.sparkline90d, f.changeM1Pct, 80, 20) : '';

    return `<div class="energy-tape-section" style="margin-top:10px">
      <div class="energy-section-title">Physical Flows (GLD)</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px">
        <div>
          <span style="font-size:14px;font-weight:700">${escapeHtml(f.tonnes.toFixed(1))} <span style="font-size:10px;color:var(--text-dim);font-weight:500">tonnes</span></span>
          <span style="font-size:10px;color:var(--text-dim);margin-left:6px">AUM ${escapeHtml(aumStr)}${f.nav > 0 ? ` • NAV $${f.nav.toFixed(2)}` : ''}</span>
        </div>
        ${spark}
      </div>
      <div style="display:flex;gap:4px;margin-top:4px">
        ${chip('1W', f.changeW1Tonnes, f.changeW1Pct)}
        ${chip('1M', f.changeM1Tonnes, f.changeM1Pct)}
        ${chip('1Y', f.changeY1Tonnes, f.changeY1Pct)}
      </div>
      <div style="font-size:9px;color:var(--text-dim);margin-top:4px;text-align:right">SPDR GLD • as of ${escapeHtml(f.asOfDate)}</div>
    </div>`;
  }

  private renderDrivers(d: GoldIntelligenceData): string {
    if (!d.drivers?.length) return '';
    const rows = d.drivers.map(dr => {
      const color = dr.changePct >= 0 ? '#2ecc71' : '#e74c3c';
      const corrColor = dr.correlation30d <= -0.3 ? '#2ecc71' : dr.correlation30d >= 0.3 ? '#e74c3c' : 'var(--text-dim)';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:10px">
        <span style="color:var(--text-dim)">${escapeHtml(dr.label)}</span>
        <span>
          <span style="font-weight:600">${escapeHtml(dr.value.toFixed(2))}</span>
          <span style="color:${color};margin-left:4px">${escapeHtml(fmtPct(dr.changePct, 2))}</span>
          <span style="color:${corrColor};margin-left:8px;font-size:9px">corr 30d ${dr.correlation30d >= 0 ? '+' : ''}${dr.correlation30d.toFixed(2)}</span>
        </span>
      </div>`;
    }).join('');
    return `<div class="energy-tape-section" style="margin-top:10px">
      <div class="energy-section-title">Drivers</div>
      ${rows}
    </div>`;
  }

  private render(d: GoldIntelligenceData): void {
    const html = [
      this.renderHeader(d),
      this.renderReturns(d),
      this.renderMetals(d),
      this.renderFx(d),
      this.renderPositioning(d),
      this.renderEtfFlows(d),
      this.renderCbReserves(d),
      this.renderDrivers(d),
    ].join('');
    this.setContent(`<div style="padding:10px 14px">${html}</div>`);
  }
}
