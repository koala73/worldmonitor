import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventHandlerManager } from '@/app/event-handlers';

describe('map fullscreen resize synchronization', () => {
  let resize: ReturnType<typeof vi.fn>;
  let manager: EventHandlerManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    document.body.replaceChildren();
    resize = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    manager = new EventHandlerManager({
      container,
      isDesktopApp: false,
      panels: {},
      panelSettings: {},
      mapLayers: {},
      map: { resize, setIsResizing: vi.fn() },
    } as never, {} as never);
  });

  afterEach(() => {
    manager.destroy();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  function expectImmediateAndSettledResize(action: () => void): void {
    action();
    expect(resize).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(320);
    expect(resize).toHaveBeenCalledTimes(2);
  }

  it('resizes after browser fullscreen changes', () => {
    const button = document.createElement('button');
    button.id = 'fullscreenBtn';
    document.body.append(button);
    manager.init();

    expectImmediateAndSettledResize(() => document.dispatchEvent(new Event('fullscreenchange')));
  });

  it('resizes after map-panel fullscreen toggles', () => {
    const section = document.createElement('section');
    section.id = 'mapSection';
    const pinButton = document.createElement('button');
    pinButton.id = 'mapPinBtn';
    const fullscreenButton = document.createElement('button');
    fullscreenButton.id = 'mapFullscreenBtn';
    document.body.append(section, pinButton, fullscreenButton);
    manager.setupMapPin();

    expectImmediateAndSettledResize(() => fullscreenButton.click());
  });

  it('keeps the map-height separator value synchronized', () => {
    // Pin a stacked-layout viewport: from SPLIT_LAYOUT_MIN_WIDTH up the
    // handle resizes #mapContainer instead of the section
    // (tests/dom/map-split-layout.test.mts covers that mode).
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    const section = document.createElement('section');
    section.id = 'mapSection';
    Object.defineProperty(section, 'offsetHeight', { configurable: true, value: 500 });
    const mapContainer = document.createElement('div');
    mapContainer.id = 'mapContainer';
    const handle = document.createElement('div');
    handle.id = 'mapResizeHandle';
    const bottomGrid = document.createElement('div');
    bottomGrid.id = 'mapBottomGrid';
    section.append(mapContainer, handle, bottomGrid);
    document.body.append(section);

    manager.setupMapResize();

    expect(handle.getAttribute('aria-controls')).toBe('mapSection');
    expect(handle.getAttribute('aria-valuemin')).toBe('350');
    expect(handle.getAttribute('aria-valuenow')).toBe('500');

    handle.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }));
    expect(section.style.height).toBe('540px');
    expect(handle.getAttribute('aria-valuenow')).toBe('540');

    handle.dispatchEvent(new MouseEvent('mousedown', { clientY: 100, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 120, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(section.style.height).toBe('520px');
    expect(handle.getAttribute('aria-valuenow')).toBe('520');
  });

  it('keeps the map-width separator value synchronized', () => {
    const main = document.createElement('main');
    main.className = 'main-content';
    Object.defineProperty(main, 'offsetWidth', { configurable: true, value: 1000 });
    main.style.setProperty('--map-col-width', '60%');
    const section = document.createElement('section');
    section.id = 'mapSection';
    const handle = document.createElement('div');
    handle.id = 'mapWidthResizeHandle';
    main.append(section, handle);
    document.body.append(main);

    manager.setupMapWidthResize();

    // At a 1000px container the bounds tighten to the pixel floors:
    // min = 220px map floor (22%), max = 1000-300-6 panels floor (69.4%).
    expect(handle.getAttribute('aria-controls')).toBe('mapSection');
    expect(handle.getAttribute('aria-valuemin')).toBe('22');
    expect(handle.getAttribute('aria-valuemax')).toBe('69');
    expect(handle.getAttribute('aria-valuenow')).toBe('60');

    handle.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    }));
    expect(main.style.getPropertyValue('--map-col-width')).toBe('65.0%');
    expect(handle.getAttribute('aria-valuenow')).toBe('65');

    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(main.style.getPropertyValue('--map-col-width')).toBe('69.4%');
    expect(handle.getAttribute('aria-valuenow')).toBe('69');
  });
});
