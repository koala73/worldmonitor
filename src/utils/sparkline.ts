import { escapeHtml } from './sanitize';

/**
 * `baseline`, when given, is a reference series on the same x positions as `data` (null where
 * absent), drawn as a dashed line on the same scale.
 */
export function miniSparkline(
  data: number[] | undefined,
  change: number | null,
  w = 50,
  h = 16,
  baseline?: ReadonlyArray<number | null>,
): string {
  if (!data || data.length < 2) return '';
  const ref = baseline?.length === data.length ? baseline : undefined;
  const scale = ref ? [...data, ...ref.filter((v): v is number => v != null)] : data;
  const min = Math.min(...scale);
  const max = Math.max(...scale);
  const range = max - min || 1;
  const color = change != null && change >= 0 ? 'var(--green)' : 'var(--red)';
  const at = (v: number, i: number) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const points = data.map(at).join(' ');
  const runs: string[][] = [];
  let run: string[] = [];
  ref?.forEach((v, i) => {
    if (v != null) { run.push(at(v, i)); return; }
    if (run.length) runs.push(run);
    run = [];
  });
  if (run.length) runs.push(run);
  const refLines = runs.filter(r => r.length > 1)
    .map(r => `<polyline class="mini-sparkline-baseline" points="${r.join(' ')}" fill="none" stroke="var(--text-dim)" stroke-width="1" stroke-dasharray="2 2"/>`)
    .join('');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="mini-sparkline" aria-hidden="true">${refLines}<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function sparkline(
  data: number[],
  color: string,
  w: number,
  h: number,
  style = '',
  a11y?: { label?: string },
): string {
  if (data.length < 2) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const label = a11y?.label?.trim();
  // Default stays decorative so adjacent numeric text remains the accessible name.
  // Callers whose sparkline is the only cell content must pass `label`.
  const a11yAttrs = label
    ? ` role="img" aria-label="${escapeHtml(label)}"`
    : ' aria-hidden="true"';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${style ? ` style="${style}"` : ''}${a11yAttrs}><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
