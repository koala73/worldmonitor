import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WatchlistTableView } from '@/components/WatchlistTableView';

type Item = { symbol: string };

function createView(): WatchlistTableView<Item> {
  const view = new WatchlistTableView<Item>({
    columns: [{ key: 'symbol', label: 'Symbol', cell: item => item.symbol }],
    filters: [{ key: 'all', label: 'All', match: () => true }],
    sortOptions: [{ key: 'symbol', label: 'Symbol', cmp: (a, b) => a.symbol.localeCompare(b.symbol) }],
    defaultSort: 'symbol',
    defaultFilter: 'all',
    getKey: item => item.symbol,
    getSearchText: item => item.symbol,
    renderDetail: item => `<section>Detail ${item.symbol}</section>`,
  });
  view.setItems(Array.from({ length: 200 }, (_, index) => ({
    symbol: `SYM${String(index).padStart(3, '0')}`,
  })));
  return view;
}

function rect(height: number, width = 300, top = 0): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: width,
    bottom: top + height,
    left: 0,
    width,
    height,
    toJSON: () => ({}),
  };
}

async function afterObserverFrame(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

describe('WatchlistTableView scaled virtualization', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let mountedDetailTopForScale = (_scale: number): number => 0;
  let resizeObservers: Array<{ active: boolean; callback: ResizeObserverCallback }> = [];

  function notifyResizeObservers(): void {
    for (const observer of resizeObservers) {
      if (observer.active) observer.callback([], {} as ResizeObserver);
    }
  }

  beforeEach(() => {
    resizeObservers = [];
    vi.stubGlobal('ResizeObserver', class {
      private registration: { active: boolean; callback: ResizeObserverCallback };

      constructor(callback: ResizeObserverCallback) {
        this.registration = { active: true, callback };
        resizeObservers.push(this.registration);
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void { this.registration.active = false; }
    });
    document.documentElement.style.setProperty('--wm-font-scale', '1');
    document.body.replaceChildren();
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const element = this as HTMLElement;
      const panel = element.closest<HTMLElement>('.panel');
      const scale = Number(
        panel?.style.getPropertyValue('--wm-panel-font-scale')
        || document.documentElement.style.getPropertyValue('--wm-font-scale')
        || '1',
      );
      if (panel?.classList.contains('is-hidden')) return rect(0);
      if (element.classList.contains('watchlist-row')) return rect(33 * scale);
      if (element.classList.contains('watchlist-detail-row')) {
        return rect(150 + 75 * scale, 300, mountedDetailTopForScale(scale));
      }
      if (element.tagName === 'THEAD') return rect(12 + 15 * scale, 600);
      if (element.dataset.watchlistScroll === '1') return rect(500, 600);
      if (element.classList.contains('watchlist-table')) return rect(400, 600);
      return rect(0);
    });
  });

  afterEach(() => {
    rectSpy.mockRestore();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('style');
    document.body.replaceChildren();
  });

  it('retains its window and remeasures offscreen detail for global scaling', async () => {
    const panel = document.createElement('section');
    panel.className = 'panel';
    const host = document.createElement('div');
    panel.appendChild(host);
    document.body.appendChild(panel);

    const view = createView();
    const state = (view as unknown as { state: {
      expandedKey: string | null;
      expandedDetailHeight: number;
      virtualScrollTop: number;
      virtualStart: number;
    } }).state;
    state.expandedKey = 'SYM002';
    state.expandedDetailHeight = 225;
    state.virtualStart = 87;
    state.virtualScrollTop = 3_300;
    host.innerHTML = view.render();
    view.bind(host, () => {});

    const scroll = host.querySelector<HTMLElement>('[data-watchlist-scroll="1"]')!;
    const tbody = host.querySelector<HTMLTableSectionElement>('tbody')!;
    const sentinel = document.createElement('tr');
    sentinel.className = 'before-scale-sentinel';
    tbody.appendChild(sentinel);

    document.documentElement.style.setProperty('--wm-font-scale', '2');
    notifyResizeObservers();
    await afterObserverFrame();

    expect(scroll.scrollTop).toBe(6_438);
    expect(state.virtualStart).toBe(87);
    expect(state.expandedDetailHeight).toBe(300);
    expect(tbody.querySelector('.before-scale-sentinel')).toBeNull();
    view.destroy();
  });

  it('retains its window and remeasures offscreen detail for panel scaling', async () => {
    document.documentElement.style.setProperty('--wm-font-scale', '2');
    const panel = document.createElement('section');
    panel.className = 'panel';
    const host = document.createElement('div');
    panel.appendChild(host);
    document.body.appendChild(panel);

    const view = createView();
    const state = (view as unknown as { state: {
      expandedKey: string | null;
      expandedDetailHeight: number;
      virtualScrollTop: number;
      virtualStart: number;
    } }).state;
    state.expandedKey = 'SYM002';
    state.expandedDetailHeight = 300;
    state.virtualStart = 87;
    state.virtualScrollTop = 6_438;
    host.innerHTML = view.render();
    view.bind(host, () => {});
    const scroll = host.querySelector<HTMLElement>('[data-watchlist-scroll="1"]')!;

    panel.style.setProperty('--wm-panel-font-scale', '1.5');
    notifyResizeObservers();
    await afterObserverFrame();
    await vi.waitFor(() => {
      expect(scroll.scrollTop).toBe(4_869.5);
      expect(state.virtualStart).toBe(87);
      expect(state.expandedDetailHeight).toBe(263);
    });
    view.destroy();
  });

  it('does not mutate detached DOM after destroy', async () => {
    const panel = document.createElement('section');
    panel.className = 'panel';
    const host = document.createElement('div');
    panel.appendChild(host);
    document.body.appendChild(panel);

    const view = createView();
    host.innerHTML = view.render();
    view.bind(host, () => {});
    const scroll = host.querySelector<HTMLElement>('[data-watchlist-scroll="1"]')!;
    const before = scroll.scrollTop;

    document.documentElement.style.setProperty('--wm-font-scale', '2');
    notifyResizeObservers();
    view.destroy();
    panel.remove();
    await afterObserverFrame();

    expect(scroll.scrollTop).toBe(before);
  });

  it('remeasures after a hidden panel becomes visible at the new scale', async () => {
    const panel = document.createElement('section');
    panel.className = 'panel';
    const host = document.createElement('div');
    panel.appendChild(host);
    document.body.appendChild(panel);

    const view = createView();
    const state = (view as unknown as { state: {
      virtualScrollTop: number;
      virtualStart: number;
    } }).state;
    state.virtualStart = 87;
    state.virtualScrollTop = 3_300;
    host.innerHTML = view.render();
    view.bind(host, () => {});
    const scroll = host.querySelector<HTMLElement>('[data-watchlist-scroll="1"]')!;

    panel.classList.add('is-hidden');
    document.documentElement.style.setProperty('--wm-font-scale', '2');
    notifyResizeObservers();
    await afterObserverFrame();
    expect(scroll.scrollTop).toBe(3_300);

    panel.classList.remove('is-hidden');
    notifyResizeObservers();
    await afterObserverFrame();
    expect(scroll.scrollTop).toBe(6_588);
    expect(state.virtualScrollTop).toBe(6_588);
    view.destroy();
  });

  it('keeps the last measured scale when it rebinds while hidden', async () => {
    document.documentElement.style.setProperty('--wm-font-scale', '2');
    const panel = document.createElement('section');
    panel.className = 'panel';
    const host = document.createElement('div');
    panel.appendChild(host);
    document.body.appendChild(panel);

    const view = createView();
    const state = (view as unknown as { state: {
      virtualScrollTop: number;
      virtualStart: number;
    } }).state;
    state.virtualStart = 87;
    state.virtualScrollTop = 6_588;
    host.innerHTML = view.render();
    view.bind(host, () => {});

    panel.classList.add('is-hidden');
    host.innerHTML = view.render();
    view.bind(host, () => {});
    const scroll = host.querySelector<HTMLElement>('[data-watchlist-scroll="1"]')!;
    expect(scroll.scrollTop).toBe(6_588);

    panel.classList.remove('is-hidden');
    notifyResizeObservers();
    await afterObserverFrame();
    expect(scroll.scrollTop).toBe(6_588);
    expect(state.virtualScrollTop).toBe(6_588);
    view.destroy();
  });

  it('anchors an expanded overscan detail that is above the viewport', async () => {
    const panel = document.createElement('section');
    panel.className = 'panel';
    const host = document.createElement('div');
    panel.appendChild(host);
    document.body.appendChild(panel);

    const view = createView();
    const state = (view as unknown as { state: {
      expandedKey: string | null;
      expandedDetailHeight: number;
      virtualScrollTop: number;
      virtualStart: number;
    } }).state;
    state.expandedKey = 'SYM090';
    state.expandedDetailHeight = 225;
    state.virtualStart = 87;
    state.virtualScrollTop = 3_300;
    mountedDetailTopForScale = scale => scale === 1 ? -300 : 100;
    host.innerHTML = view.render();
    view.bind(host, () => {});
    const scroll = host.querySelector<HTMLElement>('[data-watchlist-scroll="1"]')!;

    document.documentElement.style.setProperty('--wm-font-scale', '2');
    notifyResizeObservers();
    await afterObserverFrame();

    expect(scroll.scrollTop).toBe(6_438);
    expect(state.expandedDetailHeight).toBe(300);
    view.destroy();
  });

  it('reconciles a visible rebind before the queued scale frame runs', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });

    const panel = document.createElement('section');
    panel.className = 'panel';
    const host = document.createElement('div');
    panel.appendChild(host);
    document.body.appendChild(panel);

    const view = createView();
    const state = (view as unknown as { state: {
      expandedKey: string | null;
      expandedDetailHeight: number;
      virtualScrollTop: number;
      virtualStart: number;
    } }).state;
    state.expandedKey = 'SYM002';
    state.expandedDetailHeight = 225;
    state.virtualStart = 87;
    state.virtualScrollTop = 3_300;
    host.innerHTML = view.render();
    view.bind(host, () => {});

    document.documentElement.style.setProperty('--wm-font-scale', '2');
    notifyResizeObservers();
    const staleScaleFrame = frames.shift()!;

    host.innerHTML = view.render();
    view.bind(host, () => {});
    const scroll = host.querySelector<HTMLElement>('[data-watchlist-scroll="1"]')!;
    expect(scroll.scrollTop).toBe(6_438);
    expect(state.virtualScrollTop).toBe(6_438);
    expect(state.expandedDetailHeight).toBe(300);
    expect(state.virtualStart).toBe(87);

    staleScaleFrame(0);
    expect(scroll.scrollTop).toBe(6_438);
    expect(state.virtualScrollTop).toBe(6_438);
    view.destroy();
  });

  it('ignores a queued scroll frame from an earlier bind', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });

    const panel = document.createElement('section');
    panel.className = 'panel';
    const host = document.createElement('div');
    panel.appendChild(host);
    document.body.appendChild(panel);

    const view = createView();
    const state = (view as unknown as { state: {
      virtualScrollTop: number;
      virtualStart: number;
    } }).state;
    host.innerHTML = view.render();
    view.bind(host, () => {});
    const oldScroll = host.querySelector<HTMLElement>('[data-watchlist-scroll="1"]')!;
    oldScroll.scrollTop = 3_300;
    oldScroll.dispatchEvent(new Event('scroll'));
    const oldFrame = frames.shift()!;

    host.innerHTML = view.render();
    view.bind(host, () => {});
    const currentScroll = host.querySelector<HTMLElement>('[data-watchlist-scroll="1"]')!;
    const currentTbody = host.querySelector<HTMLTableSectionElement>('tbody')!;
    const sentinel = document.createElement('tr');
    sentinel.className = 'current-bind-sentinel';
    currentTbody.appendChild(sentinel);
    currentScroll.scrollTop = 4_000;
    currentScroll.dispatchEvent(new Event('scroll'));

    expect(frames).toHaveLength(1);
    oldFrame(0);
    expect(state.virtualStart).toBe(0);
    expect(state.virtualScrollTop).toBe(4_000);
    expect(currentTbody.querySelector('.current-bind-sentinel')).not.toBeNull();

    currentScroll.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(1);
    frames.shift()!(16);
    expect(state.virtualStart).toBeGreaterThan(0);
    expect(currentTbody.querySelector('.current-bind-sentinel')).toBeNull();
    view.destroy();
  });
});
