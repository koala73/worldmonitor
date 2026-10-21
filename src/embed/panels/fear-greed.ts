import { MarketServiceClient } from '@/services/generated-rpc-clients';
import { buildWorldMonitorAttributionUrl } from '@/embed/embed-url';
import { createKeyedEmbedFetch } from '@/embed/embed-fetch';

function scoreColor(score: number): string {
  if (score <= 20) return '#e74c3c';
  if (score <= 40) return '#e67e22';
  if (score <= 60) return '#f1c40f';
  if (score <= 80) return '#2ecc71';
  return '#27ae60';
}

function getReferrerHost(): string | null {
  if (!document.referrer) return null;
  try {
    return new URL(document.referrer).host || null;
  } catch {
    return null;
  }
}

function appendGauge(parent: HTMLElement, score: number, label: string, color: string): void {
  const svgNs = 'http://www.w3.org/2000/svg';
  const gauge = document.createElement('div');
  gauge.className = 'wm-embed-fg-gauge';

  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 200 115');
  svg.setAttribute('width', '200');
  svg.setAttribute('height', '115');
  svg.setAttribute('aria-hidden', 'true');

  const cx = 100;
  const cy = 100;
  const R = 88;
  const r = 60;
  const coord = (deg: number, radius: number): string => {
    const a = (deg * Math.PI) / 180;
    return `${(cx + radius * Math.cos(a)).toFixed(2)},${(cy - radius * Math.sin(a)).toFixed(2)}`;
  };
  const zones = [
    { a1: 180, a2: 144, fill: '#c0392b' },
    { a1: 144, a2: 108, fill: '#e67e22' },
    { a1: 108, a2: 72, fill: '#f1c40f' },
    { a1: 72, a2: 36, fill: '#2ecc71' },
    { a1: 36, a2: 0, fill: '#27ae60' },
  ];
  for (const zone of zones) {
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute(
      'd',
      `M${coord(zone.a1, R)} A${R},${R} 0 0,0 ${coord(zone.a2, R)} L${coord(zone.a2, r)} A${r},${r} 0 0,1 ${coord(zone.a1, r)} Z`,
    );
    path.setAttribute('fill', zone.fill);
    path.setAttribute('opacity', '0.88');
    svg.appendChild(path);
  }

  const na = ((180 - score * 1.8) * Math.PI) / 180;
  const line = document.createElementNS(svgNs, 'line');
  line.setAttribute('x1', String(cx));
  line.setAttribute('y1', String(cy));
  line.setAttribute('x2', (cx + 75 * Math.cos(na)).toFixed(1));
  line.setAttribute('y2', (cy - 75 * Math.sin(na)).toFixed(1));
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '2.5');
  line.setAttribute('stroke-linecap', 'round');
  svg.appendChild(line);

  const hub = document.createElementNS(svgNs, 'circle');
  hub.setAttribute('cx', String(cx));
  hub.setAttribute('cy', String(cy));
  hub.setAttribute('r', '6');
  hub.setAttribute('fill', color);
  svg.appendChild(hub);

  gauge.appendChild(svg);

  const scoreEl = document.createElement('div');
  scoreEl.className = 'wm-embed-fg-score';
  scoreEl.style.color = color;
  scoreEl.textContent = String(Math.round(score));
  gauge.appendChild(scoreEl);

  const labelEl = document.createElement('div');
  labelEl.className = 'wm-embed-fg-label';
  labelEl.style.color = color;
  labelEl.textContent = label;
  gauge.appendChild(labelEl);

  parent.appendChild(gauge);
}

export async function mountEmbedFearGreed(root: HTMLElement, apiKey: string): Promise<void> {
  const client = new MarketServiceClient('', { fetch: createKeyedEmbedFetch(apiKey) });
  const data = await client.getFearGreedIndex({});
  if (data.unavailable || !Number.isFinite(data.compositeScore)) {
    throw new Error('fear_greed_unavailable');
  }

  const wrap = document.createElement('div');
  wrap.className = 'wm-embed-fear-greed';

  const heading = document.createElement('h2');
  heading.className = 'wm-embed-panel-title';
  heading.textContent = 'Fear & Greed';
  wrap.appendChild(heading);

  appendGauge(wrap, data.compositeScore, data.compositeLabel || 'Composite', scoreColor(data.compositeScore));

  const attribution = document.createElement('a');
  attribution.className = 'wm-embed-attribution';
  attribution.href = buildWorldMonitorAttributionUrl(new URL('/dashboard', window.location.origin).toString(), getReferrerHost());
  attribution.target = '_blank';
  attribution.rel = 'noopener noreferrer';
  attribution.textContent = 'Fear & Greed by World Monitor';
  wrap.appendChild(attribution);

  root.appendChild(wrap);
}
