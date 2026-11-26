/**
 * China corridor port rows show the PortWatch activity numbers the corridor
 * response carries, not only "observation available" (#11272, finding 129).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createUnavailableChinaCorridorControlTowerResponse,
  type ChinaCorridorControlTowerResponse,
  type CorridorSourceSignal,
} from '../../shared/china-corridor-control-towers';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/supply-chain', () => ({
  fetchChinaCorridorControlTowers: vi.fn(),
}));

import { ChinaCorridorPanel } from '@/components/ChinaCorridorPanel';

const OBSERVED_AT = '2026-11-20T00:00:00.000Z';

function portSignal(metrics: CorridorSourceSignal['metrics']): CorridorSourceSignal {
  return {
    id: `signal:portwatch:port1188:${OBSERVED_AT}`,
    family: 'port',
    selectorId: 'port1188',
    availability: 'available',
    publisher: { id: 'publisher:imf-portwatch', name: 'IMF PortWatch', type: 'official' },
    sourceUrl: 'https://portwatch.imf.org/',
    sourceScope: 'node',
    observationTime: OBSERVED_AT,
    observationTimePrecision: 'instant',
    releaseTime: null,
    releaseTimePrecision: 'unknown',
    retrievalTime: OBSERVED_AT,
    retrievalTimePrecision: 'instant',
    revision: null,
    transportFreshness: 'fresh',
    contentFreshness: 'current',
    summary: 'PortWatch activity observation available for Shanghai.',
    metrics,
  };
}

function responseWithPortSignal(signal: CorridorSourceSignal): ChinaCorridorControlTowerResponse {
  const response = createUnavailableChinaCorridorControlTowerResponse(OBSERVED_AT);
  const [first, ...rest] = response.corridors;
  return {
    ...response,
    corridors: [
      {
        ...first!,
        conditions: first!.conditions.map((condition) => condition.family === 'port'
          ? { ...condition, providerId: 'portwatch', availability: 'available', reason: null, sourceSignals: [signal] }
          : condition),
      },
      ...rest,
    ],
  };
}

function renderPortRow(metrics: CorridorSourceSignal['metrics']): HTMLElement {
  const panel = new ChinaCorridorPanel();
  document.body.appendChild(panel.getElement());
  panel.setData(responseWithPortSignal(portSignal(metrics)));
  vi.advanceTimersByTime(150);
  const row = panel.getElement().querySelector<HTMLElement>('[data-family="port"] .china-corridor-source');
  expect(row).not.toBeNull();
  return row!;
}

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('ChinaCorridorPanel port source rows', () => {
  it('shows labelled tanker calls, 30-day trend, and tanker tonnage', () => {
    vi.useFakeTimers();
    const row = renderPortRow({
      tankerCalls30d: 423,
      trendDelta: -13,
      importTankerDwt30d: 4_250_000,
      exportTankerDwt30d: 812_000,
      anomalySignal: false,
    });
    const metrics = row.querySelector('.china-corridor-source__metrics');
    expect(metrics?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Tanker calls (30d) 423 Change vs prior 30d -13% Import tankers (30d) 4.3M DWT Export tankers (30d) 812K DWT',
    );
    expect(row.textContent).not.toContain('anomalySignal');
    expect(row.textContent).not.toContain('tankerCalls30d');
  });

  it('signs growth and omits metrics the source did not supply', () => {
    vi.useFakeTimers();
    const row = renderPortRow({ tankerCalls30d: 1200, trendDelta: 7.5 });
    const metrics = row.querySelector('.china-corridor-source__metrics');
    expect(metrics?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Tanker calls (30d) 1,200 Change vs prior 30d +7.5%',
    );
  });

  it('renders no metrics line for an unavailable port observation', () => {
    vi.useFakeTimers();
    const row = renderPortRow({});
    expect(row.querySelector('.china-corridor-source__metrics')).toBeNull();
  });
});
