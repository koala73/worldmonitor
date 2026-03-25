import { getCSSColor } from '@/utils';

interface TransitPoint {
  date: string;
  tanker: number;
  cargo: number;
}

const MAX_DAYS = 60;
const PAD = { top: 12, right: 36, bottom: 22, left: 4 };
const GRID_LINES = 4;

export class TransitChart {
  private canvas: HTMLCanvasElement | null = null;
  private tooltip: HTMLDivElement | null = null;
  private legend: HTMLDivElement | null = null;
  private themeHandler: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private data: TransitPoint[] = [];

  mount(container: HTMLElement, history: TransitPoint[]): void {
    this.destroy();
    if (!history.length) return;

    this.data = history.slice(-MAX_DAYS);
    container.style.minHeight = '120px';
    container.style.position = 'relative';

    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '140px';
    this.canvas.style.display = 'block';
    container.appendChild(this.canvas);

    this.tooltip = document.createElement('div');
    Object.assign(this.tooltip.style, {
      position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: '10',
      background: 'var(--bg-elevated, #222244)', border: '1px solid var(--border-subtle, #444)',
      borderRadius: '4px', padding: '5px 8px', fontSize: '11px', color: 'var(--text-primary, #eee)',
      whiteSpace: 'nowrap', lineHeight: '1.5',
    });
    container.appendChild(this.tooltip);

    this.legend = document.createElement('div');
    Object.assign(this.legend.style, {
      display: 'flex', gap: '14px', padding: '6px 0 0',
    });
    container.appendChild(this.legend);

    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mouseleave', this.onMouseLeave);

    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.canvas);

    this.themeHandler = () => this.draw();
    window.addEventListener('theme-changed', this.themeHandler);

    this.draw();
  }

  destroy(): void {
    if (this.themeHandler) {
      window.removeEventListener('theme-changed', this.themeHandler);
      this.themeHandler = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.canvas) {
      this.canvas.removeEventListener('mousemove', this.onMouseMove);
      this.canvas.removeEventListener('mouseleave', this.onMouseLeave);
      this.canvas.remove();
      this.canvas = null;
    }
    if (this.tooltip) { this.tooltip.remove(); this.tooltip = null; }
    if (this.legend) { this.legend.remove(); this.legend = null; }
    this.data = [];
  }

  private colors() {
    return {
      text: getCSSColor('--text-dim') || '#888',
      grid: getCSSColor('--border') || '#2a2a2a',
      tanker: getCSSColor('--semantic-info') || '#3b82f6',
      cargo: getCSSColor('--semantic-high') || '#ff8800',
      bg: 'transparent',
    };
  }

  private metrics() {
    const data = this.data;
    const allVals = data.flatMap(d => [d.tanker, d.cargo]);
    const minV = Math.floor(Math.min(...allVals) / 10) * 10;
    const maxV = Math.ceil(Math.max(...allVals) / 10) * 10;
    return { minV, maxV, range: maxV - minV || 1 };
  }

  private draw = (): void => {
    const canvas = this.canvas;
    if (!canvas || !this.data.length) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = parseInt(canvas.style.height, 10) || 140;
    canvas.width = W * dpr;
    canvas.height = H * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const c = this.colors();
    const { minV, maxV, range } = this.metrics();
    const data = this.data;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (i / (data.length - 1)) * plotW;
    const y = (v: number) => PAD.top + plotH - ((v - minV) / range) * plotH;

    // Grid + Y labels
    ctx.font = '9px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    ctx.textAlign = 'left';
    for (let i = 0; i <= GRID_LINES; i++) {
      const gy = PAD.top + (i / GRID_LINES) * plotH;
      const val = Math.round(maxV - (i / GRID_LINES) * range);
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 0.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(PAD.left, gy);
      ctx.lineTo(W - PAD.right, gy);
      ctx.stroke();
      ctx.fillStyle = c.text;
      ctx.fillText(String(val), W - PAD.right + 4, gy + 3);
    }

    // X labels
    ctx.textAlign = 'center';
    const labelStep = Math.max(1, Math.floor(data.length / 5));
    for (let i = 0; i < data.length; i += labelStep) {
      const d = new Date(data[i]!.date);
      ctx.fillStyle = c.text;
      ctx.fillText(d.toLocaleDateString('en', { month: 'short', day: 'numeric' }), x(i), H - 4);
    }

    const drawLine = (key: 'tanker' | 'cargo', color: string) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      data.forEach((d, i) => {
        const px = x(i), py = y(d[key]);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.stroke();

      // Endpoint dot
      const last = data[data.length - 1]!;
      ctx.beginPath();
      ctx.arc(x(data.length - 1), y(last[key]), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = getCSSColor('--panel-bg') || '#141414';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };

    drawLine('cargo', c.cargo);
    drawLine('tanker', c.tanker);

    // Legend
    if (this.legend) {
      const last = data[data.length - 1]!;
      this.legend.innerHTML = [
        { label: 'Tanker', color: c.tanker, value: last.tanker },
        { label: 'Cargo', color: c.cargo, value: last.cargo },
      ].map(s => `<span style="display:flex;align-items:center;gap:5px;font-size:11px;color:${c.text}">
        <span style="width:8px;height:8px;border-radius:50%;background:${s.color}"></span>
        ${s.label} <b style="color:${s.color}">${s.value}</b>
      </span>`).join('');
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    const canvas = this.canvas;
    const tooltip = this.tooltip;
    if (!canvas || !tooltip || !this.data.length) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const W = rect.width;
    const plotW = W - PAD.left - PAD.right;
    const idx = Math.round(((mx - PAD.left) / plotW) * (this.data.length - 1));

    if (idx < 0 || idx >= this.data.length) {
      tooltip.style.display = 'none';
      return;
    }

    const d = this.data[idx]!;
    const c = this.colors();
    tooltip.innerHTML =
      `<div style="font-weight:600;margin-bottom:2px">${d.date}</div>` +
      `<div><span style="color:${c.tanker}">●</span> Tanker: ${d.tanker}</div>` +
      `<div><span style="color:${c.cargo}">●</span> Cargo: ${d.cargo}</div>`;
    tooltip.style.display = 'block';
    tooltip.style.left = Math.min(mx + 12, W - 130) + 'px';
    tooltip.style.top = '4px';
  };

  private onMouseLeave = (): void => {
    if (this.tooltip) this.tooltip.style.display = 'none';
  };
}
