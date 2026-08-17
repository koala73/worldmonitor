// Bloomberg-terminal-style price chart, rendered as a self-contained SVG string.
//
// Same pure-function idiom as sparkline.ts (no DOM, no deps) so it stays trivially
// unit-testable, but upgraded to a full panel chart: horizontal gridlines, a
// green/red gradient area fill keyed to direction, right-axis HI/LO/LAST labels,
// and a last-price marker. Consumes the plain number[] intraday series that the
// market data already carries — it does NOT invent OHLC/candlestick data.

export interface TerminalChartOptions {
  width?: number;
  height?: number;
  /** Direction color driver. If null/undefined, derived from first vs last point. */
  change?: number | null;
  /** Deterministic value formatter for axis labels. Defaults to a locale-free formatter. */
  formatValue?: (value: number) => string;
  /** Accessible name for the SVG. Without it, role="img" announces only "image". */
  ariaLabel?: string;
}

// Minimal attribute escape so an ariaLabel (which may carry a ticker's display
// string) can't break out of the aria-label="" context. Kept local to keep this
// util dependency-free, matching sparkline.ts.
function escAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Module-level counter gives each rendered chart a unique gradient/clip id so
// multiple charts on one page don't collide. Deterministic within a page load.
let uid = 0;

function defaultFormat(value: number): string {
  if (!Number.isFinite(value)) return '--';
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  return value.toFixed(abs >= 100 ? 1 : 2);
}

/**
 * Render `data` as a terminal-style area chart SVG string.
 * Returns '' when there are fewer than 2 finite points (nothing to plot).
 */
export function terminalChart(data: number[] | undefined, opts: TerminalChartOptions = {}): string {
  const series = (data ?? []).filter((v) => Number.isFinite(v));
  if (series.length < 2) return '';

  const w = opts.width ?? 460;
  const h = opts.height ?? 200;
  const fmt = opts.formatValue ?? defaultFormat;

  const marginL = 8;
  const marginR = 54;
  const marginT = 16;
  const marginB = 18;
  const chartW = w - marginL - marginR;
  const chartH = h - marginT - marginB;

  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min;
  const first = series[0]!; // guarded: series.length >= 2
  const last = series[series.length - 1]!;
  const rising = opts.change != null ? opts.change >= 0 : last >= first;
  const color = rising ? 'var(--green)' : 'var(--red)';

  const x = (i: number): number => marginL + (i / (series.length - 1)) * chartW;
  const y = range === 0
    ? (): number => marginT + chartH / 2
    : (v: number): number => marginT + (1 - (v - min) / range) * chartH;

  // Line + closed area path (area drops to the chart baseline for the fill).
  const linePts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${linePts.join(' L')}`;
  const baseY = (marginT + chartH).toFixed(1);
  const area = `${line} L${x(series.length - 1).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z`;

  const gradId = `tc-grad-${uid++}`;

  // 3 interior horizontal gridlines.
  const gridlines = [0.25, 0.5, 0.75]
    .map((f) => {
      const gy = (marginT + f * chartH).toFixed(1);
      return `<line x1="${marginL}" y1="${gy}" x2="${marginL + chartW}" y2="${gy}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2 3" opacity="0.6"/>`;
    })
    .join('');

  const labelX = marginL + chartW + 6;
  const labelTop = marginT + 3;
  const labelBottom = marginT + chartH + 3;
  const labelSpecs = range === 0
    ? [{ y: y(last) + 3, text: `HI/LO/LAST ${fmt(last)}`, fill: color, emphasis: true }]
    : [
        {
          y: y(max) + 3,
          text: `${last === max ? 'HI/LAST' : 'HI'} ${fmt(max)}`,
          fill: last === max ? color : 'var(--text-dim)',
          emphasis: last === max,
        },
        ...(last !== max && last !== min
          ? [{ y: y(last) + 3, text: `LAST ${fmt(last)}`, fill: color, emphasis: true }]
          : []),
        {
          y: y(min) + 3,
          text: `${last === min ? 'LO/LAST' : 'LO'} ${fmt(min)}`,
          fill: last === min ? color : 'var(--text-dim)',
          emphasis: last === min,
        },
      ];
  labelSpecs.sort((a, b) => a.y - b.y);

  // Preserve readable baselines when LAST is very close to HI or LO. Exact
  // coincidences are combined above; near-coincidences are separated here.
  const labelGap = labelSpecs.length > 1
    ? Math.min(11, (labelBottom - labelTop) / (labelSpecs.length - 1))
    : 0;
  for (let index = 1; index < labelSpecs.length; index++) {
    labelSpecs[index]!.y = Math.max(labelSpecs[index]!.y, labelSpecs[index - 1]!.y + labelGap);
  }
  const finalLabel = labelSpecs[labelSpecs.length - 1]!;
  if (finalLabel.y > labelBottom) {
    finalLabel.y = labelBottom;
    for (let index = labelSpecs.length - 2; index >= 0; index--) {
      labelSpecs[index]!.y = Math.min(labelSpecs[index]!.y, labelSpecs[index + 1]!.y - labelGap);
    }
  }
  const labels = labelSpecs
    .map(
      (label) =>
        `<text x="${labelX}" y="${label.y.toFixed(1)}" fill="${label.fill}" style="font-size:calc(9px * var(--wm-panel-effective-scale, 1))"${label.emphasis ? ' font-weight="600"' : ''}>${label.text}</text>`,
    )
    .join('');

  const lastDot = `<circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.5" fill="${color}"/>`;

  return (
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="terminal-chart" role="img"${opts.ariaLabel ? ` aria-label="${escAttr(opts.ariaLabel)}"` : ''}>` +
    `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>` +
    `<stop offset="100%" stop-color="${color}" stop-opacity="0"/>` +
    `</linearGradient></defs>` +
    gridlines +
    `<path d="${area}" fill="url(#${gradId})"/>` +
    `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    lastDot +
    labels +
    `</svg>`
  );
}
