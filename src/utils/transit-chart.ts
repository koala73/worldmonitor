import type { TransitDayCount } from '../generated/client/worldmonitor/supply_chain/v1/service_client';
import { getCSSColor } from '@/utils';

type ZoomWindow = 30 | 90 | 180;
type Tab = 'calls' | 'dwt';

const PAD = { top: 14, right: 38, bottom: 24, left: 4 };
const GRID_LINES = 4;

const VESSEL_KEYS: Array<keyof TransitDayCount & string> = ['container', 'dryBulk', 'generalCargo', 'roro', 'tanker'];
const CAP_KEYS: Array<keyof TransitDayCount & string> = ['capContainer', 'capDryBulk', 'capGeneralCargo', 'capRoro', 'capTanker'];
const VESSEL_COLORS = ['#dc2626', '#ea580c', '#ca8a04', '#0284c7', '#15803d'];
const VESSEL_LABELS = ['Container', 'Dry Bulk', 'Gen. Cargo', 'RoRo', 'Tanker'];
const MA_COLOR = '#f59e0b';

function compute7dMA(values: number[]): number[] {
  return values.map((_, i) => {
    const start = Math.max(0, i - 6);
    const slice = values.slice(start, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

function fmtDWT(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export class TransitChart {
  private canvas: HTMLCanvasElement | null = null;
  private tooltip: HTMLDivElement | null = null;
  private controls: HTMLDivElement | null = null;
  private legend: HTMLDivElement | null = null;
  private source: HTMLDivElement | null = null;
  private themeHandler: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private allData: TransitDayCount[] = [];
  private zoom: ZoomWindow = 90;
  private tab: Tab = 'calls';

  mount(container: HTMLElement, history: TransitDayCount[]): void {
    this.destroy();
    if (!history.length) return;

    this.allData = [...history].sort((a, b) => a.date.localeCompare(b.date));
    container.style.position = 'relative';

    this.controls = document.createElement('div');
    Object.assign(this.controls.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: '6px', gap: '6px', flexWrap: 'wrap',
    });
    this.controls.addEventListener('click', (e) => e.stopPropagation());
    container.appendChild(this.controls);

    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '180px';
    this.canvas.style.display = 'block';
    container.appendChild(this.canvas);

    this.tooltip = document.createElement('div');
    Object.assign(this.tooltip.style, {
      position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: '10',
      background: 'var(--bg-elevated, #1a1a2e)', border: '1px solid var(--border-subtle, #444)',
      borderRadius: '4px', padding: '6px 9px', fontSize: '11px', color: 'var(--text-primary, #eee)',
      whiteSpace: 'nowrap', lineHeight: '1.6',
    });
    container.appendChild(this.tooltip);

    this.legend = document.createElement('div');
    Object.assign(this.legend.style, {
      display: 'flex', flexWrap: 'wrap', gap: '8px 12px', padding: '5px 0 0',
    });
    container.appendChild(this.legend);

    this.source = document.createElement('div');
    Object.assign(this.source.style, { fontSize: '10px', color: 'var(--text-dim, #888)', paddingTop: '4px' });
    this.source.textContent = 'Source: IMF PortWatch · 180d history';
    container.appendChild(this.source);

    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mouseleave', this.onMouseLeave);

    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.canvas);

    this.themeHandler = () => { this.buildControls(); this.buildLegend(); this.draw(); };
    window.addEventListener('theme-changed', this.themeHandler);

    this.buildControls();
    this.buildLegend();
    this.draw();
  }

  destroy(): void {
    if (this.themeHandler) { window.removeEventListener('theme-changed', this.themeHandler); this.themeHandler = null; }
    if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
    if (this.canvas) {
      this.canvas.removeEventListener('mousemove', this.onMouseMove);
      this.canvas.removeEventListener('mouseleave', this.onMouseLeave);
      this.canvas.remove(); this.canvas = null;
    }
    if (this.tooltip) { this.tooltip.remove(); this.tooltip = null; }
    if (this.controls) { this.controls.remove(); this.controls = null; }
    if (this.legend) { this.legend.remove(); this.legend = null; }
    if (this.source) { this.source.remove(); this.source = null; }
    this.allData = [];
  }

  private visibleData(): TransitDayCount[] {
    return this.allData.slice(-this.zoom);
  }

  private buildControls(): void {
    const ctrl = this.controls;
    if (!ctrl) return;
    const textDim = getCSSColor('--text-dim') || '#888';
    const textPrimary = getCSSColor('--text-primary') || '#eee';
    const borderSubtle = getCSSColor('--border-subtle') || '#444';
    const accentColor = getCSSColor('--accent') || '#fff';
    const bgColor = getCSSColor('--bg') || '#000';

    const btnStyle = (active: boolean) =>
      `font-size:10px;padding:2px 7px;border-radius:3px;cursor:pointer;border:1px solid ${borderSubtle};` +
      `background:${active ? accentColor : 'transparent'};` +
      `color:${active ? bgColor : textDim};transition:background 0.15s`;

    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:4px';
    tabs.innerHTML =
      `<button data-tab="calls" style="${btnStyle(this.tab === 'calls')}">Transit Calls</button>` +
      `<button data-tab="dwt" style="${btnStyle(this.tab === 'dwt')}">Trade Volume</button>`;
    tabs.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
      if (!btn) return;
      this.tab = btn.dataset['tab'] as Tab;
      this.buildControls(); this.buildLegend(); this.draw();
    });

    const zooms = document.createElement('div');
    zooms.style.cssText = 'display:flex;gap:4px';
    ([30, 90, 180] as ZoomWindow[]).forEach(z => {
      const label = z === 30 ? '1m' : z === 90 ? '3m' : '6m';
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = btnStyle(this.zoom === z);
      btn.style.color = this.zoom === z ? bgColor : textPrimary;
      btn.addEventListener('click', () => {
        this.zoom = z; this.buildControls(); this.buildLegend(); this.draw();
      });
      zooms.appendChild(btn);
    });

    ctrl.innerHTML = '';
    ctrl.appendChild(tabs);
    ctrl.appendChild(zooms);
  }

  private buildLegend(): void {
    const leg = this.legend;
    if (!leg) return;
    const textDim = getCSSColor('--text-dim') || '#888';
    const data = this.visibleData();
    const last = data[data.length - 1];

    leg.innerHTML = VESSEL_LABELS.map((label, i) => {
      const key = this.tab === 'calls' ? VESSEL_KEYS[i]! : CAP_KEYS[i]!;
      const val = last ? (last[key as keyof TransitDayCount] as number) : 0;
      const display = this.tab === 'dwt' ? fmtDWT(val) : String(val);
      return `<span style="display:flex;align-items:center;gap:4px;font-size:10px;color:${textDim}">` +
        `<span style="width:7px;height:7px;border-radius:1px;background:${VESSEL_COLORS[i]}"></span>` +
        `${label} <b style="color:${VESSEL_COLORS[i]}">${display}</b></span>`;
    }).join('');
  }

  private draw = (): void => {
    const canvas = this.canvas;
    if (!canvas) return;

    const data = this.visibleData();
    if (!data.length) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = parseInt(canvas.style.height, 10) || 180;
    canvas.width = W * dpr;
    canvas.height = H * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const textColor = getCSSColor('--text-dim') || '#888';
    const gridColor = getCSSColor('--border') || '#2a2a2a';

    // Build stacked totals per day
    const stacks: number[][] = data.map(d =>
      (this.tab === 'calls' ? VESSEL_KEYS : CAP_KEYS).map(k => d[k as keyof TransitDayCount] as number),
    );
    const totals = stacks.map(s => s.reduce((a, b) => a + b, 0));
    const maxVal = Math.max(...totals, 1);
    const yScale = Math.ceil(maxVal / GRID_LINES) * GRID_LINES;

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const barW = Math.max(1, plotW / data.length - 1);
    const xBar = (i: number) => PAD.left + (i / data.length) * plotW;
    const yPos = (v: number) => PAD.top + plotH - (v / yScale) * plotH;

    // Grid
    ctx.font = `9px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    for (let i = 0; i <= GRID_LINES; i++) {
      const gy = PAD.top + (i / GRID_LINES) * plotH;
      const val = yScale - (i / GRID_LINES) * yScale;
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 0.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(PAD.left, gy);
      ctx.lineTo(W - PAD.right, gy);
      ctx.stroke();
      ctx.fillStyle = textColor;
      const label = this.tab === 'dwt' ? fmtDWT(val) : String(Math.round(val));
      ctx.fillText(label, W - PAD.right + 3, gy + 3);
    }

    // X labels
    ctx.textAlign = 'center';
    const labelStep = Math.max(1, Math.floor(data.length / 5));
    for (let i = 0; i < data.length; i += labelStep) {
      const d = new Date(data[i]!.date + 'T00:00:00Z');
      const lx = xBar(i) + barW / 2;
      ctx.fillStyle = textColor;
      ctx.fillText(d.toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }), lx, H - 5);
    }

    // Stacked bars
    for (let i = 0; i < data.length; i++) {
      let base = 0;
      const bx = xBar(i);
      for (let k = VESSEL_COLORS.length - 1; k >= 0; k--) {
        const v = stacks[i]![k]!;
        const barH = (v / yScale) * plotH;
        const by = yPos(base + v);
        ctx.fillStyle = VESSEL_COLORS[k]!;
        ctx.fillRect(bx, by, barW, barH);
        base += v;
      }
    }

    // 7d MA overlay
    const maValues = compute7dMA(totals);
    ctx.beginPath();
    ctx.strokeStyle = MA_COLOR;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.setLineDash([3, 2]);
    maValues.forEach((v, i) => {
      const px = xBar(i) + barW / 2;
      const py = yPos(v);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  };

  private onMouseMove = (e: MouseEvent): void => {
    const canvas = this.canvas;
    const tooltip = this.tooltip;
    if (!canvas || !tooltip) return;

    const data = this.visibleData();
    if (!data.length) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const W = rect.width;
    const plotW = W - PAD.left - PAD.right;
    const barW = Math.max(1, plotW / data.length - 1);

    let idx = Math.floor(((mx - PAD.left) / plotW) * data.length);
    idx = Math.max(0, Math.min(data.length - 1, idx));

    const d = data[idx]!;
    const stack = (this.tab === 'calls' ? VESSEL_KEYS : CAP_KEYS).map(k => d[k as keyof TransitDayCount] as number);
    const total = stack.reduce((a, b) => a + b, 0);

    const maValues = compute7dMA(data.map(r =>
      (this.tab === 'calls' ? VESSEL_KEYS : CAP_KEYS).reduce((s, k) => s + (r[k as keyof TransitDayCount] as number), 0),
    ));
    const ma = maValues[idx] ?? 0;

    const fmt = (v: number) => this.tab === 'dwt' ? fmtDWT(v) : String(v);

    tooltip.innerHTML =
      `<div style="font-weight:600;margin-bottom:3px">${d.date}</div>` +
      VESSEL_LABELS.map((label, i) =>
        `<div><span style="color:${VESSEL_COLORS[i]}">■</span> ${label}: ${fmt(stack[i]!)}</div>`,
      ).join('') +
      `<div style="margin-top:3px;border-top:1px solid #444;padding-top:2px">Total: <b>${fmt(total)}</b></div>` +
      `<div><span style="color:${MA_COLOR}">—</span> 7d MA: ${fmt(Math.round(ma))}</div>`;

    tooltip.style.display = 'block';
    const bx = PAD.left + (idx / data.length) * plotW + barW / 2;
    const tipW = 160;
    tooltip.style.left = (bx + tipW + 20 > W ? bx - tipW - 8 : bx + 8) + 'px';
    tooltip.style.top = '20px';
  };

  private onMouseLeave = (): void => {
    if (this.tooltip) this.tooltip.style.display = 'none';
  };
}
