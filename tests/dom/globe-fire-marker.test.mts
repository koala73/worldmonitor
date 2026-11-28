/**
 * #10713: a FIRMS detection on the 3D globe opens the fire popup from the keyboard
 * as well as the pointer, as on the SVG map. Agency-reported fires stay inert markers.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/orbital-watch-flag', () => ({ ORBITAL_WATCH_ENABLED: true }));

import { GlobeMap } from '@/components/GlobeMap';

const FIRE = {
  lat: 48.5, lon: 37.25, brightness: 351, frp: 12, confidence: 95, region: 'Ukraine', acq_date: '2026-11-14', daynight: 'D',
  detected_at: Date.parse('2026-11-14T10:42:00Z'), satellite: 'N', source: 'firms',
};

function build(detection: unknown) {
  const show = vi.fn();
  const map = Object.assign(Object.create(GlobeMap.prototype), {
    destroyed: false,
    popup: { show, hide: vi.fn() },
    tooltipEl: null,
    tooltipHideTimer: null,
    container: document.createElement('div'),
    reservoirRevealSeq: 0,
  }) as { buildMarkerElement: (d: unknown) => HTMLElement };
  const el = map.buildMarkerElement({ _kind: 'fire', _lat: FIRE.lat, _lng: FIRE.lon, id: 'f1', region: FIRE.region, brightness: FIRE.brightness, detection });
  return { el, show };
}

const key = (k: string) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });

describe('globe fire marker', () => {
  it('is a focusable, labelled button for a FIRMS detection', () => {
    const { el } = build(FIRE);
    expect(el.getAttribute('role')).toBe('button');
    expect(el.tabIndex).toBe(0);
    expect(el.getAttribute('aria-label')).toContain('Ukraine');
  });

  it.each(['Enter', ' '])('opens the fire popup when %j is pressed', (k) => {
    const { el, show } = build(FIRE);
    const event = key(k);
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]![0]).toMatchObject({ type: 'fireDetection', data: { lat: 48.5, lon: 37.25 } });
  });

  it('ignores other keys', () => {
    const { el, show } = build(FIRE);
    el.dispatchEvent(key('a'));
    expect(show).not.toHaveBeenCalled();
  });

  it('stays an inert marker for an agency-reported fire', () => {
    const { el, show } = build({ ...FIRE, source: 'cwfis' });
    expect(el.hasAttribute('role')).toBe(false);
    expect(el.hasAttribute('tabindex')).toBe(false);
    el.dispatchEvent(key('Enter'));
    expect(show).not.toHaveBeenCalled();
  });
});
