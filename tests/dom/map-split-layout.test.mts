import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventHandlerManager } from '@/app/event-handlers';
import {
  MAP_COL_MIN_PX,
  PANELS_COL_MIN_PX,
  MAP_COL_DIVIDER_PX,
  SPLIT_LAYOUT_MIN_WIDTH,
} from '@/app/split-layout';

// Behavioral contract for issue #6417: the split layout activates at the
// unified breakpoint, the map column clamps to the widened bounds (a
// percentage floor tightened by pixel floors on both sides), the divider
// works by touch, the map can sit on either side, and the two height modes
// stop sharing one storage key.

describe('map split layout (#6417)', () => {
  let resize: ReturnType<typeof vi.fn>;
  let manager: EventHandlerManager;

  function stubInnerWidth(value: number): void {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value });
  }

  function buildSplitDom(totalWidth: number): { main: HTMLElement; handle: HTMLElement } {
    const main = document.createElement('main');
    main.className = 'main-content';
    Object.defineProperty(main, 'offsetWidth', { configurable: true, value: totalWidth });
    main.style.setProperty('--map-col-width', '60%');
    const section = document.createElement('section');
    section.id = 'mapSection';
    const handle = document.createElement('div');
    handle.id = 'mapWidthResizeHandle';
    main.append(section, handle);
    document.body.append(main);
    return { main, handle };
  }

  function buildHeightDom(): { section: HTMLElement; container: HTMLElement; handle: HTMLElement } {
    const section = document.createElement('section');
    section.id = 'mapSection';
    Object.defineProperty(section, 'offsetHeight', { configurable: true, value: 500 });
    const container = document.createElement('div');
    container.id = 'mapContainer';
    Object.defineProperty(container, 'offsetHeight', { configurable: true, value: 500 });
    const handle = document.createElement('div');
    handle.id = 'mapResizeHandle';
    const bottomGrid = document.createElement('div');
    bottomGrid.id = 'mapBottomGrid';
    section.append(container, handle, bottomGrid);
    document.body.append(section);
    return { section, container, handle };
  }

  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    resize = vi.fn();
    manager = new EventHandlerManager({
      container: document.createElement('div'),
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
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('map column width bounds', () => {
    it('allows dragging the map below 25% down to the pixel floor', () => {
      // 2200px: MAP_COL_MIN_PX (220) is exactly 10%, so the percentage
      // floor and the pixel floor agree.
      const { main, handle } = buildSplitDom(2200);
      manager.setupMapWidthResize();

      expect(handle.getAttribute('aria-valuemin')).toBe('10');
      expect(handle.getAttribute('aria-valuemax')).toBe('75');

      handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 1320, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(main.style.getPropertyValue('--map-col-width')).toBe('10.0%');
      expect(handle.getAttribute('aria-valuenow')).toBe('10');
      expect(localStorage.getItem('map-col-width')).toBe('10.0%');
    });

    it('keeps the pixel floor when 10% would make the map unusable', () => {
      // 1000px container: 10% would be 100px, well under MAP_COL_MIN_PX.
      const { main, handle } = buildSplitDom(1000);
      main.style.setProperty('--map-col-width', '25%');
      manager.setupMapWidthResize();

      const minPct = (MAP_COL_MIN_PX / 1000) * 100;
      expect(handle.getAttribute('aria-valuemin')).toBe(String(Math.round(minPct)));

      handle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
        cancelable: true,
      }));

      expect(main.style.getPropertyValue('--map-col-width')).toBe(`${minPct.toFixed(1)}%`);
    });

    it('reserves room for one panel column at the upper bound', () => {
      const { main, handle } = buildSplitDom(1000);
      manager.setupMapWidthResize();

      const maxPct = ((1000 - PANELS_COL_MIN_PX - MAP_COL_DIVIDER_PX) / 1000) * 100;

      handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 600, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 1000, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(main.style.getPropertyValue('--map-col-width')).toBe(`${maxPct.toFixed(1)}%`);
    });

    it('clamps a stored width on restore without overwriting the preference', () => {
      localStorage.setItem('map-col-width', '75.0%');
      const { main } = buildSplitDom(1000);
      manager.setupMapWidthResize();

      const maxPct = ((1000 - PANELS_COL_MIN_PX - MAP_COL_DIVIDER_PX) / 1000) * 100;
      expect(main.style.getPropertyValue('--map-col-width')).toBe(`${maxPct.toFixed(1)}%`);
      // The raw preference survives so a larger window restores it in full.
      expect(localStorage.getItem('map-col-width')).toBe('75.0%');
    });

    it('re-clamps the applied width when the window resizes', () => {
      vi.useFakeTimers();
      try {
        localStorage.setItem('map-col-width', '75.0%');
        const { main } = buildSplitDom(2200);
        manager.setupMapWidthResize();
        expect(main.style.getPropertyValue('--map-col-width')).toBe('75.0%');

        Object.defineProperty(main, 'offsetWidth', { configurable: true, value: 1000 });
        window.dispatchEvent(new Event('resize'));
        vi.advanceTimersByTime(200);

        const maxPct = ((1000 - PANELS_COL_MIN_PX - MAP_COL_DIVIDER_PX) / 1000) * 100;
        expect(main.style.getPropertyValue('--map-col-width')).toBe(`${maxPct.toFixed(1)}%`);
        expect(localStorage.getItem('map-col-width')).toBe('75.0%');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the raw stored width when a press ends without movement', () => {
      localStorage.setItem('map-col-width', '75.0%');
      const { handle } = buildSplitDom(1000);
      manager.setupMapWidthResize();

      // The restored application is clamped to this container (69.4%); a
      // bare press must not write that clamp back over the raw 75%
      // preference - only an actual drag movement may persist.
      handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 600, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(localStorage.getItem('map-col-width')).toBe('75.0%');
    });

    it('keeps the raw stored width when a tap ends without movement', () => {
      localStorage.setItem('map-col-width', '75.0%');
      const { handle } = buildSplitDom(1000);
      manager.setupMapWidthResize();

      handle.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true, cancelable: true }), {
        touches: [{ clientX: 694, identifier: 7 }],
        changedTouches: [{ clientX: 694, identifier: 7 }],
      }));
      document.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), {
        changedTouches: [{ identifier: 7 }],
      }));

      expect(localStorage.getItem('map-col-width')).toBe('75.0%');
    });

    it('skips the debounced window-resize re-clamp while a drag is active', () => {
      vi.useFakeTimers();
      try {
        // A raw narrow preference clamps to 22% at this container on
        // restore...
        localStorage.setItem('map-col-width', '10.0%');
        const { main, handle } = buildSplitDom(1000);
        manager.setupMapWidthResize();
        expect(main.style.getPropertyValue('--map-col-width')).toBe('22.0%');

        // ...but an active drag must hold its dragged value against the
        // re-clamp, which would otherwise restore the raw preference
        // mid-gesture.
        handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, bubbles: true }));
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 640, bubbles: true }));
        expect(main.style.getPropertyValue('--map-col-width')).toBe('36.0%');

        Object.defineProperty(main, 'offsetWidth', { configurable: true, value: 800 });
        window.dispatchEvent(new Event('resize'));
        vi.advanceTimersByTime(200);

        expect(main.style.getPropertyValue('--map-col-width')).toBe('36.0%');

        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        expect(localStorage.getItem('map-col-width')).toBe('36.0%');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('narrow map column state', () => {
    it('toggles map-col-narrow with the map section width', () => {
      const { handle } = buildSplitDom(2200);
      const section = document.getElementById('mapSection') as HTMLElement;
      Object.defineProperty(section, 'offsetWidth', { configurable: true, value: 300 });
      manager.setupMapWidthResize();

      expect(section.classList.contains('map-col-narrow')).toBe(true);

      Object.defineProperty(section, 'offsetWidth', { configurable: true, value: 500 });
      handle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }));

      expect(section.classList.contains('map-col-narrow')).toBe(false);
    });
  });

  describe('touch support on the width handle', () => {
    it('resizes and persists from touch events', () => {
      const { main, handle } = buildSplitDom(2200);
      manager.setupMapWidthResize();

      handle.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true, cancelable: true }), {
        touches: [{ clientX: 1320, identifier: 7 }],
        changedTouches: [{ clientX: 1320, identifier: 7 }],
      }));
      document.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true }), {
        touches: [{ clientX: 1100, identifier: 7 }],
      }));
      document.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), {
        changedTouches: [{ identifier: 7 }],
      }));

      expect(main.style.getPropertyValue('--map-col-width')).toBe('50.0%');
      expect(localStorage.getItem('map-col-width')).toBe('50.0%');
    });

    it('ignores another finger lifting mid-drag', () => {
      const { main, handle } = buildSplitDom(2200);
      manager.setupMapWidthResize();

      handle.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true, cancelable: true }), {
        touches: [{ clientX: 1320, identifier: 7 }],
        changedTouches: [{ clientX: 1320, identifier: 7 }],
      }));
      // An unrelated touch ends elsewhere on the page: the drag must survive.
      document.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), {
        changedTouches: [{ identifier: 99 }],
      }));
      document.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true }), {
        touches: [{ clientX: 1100, identifier: 7 }],
      }));

      expect(main.style.getPropertyValue('--map-col-width')).toBe('50.0%');
      expect(localStorage.getItem('map-col-width')).toBeNull();

      document.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), {
        changedTouches: [{ identifier: 7 }],
      }));
      expect(localStorage.getItem('map-col-width')).toBe('50.0%');
    });

    it('tracks the divider touch when another finger is already down', () => {
      const { main, handle } = buildSplitDom(2200);
      manager.setupMapWidthResize();

      handle.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true, cancelable: true }), {
        touches: [
          { clientX: 300, identifier: 3 },
          { clientX: 1320, identifier: 7 },
        ],
        changedTouches: [{ clientX: 1320, identifier: 7 }],
      }));
      document.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true }), {
        touches: [
          { clientX: 300, identifier: 3 },
          { clientX: 1100, identifier: 7 },
        ],
      }));
      document.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), {
        changedTouches: [{ identifier: 7 }],
      }));

      expect(main.style.getPropertyValue('--map-col-width')).toBe('50.0%');
      expect(localStorage.getItem('map-col-width')).toBe('50.0%');
    });

    it('does not let mouse events take over an active touch drag', () => {
      const { main, handle } = buildSplitDom(2200);
      manager.setupMapWidthResize();

      handle.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true, cancelable: true }), {
        touches: [{ clientX: 1320, identifier: 7 }],
        changedTouches: [{ clientX: 1320, identifier: 7 }],
      }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(main.style.getPropertyValue('--map-col-width')).toBe('60.0%');
      expect(localStorage.getItem('map-col-width')).toBeNull();

      document.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true }), {
        touches: [{ clientX: 1100, identifier: 7 }],
      }));
      document.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), {
        changedTouches: [{ identifier: 7 }],
      }));

      expect(main.style.getPropertyValue('--map-col-width')).toBe('50.0%');
      expect(localStorage.getItem('map-col-width')).toBe('50.0%');
    });

    it('ends a live drag when the document is hidden', () => {
      const { handle } = buildSplitDom(2200);
      manager.setupMapWidthResize();

      handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 1320, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 1100, bubbles: true }));
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });

      expect(localStorage.getItem('map-col-width')).toBe('50.0%');
      expect(handle.classList.contains('resizing')).toBe(false);
    });
  });

  describe('width handle affordance', () => {
    it('exposes a tooltip alongside the accessible name', () => {
      const { handle } = buildSplitDom(2200);
      manager.setupMapWidthResize();

      expect(handle.getAttribute('role')).toBe('separator');
      expect(handle.getAttribute('aria-label')).toBeTruthy();
      expect(handle.title).toBeTruthy();
    });
  });

  describe('map side preference', () => {
    function buildSideDom(): { main: HTMLElement; btn: HTMLButtonElement } {
      const { main } = buildSplitDom(2200);
      const btn = document.createElement('button');
      btn.id = 'mapSideBtn';
      main.querySelector('#mapSection')!.append(btn);
      return { main, btn };
    }

    it('toggles the map side and persists the choice', () => {
      const { main, btn } = buildSideDom();
      manager.setupMapSideToggle();

      btn.click();
      expect(main.classList.contains('map-right')).toBe(true);
      expect(localStorage.getItem('map-side')).toBe('right');
      expect(resize).toHaveBeenCalled();

      btn.click();
      expect(main.classList.contains('map-right')).toBe(false);
      expect(localStorage.getItem('map-side')).toBe('left');
    });

    it('inverts the drag direction when the map sits on the right', () => {
      const { main, handle } = buildSplitDom(2200);
      main.classList.add('map-right');
      manager.setupMapWidthResize();

      // Map on the right: moving the divider LEFT grows the map.
      handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 1000, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(main.style.getPropertyValue('--map-col-width')).toBe('64.5%');
    });

    it('inverts the keyboard direction when the map sits on the right', () => {
      const { main, handle } = buildSplitDom(2200);
      main.classList.add('map-right');
      manager.setupMapWidthResize();

      // ArrowRight moves the divider right, which shrinks a right-side map.
      handle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }));

      expect(main.style.getPropertyValue('--map-col-width')).toBe('55.0%');
    });

    it('restores a persisted right-side preference without a click', () => {
      localStorage.setItem('map-side', 'right');
      const { main, btn } = buildSideDom();
      manager.setupMapSideToggle();

      expect(main.classList.contains('map-right')).toBe(true);
      expect(btn.title).toBe('Move map to the left side');
      expect(btn.getAttribute('aria-label')).toBe('Move map to the left side');
      expect(btn.classList.contains('active')).toBe(true);
    });

    it('labels and persists the visual side under RTL', () => {
      const { main, btn } = buildSideDom();
      main.style.direction = 'rtl';
      manager.setupMapSideToggle();

      // In RTL the default grid column is visually right.
      expect(main.classList.contains('map-right')).toBe(false);
      expect(btn.title).toBe('Move map to the left side');
      expect(btn.classList.contains('active')).toBe(true);

      btn.click();
      expect(main.classList.contains('map-right')).toBe(true);
      expect(localStorage.getItem('map-side')).toBe('left');
      expect(btn.title).toBe('Move map to the right side');
      expect(btn.classList.contains('active')).toBe(false);
    });

    it('restores a physical right preference under RTL', () => {
      localStorage.setItem('map-side', 'right');
      const { main, btn } = buildSideDom();
      main.style.direction = 'rtl';
      manager.setupMapSideToggle();

      expect(main.classList.contains('map-right')).toBe(false);
      expect(btn.title).toBe('Move map to the left side');
    });

    it('restores a physical left preference under RTL', () => {
      localStorage.setItem('map-side', 'left');
      const { main, btn } = buildSideDom();
      main.style.direction = 'rtl';
      manager.setupMapSideToggle();

      expect(main.classList.contains('map-right')).toBe(true);
      expect(btn.title).toBe('Move map to the right side');
    });

    it('follows the VISUAL side under RTL, where the grid mirrors', () => {
      const { main, handle } = buildSplitDom(2200);
      main.style.direction = 'rtl';
      manager.setupMapWidthResize();

      // No map-right class, but under RTL grid column 1 sits on the visual
      // right — ArrowRight moves the divider right and shrinks the map.
      handle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }));

      expect(main.style.getPropertyValue('--map-col-width')).toBe('55.0%');
    });
  });

  describe('split layout activation threshold', () => {
    it(`resizes the map container, not the section, from ${SPLIT_LAYOUT_MIN_WIDTH}px up`, () => {
      stubInnerWidth(SPLIT_LAYOUT_MIN_WIDTH + 100);
      const { section, container, handle } = buildHeightDom();
      manager.setupMapResize();

      handle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }));

      expect(container.style.height).toBe('540px');
      expect(section.style.height).toBe('');
    });

    it('still resizes the section below the threshold', () => {
      stubInnerWidth(SPLIT_LAYOUT_MIN_WIDTH - 100);
      const { section, container, handle } = buildHeightDom();
      manager.setupMapResize();

      handle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }));

      expect(section.style.height).toBe('540px');
      expect(container.style.height).toBe('');
    });
  });

  describe('mode-scoped map height storage', () => {
    it('split mode writes map-split-height and leaves map-height alone', () => {
      stubInnerWidth(2000);
      localStorage.setItem('map-height', '400px');
      const { handle } = buildHeightDom();
      manager.setupMapResize();

      handle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }));

      expect(localStorage.getItem('map-split-height')).toBe('540px');
      expect(localStorage.getItem('map-height')).toBe('400px');
    });

    it('stacked mode keeps writing map-height', () => {
      stubInnerWidth(800);
      const { handle } = buildHeightDom();
      manager.setupMapResize();

      handle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }));

      expect(localStorage.getItem('map-height')).toBe('540px');
      expect(localStorage.getItem('map-split-height')).toBeNull();
    });

    it('split restore prefers map-split-height over the legacy shared key', () => {
      stubInnerWidth(2000);
      localStorage.setItem('map-height', '450px');
      localStorage.setItem('map-split-height', '600px');
      const { section, container } = buildHeightDom();
      manager.setupMapResize();

      expect(container.style.height).toBe('600px');
      expect(section.style.height).toBe('');
    });

    it('split restore falls back to the legacy key and completes the migration', () => {
      stubInnerWidth(2000);
      localStorage.setItem('map-height', '450px');
      const { container } = buildHeightDom();
      manager.setupMapResize();

      expect(container.style.height).toBe('450px');
      // The split key is written immediately so later stacked-mode edits to
      // 'map-height' stop steering split restores.
      expect(localStorage.getItem('map-split-height')).toBe('450px');
      expect(localStorage.getItem('map-height')).toBe('450px');
    });

    it('does not migrate a stacked legacy height for newly split web widths', () => {
      stubInnerWidth(1200);
      localStorage.setItem('map-height', '450px');
      const { container } = buildHeightDom();
      manager.setupMapResize();

      expect(container.style.height).toBe('');
      expect(localStorage.getItem('map-split-height')).toBeNull();
      expect(localStorage.getItem('map-height')).toBe('450px');
    });

    it('still migrates a legacy split height for the desktop app', () => {
      manager.destroy();
      manager = new EventHandlerManager({
        container: document.createElement('div'),
        isDesktopApp: true,
        panels: {},
        panelSettings: {},
        mapLayers: {},
        map: { resize, setIsResizing: vi.fn() },
      } as never, {} as never);
      stubInnerWidth(1200);
      localStorage.setItem('map-height', '450px');
      const { container } = buildHeightDom();
      manager.setupMapResize();

      expect(container.style.height).toBe('450px');
      expect(localStorage.getItem('map-split-height')).toBe('450px');
    });

    it('removes an unparseable legacy value from the key it was read from', () => {
      stubInnerWidth(2000);
      localStorage.setItem('map-height', 'garbage');
      buildHeightDom();
      manager.setupMapResize();

      expect(localStorage.getItem('map-height')).toBeNull();
      expect(localStorage.getItem('map-split-height')).toBeNull();
    });
  });

  describe('crossing the split threshold at runtime', () => {
    class FakeMediaQueryList extends EventTarget {
      media: string;
      matches = false;
      constructor(media: string) {
        super();
        this.media = media;
      }
    }

    function stubResponsiveZone(): FakeMediaQueryList[] {
      const lists: FakeMediaQueryList[] = [];
      vi.stubGlobal('matchMedia', (media: string) => {
        const list = new FakeMediaQueryList(media);
        lists.push(list);
        return list;
      });
      return lists;
    }

    it('clears the departing mode\'s inline sizing and applies the arriving mode\'s saved height', () => {
      const lists = stubResponsiveZone();

      stubInnerWidth(2000);
      localStorage.setItem('map-split-height', '600px');
      localStorage.setItem('map-height', '400px');
      const section = document.createElement('section');
      section.id = 'mapSection';
      Object.defineProperty(section, 'offsetHeight', { configurable: true, value: 500 });
      const container = document.createElement('div');
      container.id = 'mapContainer';
      Object.defineProperty(container, 'offsetHeight', { configurable: true, value: 500 });
      const handle = document.createElement('div');
      handle.id = 'mapResizeHandle';
      const bottomGrid = document.createElement('div');
      bottomGrid.id = 'mapBottomGrid';
      section.append(container, handle, bottomGrid);
      document.body.append(section);
      manager.setupMapResize();

      expect(container.style.height).toBe('600px');

      // Narrow below the threshold: split inline styles must not leak into
      // the stacked layout, and the stacked height takes over.
      stubInnerWidth(800);
      lists[0]!.dispatchEvent(new Event('change'));
      expect(container.style.height).toBe('');
      expect(container.style.flex).toBe('');
      expect(section.style.height).toBe('400px');

      // Widen back: the split height returns to the container.
      stubInnerWidth(2000);
      lists[0]!.dispatchEvent(new Event('change'));
      expect(section.style.height).toBe('');
      expect(container.style.height).toBe('600px');
    });

    it('finishes an active height drag before clearing the departing target', () => {
      const lists = stubResponsiveZone();
      stubInnerWidth(2000);
      localStorage.setItem('map-split-height', '600px');
      localStorage.setItem('map-height', '400px');
      const { container, handle } = buildHeightDom();
      manager.setupMapResize();

      handle.dispatchEvent(new MouseEvent('mousedown', { clientY: 0, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 50, bubbles: true }));
      expect(container.style.height).toBe('550px');

      stubInnerWidth(800);
      lists[0]!.dispatchEvent(new Event('change'));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(localStorage.getItem('map-split-height')).toBe('550px');
      expect(localStorage.getItem('map-height')).toBe('400px');
      expect(container.style.height).toBe('');
    });

    it('keeps a double-click reset scoped to the mode where it started', () => {
      vi.useFakeTimers();
      const lists = stubResponsiveZone();
      stubInnerWidth(2000);
      localStorage.setItem('map-split-height', '600px');
      localStorage.setItem('map-height', '450px');
      const { handle } = buildHeightDom();
      manager.setupMapResize();
      const expectedResetHeight = `${window.innerHeight * 0.5}px`;

      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      stubInnerWidth(800);
      lists[0]!.dispatchEvent(new Event('change'));
      vi.advanceTimersByTime(500);

      expect(localStorage.getItem('map-split-height')).toBe(expectedResetHeight);
      expect(localStorage.getItem('map-height')).toBe('450px');
    });
  });
});
