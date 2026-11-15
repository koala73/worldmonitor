/**
 * #10713: a FIRMS detection on the 2D SVG map (what phones use) is a labelled
 * button that opens the fire popup from the keyboard as well as the pointer.
 * Browsers activate a focused button on Enter and Space with a click whose
 * `detail` is 0 and whose clientX/clientY are 0, so the popup must anchor on the
 * dot, not on the pointer. Agency-reported fires (CWFIS, BC Wildfire Service)
 * stay inert dots.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('globe.gl', () => ({ default: vi.fn() }));
vi.mock('@/config/orbital-watch-flag', () => ({ ORBITAL_WATCH_ENABLED: true }));

import { MapComponent } from '@/components/Map';

type FireDotMap = { createFireDot: (fire: unknown, pos: [number, number]) => HTMLElement };

const FIRE = {
  lat: 48.5, lon: 37.25, brightness: 351, frp: 12, confidence: 95, region: 'Ukraine', acq_date: '2026-11-14', daynight: 'D',
  detected_at: Date.parse('2026-11-14T10:42:00Z'), satellite: 'N', source: 'firms',
};
const CONTAINER_LEFT = 40;
const CONTAINER_TOP = 60;

afterEach(() => vi.restoreAllMocks());

function build(fire: unknown) {
  const show = vi.fn();
  const container = document.createElement('div');
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ left: CONTAINER_LEFT, top: CONTAINER_TOP, right: 440, bottom: 460, width: 400, height: 400, x: CONTAINER_LEFT, y: CONTAINER_TOP, toJSON: () => ({}) } as DOMRect);
  const map = Object.assign(Object.create(MapComponent.prototype), { container, popup: { show } }) as FireDotMap;
  const dot = map.createFireDot(fire, [100, 120]);
  vi.spyOn(dot, 'getBoundingClientRect').mockReturnValue({ left: 200, top: 300, right: 208, bottom: 308, width: 8, height: 8, x: 200, y: 300, toJSON: () => ({}) } as DOMRect);
  document.body.append(container);
  container.append(dot);
  return { dot, show };
}

/** What a browser dispatches when Enter or Space activates a focused button. */
const keyboardClick = () => new MouseEvent('click', { bubbles: true, detail: 0, clientX: 0, clientY: 0 });

/** The key events, then the click a browser makes of them: Enter on keydown, Space on keyup. */
function press(dot: HTMLElement, key: 'Enter' | ' '): void {
  const init = { key, code: key === ' ' ? 'Space' : 'Enter', bubbles: true };
  dot.dispatchEvent(new KeyboardEvent('keydown', init));
  if (key === 'Enter') dot.dispatchEvent(keyboardClick());
  dot.dispatchEvent(new KeyboardEvent('keyup', init));
  if (key === ' ') dot.dispatchEvent(keyboardClick());
}
const pointerClick = () => new MouseEvent('click', { bubbles: true, detail: 1, clientX: 150, clientY: 170 });

describe('SVG map fire dot', () => {
  it('is a labelled button for a FIRMS detection', () => {
    const { dot } = build(FIRE);
    expect(dot.tagName).toBe('BUTTON');
    expect((dot as HTMLButtonElement).type).toBe('button');
    expect(dot.getAttribute('aria-label')).toContain('Ukraine');
  });

  it.each([['Enter', 'Enter'], ['Space', ' ']] as const)('opens the popup at the dot when %s activates it', (_name, key) => {
    const { dot, show } = build(FIRE);
    press(dot, key);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]![0]).toMatchObject({
      type: 'fireDetection', data: { lat: 48.5, lon: 37.25 },
      x: 200 + 4 - CONTAINER_LEFT, y: 300 + 4 - CONTAINER_TOP,
    });
  });

  it('opens the popup at the pointer for a mouse or touch click', () => {
    const { dot, show } = build(FIRE);
    dot.dispatchEvent(pointerClick());
    expect(show.mock.calls[0]![0]).toMatchObject({ x: 150 - CONTAINER_LEFT, y: 170 - CONTAINER_TOP });
  });

  it('keeps the activation from reaching the map beneath', () => {
    const { dot } = build(FIRE);
    const onMap = vi.fn();
    dot.parentElement!.addEventListener('click', onMap);
    dot.dispatchEvent(keyboardClick());
    expect(onMap).not.toHaveBeenCalled();
  });

  it.each(['cwfis', 'bcws'])('stays an inert dot for an agency-reported %s fire', (source) => {
    const { dot, show } = build({ ...FIRE, source });
    expect(dot.tagName).toBe('DIV');
    expect(dot.classList.contains('fire-dot-popup')).toBe(false);
    press(dot, 'Enter');
    press(dot, ' ');
    dot.dispatchEvent(pointerClick());
    expect(show).not.toHaveBeenCalled();
  });
});
