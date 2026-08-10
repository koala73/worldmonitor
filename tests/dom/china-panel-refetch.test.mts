/**
 * China panels: a refetch must not clear rendered content (#scroll-flicker).
 *
 * `handleViewportPrime` re-runs `loadAllData()` on every scroll event, and for
 * the China corridors / activity-nowcast panels that path delegates to
 * `panel.fetchData()`. Both services deliberately run with `cacheTtlMs: 0`
 * (the server owns healthy aggregate caching), so every re-entry is a full RPC
 * round-trip — and `fetchData()` used to open with an unconditional
 * `showLoading()`, replacing live content with the loading radar for the whole
 * round-trip, on every scroll frame. Sibling panels (e.g. MarketBreadthPanel)
 * only show loading/error states when nothing is rendered yet; these tests pin
 * the China pair to the same contract.
 *
 * Lives under tests/dom/ because `Panel` needs a DOM and `@/services/i18n`'s
 * `import.meta.glob` graph, both unreachable from the `tsx --test` profile.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createUnavailableChinaCorridorControlTowerResponse,
  type ChinaCorridorControlTowerResponse,
} from '../../shared/china-corridor-control-towers';
import {
  evaluateChinaActivityNowcast,
  type ChinaActivityNowcastResponse,
} from '../../shared/china-activity-nowcast';

import { initTestI18n } from './helpers/i18n.mts';

const { mockFetchCorridors, mockGetNowcast } = vi.hoisted(() => ({
  mockFetchCorridors: vi.fn(),
  mockGetNowcast: vi.fn(),
}));

vi.mock('@/services/supply-chain', () => ({
  fetchChinaCorridorControlTowers: mockFetchCorridors,
}));

vi.mock('@/services/china-activity-nowcast', () => ({
  getChinaActivityNowcastData: mockGetNowcast,
}));

import { ChinaCorridorPanel } from '@/components/ChinaCorridorPanel';
import { ChinaActivityNowcastPanel } from '@/components/ChinaActivityNowcastPanel';

// setSafeContent debounces content commits; showLoading/showError write
// immediately. Tests advance fake timers past this to flush data renders.
const CONTENT_DEBOUNCE_MS = 150;

const GENERATED_AT = '2026-08-07T00:00:00.000Z';

function corridorResponse(): ChinaCorridorControlTowerResponse {
  return createUnavailableChinaCorridorControlTowerResponse(GENERATED_AT);
}

function nowcastResponse(): ChinaActivityNowcastResponse {
  return evaluateChinaActivityNowcast({
    evaluatedAt: GENERATED_AT,
    officialObservations: [],
    proxyObservations: [],
  });
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function contentOf(panel: object): HTMLElement {
  return (panel as unknown as { content: HTMLElement }).content;
}

function mount(panel: object): void {
  document.body.appendChild((panel as unknown as { element: HTMLElement }).element);
}

async function settle(pending: Promise<unknown>): Promise<void> {
  await pending;
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
}

describe('ChinaCorridorPanel refetch', () => {
  let panel: ChinaCorridorPanel;

  beforeEach(() => {
    mockFetchCorridors.mockReset();
    panel = new ChinaCorridorPanel();
    mount(panel);
  });

  afterEach(() => {
    panel.destroy();
  });

  async function loadOnce(): Promise<void> {
    mockFetchCorridors.mockResolvedValueOnce(corridorResponse());
    await settle(panel.fetchData());
    expect(contentOf(panel).querySelector('.china-corridor-panel')).not.toBeNull();
  }

  it('shows the loading radar on first load while the RPC is pending', async () => {
    const gate = deferred<ChinaCorridorControlTowerResponse>();
    mockFetchCorridors.mockReturnValueOnce(gate.promise);

    const pending = panel.fetchData();
    expect(contentOf(panel).querySelector('.panel-loading')).not.toBeNull();

    gate.resolve(corridorResponse());
    await settle(pending);
    expect(contentOf(panel).querySelector('.china-corridor-panel')).not.toBeNull();
    expect(contentOf(panel).querySelector('.panel-loading')).toBeNull();
  });

  it('keeps rendered corridors visible while a refetch is in flight', async () => {
    await loadOnce();

    const gate = deferred<ChinaCorridorControlTowerResponse>();
    mockFetchCorridors.mockReturnValueOnce(gate.promise);
    const pending = panel.fetchData();

    // The refetch must not replace live content with the loading radar.
    expect(contentOf(panel).querySelector('.panel-loading')).toBeNull();
    expect(contentOf(panel).querySelector('.china-corridor-panel')).not.toBeNull();

    gate.resolve(corridorResponse());
    await settle(pending);
    expect(contentOf(panel).querySelector('.china-corridor-panel')).not.toBeNull();
  });

  it('keeps rendered corridors when a refetch returns an empty payload', async () => {
    await loadOnce();

    mockFetchCorridors.mockResolvedValueOnce({ generatedAt: GENERATED_AT, corridors: [] });
    await settle(panel.fetchData());

    expect(contentOf(panel).querySelector('.panel-error-state')).toBeNull();
    expect(contentOf(panel).querySelector('.china-corridor-panel')).not.toBeNull();
  });

  it('still fails closed to the error state when the first load is empty', async () => {
    mockFetchCorridors.mockResolvedValueOnce({ generatedAt: GENERATED_AT, corridors: [] });
    await settle(panel.fetchData());

    expect(contentOf(panel).querySelector('.panel-error-state')).not.toBeNull();
  });

  it('reports hasData only once corridors are rendered', async () => {
    expect(panel.hasData()).toBe(false);
    await loadOnce();
    expect(panel.hasData()).toBe(true);
  });
});

describe('ChinaActivityNowcastPanel refetch', () => {
  let panel: ChinaActivityNowcastPanel;

  beforeEach(() => {
    mockGetNowcast.mockReset();
    panel = new ChinaActivityNowcastPanel();
    mount(panel);
  });

  afterEach(() => {
    panel.destroy();
  });

  async function loadOnce(): Promise<void> {
    mockGetNowcast.mockResolvedValueOnce(nowcastResponse());
    await settle(panel.fetchData());
    expect(contentOf(panel).querySelector('.china-nowcast-view')).not.toBeNull();
  }

  it('shows the loading radar on first load while the RPC is pending', async () => {
    const gate = deferred<ChinaActivityNowcastResponse>();
    mockGetNowcast.mockReturnValueOnce(gate.promise);

    const pending = panel.fetchData();
    expect(contentOf(panel).querySelector('.panel-loading')).not.toBeNull();

    gate.resolve(nowcastResponse());
    await settle(pending);
    expect(contentOf(panel).querySelector('.china-nowcast-view')).not.toBeNull();
  });

  it('keeps the rendered comparison visible while a refetch is in flight', async () => {
    await loadOnce();

    const gate = deferred<ChinaActivityNowcastResponse>();
    mockGetNowcast.mockReturnValueOnce(gate.promise);
    const pending = panel.fetchData();

    expect(contentOf(panel).querySelector('.panel-loading')).toBeNull();
    expect(contentOf(panel).querySelector('.china-nowcast-view')).not.toBeNull();

    gate.resolve(nowcastResponse());
    await settle(pending);
    expect(contentOf(panel).querySelector('.china-nowcast-view')).not.toBeNull();
  });

  it('reports hasData only once a response is rendered', async () => {
    expect(panel.hasData()).toBe(false);
    await loadOnce();
    expect(panel.hasData()).toBe(true);
  });
});
