/**
 * A failed background refresh must keep the last good filing list. fetchData
 * only shows an error before the first success, so a refresh that blanked
 * the rows with the loading radar first would leave the panel spinning until
 * the next successful tick.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { mockListMaterialEvents } = vi.hoisted(() => ({
  mockListMaterialEvents: vi.fn(),
}));

vi.mock('@/generated/client/worldmonitor/intelligence/v1/service_client', () => ({
  IntelligenceServiceClient: class {
    listMaterialEvents = mockListMaterialEvents;
  },
}));

import { MaterialEventsPanel } from '@/components/MaterialEventsPanel';

const CONTENT_DEBOUNCE_MS = 150;
const NOW = '2026-08-31T12:00:00.000Z';

function okResponse() {
  return {
    events: [{
      company: 'ACME CORP',
      cik: '0000123456',
      form: '8-K',
      accession: '0000123456-26-000001',
      filedAtMs: Date.parse(NOW) - 3_600_000,
      items: [{ code: '5.02', description: 'Departure of Directors or Certain Officers' }],
      url: 'https://www.sec.gov/Archives/edgar/data/123456/000012345626000001-index.htm',
    }],
    unavailable: false,
    fetchedAtMs: Date.parse(NOW),
  };
}

async function settle(pending: Promise<boolean>): Promise<boolean> {
  const result = await pending;
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
  return result;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  mockListMaterialEvents.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('MaterialEventsPanel refresh', () => {
  it.each([
    ['the RPC throws', () => Promise.reject(new Error('network down'))],
    ['the stream is unavailable', () => Promise.resolve({ events: [], unavailable: true, fetchedAtMs: 0 })],
  ])('keeps the rendered filings when a refresh fails because %s', async (_label, failure) => {
    const panel = new MaterialEventsPanel();
    document.body.appendChild(panel.getElement());

    mockListMaterialEvents.mockImplementationOnce(() => Promise.resolve(okResponse()));
    expect(await settle(panel.fetchData())).toBe(true);
    expect(panel.getElement().textContent).toContain('ACME CORP');

    mockListMaterialEvents.mockImplementationOnce(failure);
    expect(await settle(panel.fetchData())).toBe(false);

    const element = panel.getElement();
    expect(element.textContent).toContain('ACME CORP');
    expect(element.querySelector('.panel-loading')).toBeNull();
  });

  it('shares one in-flight request across overlapping callers', async () => {
    const panel = new MaterialEventsPanel();
    document.body.appendChild(panel.getElement());

    let resolveFirst!: (value: ReturnType<typeof okResponse>) => void;
    const firstResponse = new Promise<ReturnType<typeof okResponse>>((resolve) => { resolveFirst = resolve; });
    mockListMaterialEvents.mockImplementationOnce(() => firstResponse);
    mockListMaterialEvents.mockImplementation(() => Promise.resolve(okResponse()));

    // The auto-retry countdown calls fetchData directly, outside the refresh
    // scheduler's in-flight lock, so it can overlap a scheduled refresh.
    const first = panel.fetchData();
    const second = panel.fetchData();
    resolveFirst(okResponse());

    expect(await settle(first)).toBe(true);
    expect(await settle(second)).toBe(true);
    expect(mockListMaterialEvents).toHaveBeenCalledTimes(1);

    // Once settled, the next call issues a fresh request.
    expect(await settle(panel.fetchData())).toBe(true);
    expect(mockListMaterialEvents).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['unavailable', { events: [], unavailable: true, fetchedAtMs: 0 }],
    ['empty', { events: [], unavailable: false, fetchedAtMs: 0 }],
  ])('reports an %s first load as unavailable, not as a quiet feed', async (_label, response) => {
    const panel = new MaterialEventsPanel();
    document.body.appendChild(panel.getElement());

    mockListMaterialEvents.mockImplementationOnce(() => Promise.resolve(response));
    expect(await settle(panel.fetchData())).toBe(false);

    const text = panel.getElement().textContent ?? '';
    expect(text).toContain('SEC material events are temporarily unavailable');
    expect(text).not.toContain('No recent SEC material events');
  });

  it('shows a retryable error when the first load fails', async () => {
    const panel = new MaterialEventsPanel();
    document.body.appendChild(panel.getElement());

    mockListMaterialEvents.mockImplementationOnce(() => Promise.reject(new Error('network down')));
    expect(await settle(panel.fetchData())).toBe(false);

    const element = panel.getElement();
    expect(element.querySelector('.panel-loading')).toBeNull();
    expect(element.textContent).toContain('network down');
  });
});
