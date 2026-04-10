interface SectorSlice {
  label: string;
  share: number;
  color: string;
}

export class HS2RingChart {
  mount(container: HTMLElement, sectors: SectorSlice[]): void {
    if (!sectors.length) return;

    const total = sectors.reduce((s, e) => s + e.share, 0) || 1;

    const size = 110;
    const cx = size / 2;
    const cy = size / 2;
    const r = 42;
    const innerR = 24;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.className = 'popup-hs2-ring-canvas';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let startAngle = -Math.PI / 2;
    sectors.forEach(slice => {
      const sweep = (slice.share / total) * 2 * Math.PI;
      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, startAngle + sweep);
      ctx.arc(cx, cy, innerR, startAngle + sweep, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = slice.color;
      ctx.fill();
      startAngle += sweep;
    });

    container.appendChild(canvas);

    const legend = document.createElement('div');
    legend.className = 'popup-hs2-ring-legend';
    sectors.forEach(slice => {
      const item = document.createElement('div');
      item.className = 'popup-hs2-ring-legend-item';
      item.innerHTML =
        `<span class="popup-hs2-ring-dot" style="background:${slice.color}"></span>` +
        `<span class="popup-hs2-ring-label">${slice.label}</span>` +
        `<span class="popup-hs2-ring-pct">${slice.share}%</span>`;
      legend.appendChild(item);
    });
    container.appendChild(legend);
  }
}
