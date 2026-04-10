interface SectorSlice {
  label: string;
  share: number;
  color: string;
}

export class HS2RingChart {
  mount(container: HTMLElement, sectors: SectorSlice[]): void {
    if (!sectors.length) return;

    const total = sectors.reduce((s, e) => s + e.share, 0) || 1;

    const size = 80;
    const cx = size / 2;
    const cy = size / 2;
    const r = 34;
    const innerR = 18;

    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.className = 'popup-hs2-ring-canvas';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

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
      const dot = document.createElement('span');
      dot.className = 'popup-hs2-ring-dot';
      dot.style.background = slice.color;
      const label = document.createElement('span');
      label.className = 'popup-hs2-ring-label';
      label.textContent = slice.label;
      const pct = document.createElement('span');
      pct.className = 'popup-hs2-ring-pct';
      pct.textContent = `${slice.share}%`;
      item.appendChild(dot);
      item.appendChild(label);
      item.appendChild(pct);
      legend.appendChild(item);
    });
    container.appendChild(legend);
  }
}
