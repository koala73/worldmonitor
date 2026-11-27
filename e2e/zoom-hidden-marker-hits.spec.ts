import { expect, test, type Page } from '@playwright/test';

const LAYERS = [
  { name: 'bases', attr: 'data-layer-hidden-bases', selector: '.base-marker', className: 'base-marker us-nato' },
  { name: 'nuclear', attr: 'data-layer-hidden-nuclear', selector: '.nuclear-marker', className: 'nuclear-marker active' },
  { name: 'economic', attr: 'data-layer-hidden-economic', selector: '.economic-marker', className: 'economic-marker exchange', child: 'economic-icon' },
  { name: 'natural', attr: 'data-layer-hidden-natural', selector: '.earthquake-marker', className: 'earthquake-marker', width: '18px', height: '18px' },
  { name: 'iranAttacks', attr: 'data-layer-hidden-iranAttacks', selector: '.iran-event-marker', className: 'iran-event-marker', width: '16px', height: '16px' },
  { name: 'conflicts', attr: 'data-layer-hidden-conflicts', selector: '.conflict-click-area', className: 'conflict-click-area', width: '80px', height: '40px' },
] as const;

const MOBILE_TOUCH_RADIUS_PX = 22;
const PAST_EDGE_PX = 2;

type Probe = {
  name: string;
  visibleCentre: boolean;
  hiddenCentre: boolean;
  ring: boolean | null;
  visibleRing: boolean | null;
  hiddenRing: boolean | null;
};

async function probe(page: Page): Promise<Probe[]> {
  await page.goto('/tests/runtime-harness.html');
  return page.evaluate(async ({ layers, touchRadius, pastEdge }) => {
    await import('/src/styles/main.css');
    document.getElementById('runtime-harness')?.remove();
    const wrapper = document.createElement('div');
    wrapper.className = 'map-wrapper';
    wrapper.style.cssText = 'position:relative;width:100vw;height:100vh;background:#111';
    const overlays = document.createElement('div');
    overlays.id = 'mapOverlays';
    wrapper.appendChild(overlays);
    document.body.style.margin = '0';
    document.body.appendChild(wrapper);

    layers.forEach((layer, index) => {
      const el = document.createElement('div');
      el.className = layer.className;
      el.style.left = '64px';
      el.style.top = `${48 + index * 80}px`;
      if ('width' in layer && layer.width) {
        el.style.width = layer.width;
        el.style.height = layer.height;
      }
      if ('child' in layer && layer.child) {
        const child = document.createElement('div');
        child.className = layer.child;
        child.textContent = 'E';
        el.appendChild(child);
      }
      overlays.appendChild(el);
    });

    const read = () => layers.map((layer) => {
      const el = overlays.querySelector(layer.selector)!;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const pastEdgeX = cx + rect.width / 2 + pastEdge;
      const inTouchCircle = window.matchMedia('(max-width: 768px)').matches && pastEdgeX - cx < touchRadius;
      const onMarker = (x: number, y: number) => !!document.elementFromPoint(x, y)?.closest(layer.selector);
      return {
        name: layer.name,
        centre: onMarker(cx, cy),
        ring: inTouchCircle ? onMarker(pastEdgeX, cy) : null,
      };
    });

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const visible = read();
    for (const layer of layers) wrapper.setAttribute(layer.attr, 'true');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const hidden = read();
    return visible.map((row, index) => ({
      name: row.name,
      visibleCentre: row.centre,
      hiddenCentre: hidden[index]!.centre,
      ring: row.ring !== null,
      visibleRing: row.ring,
      hiddenRing: hidden[index]!.ring,
    }));
  }, { layers: LAYERS, touchRadius: MOBILE_TOUCH_RADIUS_PX, pastEdge: PAST_EDGE_PX });
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'mobile', width: 390, height: 844 },
] as const) {
  test(`zoom-hidden map markers take no taps at ${viewport.name} width`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const rows = await probe(page);
    expect(rows.map((row) => ({
      name: row.name,
      visibleCentre: row.visibleCentre,
      hiddenCentre: row.hiddenCentre,
      visibleRing: row.visibleRing,
      hiddenRing: row.hiddenRing,
    }))).toEqual(rows.map((row) => ({
      name: row.name,
      visibleCentre: true,
      hiddenCentre: false,
      visibleRing: row.ring ? true : null,
      hiddenRing: row.ring ? false : null,
    })));
  });
}
