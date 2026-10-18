import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GetChokepointStatusResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { ChokepointStripPanel } from '@/components/ChokepointStripPanel';
import { SupplyChainPanel } from '@/components/SupplyChainPanel';
import { mountEmbedChokepointStrip } from '@/embed/panels/chokepoint-strip';
import { getChokepointStatus } from '../../server/worldmonitor/supply-chain/v1/get-chokepoint-status';
import capture from '../fixtures/chokepoints-routing-advice-2026-09-10.json';
import { initTestI18n } from './helpers/i18n.mts';

const partialResponse = {
  chokepoints: [{
    id: 'suez',
    name: 'Suez Canal',
    status: 'green',
    activeWarnings: 0,
    aisDisruptions: 0,
    navigationalWarningsAvailable: false,
    aisSnapshotAvailable: true,
    affectedRoutes: [],
    description: 'No active disruptions reported by available sources; source coverage incomplete',
    directions: [],
    disruptionScore: 0,
    flowEstimate: { currentMbd: 5, baselineMbd: 5, flowRatio: 1, disrupted: false },
    transitSummary: { dataAvailable: true },
  }],
  fetchedAt: '2026-09-02T00:00:00.000Z',
  upstreamUnavailable: true,
} as unknown as GetChokepointStatusResponse;

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chokepoint partial coverage', () => {
  it('renders critical Hormuz status without advice or an observed zero after a legacy cache read', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.test');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('https://redis.test/get/')) return Response.json({ result: JSON.stringify(capture.body) });
      return Response.json({});
    });
    try {
      const response = await getChokepointStatus({} as never, {});
      for (const data of [capture.body as unknown as GetChokepointStatusResponse, response]) {
        const panel = new SupplyChainPanel();
        panel.updateChokepointStatus(data);
        await vi.advanceTimersByTimeAsync(151);
        panel.getElement().querySelector<HTMLElement>('[data-cp-id="Strait of Hormuz"] .trade-restriction-header')!.click();
        await vi.advanceTimersByTimeAsync(151);
        const card = panel.getElement().querySelector('[data-cp-id="Strait of Hormuz"]')!;
        expect(card.querySelector('.trade-restriction-header')?.getAttribute('aria-expanded')).toBe('true');
        expect(card.textContent).toContain('critical');
        expect(card.textContent).toContain('628');
        expect(card.textContent).toContain('red');
        expect(card.textContent).not.toMatch(/REROUTE|50-80K|Salalah|0 vessels/);
        expect(card.querySelector('.sc-routing-advisory')).toBeNull();
        panel.destroy();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('shows the warning in the full supply-chain panel when rows remain available', async () => {
    const panel = new SupplyChainPanel();
    panel.updateChokepointStatus(partialResponse);
    await vi.advanceTimersByTimeAsync(151);

    const warning = panel.getElement().querySelector('.economic-warning');
    expect(warning?.textContent).toContain('Supply chain data temporarily unavailable');
  });

  it('shows the warning in the compact chokepoint strip', async () => {
    const panel = new ChokepointStripPanel();
    const harness = panel as unknown as {
      data: GetChokepointStatusResponse;
      render(): void;
    };
    harness.data = partialResponse;
    harness.render();
    await vi.advanceTimersByTimeAsync(151);

    const warning = panel.getElement().querySelector('.cp-strip-warning');
    expect(warning?.textContent).toContain('Supply chain data temporarily unavailable');
  });

  it('shows the warning in the partner embed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(partialResponse));
    const root = document.createElement('div');

    await mountEmbedChokepointStrip(root, 'wm_test_key');

    const warning = root.querySelector('.wm-embed-cp-warning');
    expect(warning?.textContent).toContain('Supply chain data temporarily unavailable');
  });

  // Nonzero counters are what make this meaningful: with zeros, a surface that
  // ignored the availability flags would still show nothing.
  const WARNINGS = 7;
  const AIS = 13;
  function countersResponse(available: boolean): GetChokepointStatusResponse {
    const [row] = partialResponse.chokepoints;
    return {
      ...partialResponse,
      chokepoints: [{
        ...row!,
        activeWarnings: WARNINGS,
        aisDisruptions: AIS,
        navigationalWarningsAvailable: available,
        aisSnapshotAvailable: available,
      }],
    } as GetChokepointStatusResponse;
  }

  async function supplyChainCardMetrics(data: GetChokepointStatusResponse): Promise<string> {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
    const panel = new SupplyChainPanel();
    panel.updateChokepointStatus(data);
    await vi.advanceTimersByTimeAsync(151);
    panel.getElement().querySelector<HTMLElement>('[data-cp-id="Suez Canal"] .trade-restriction-header')!.click();
    await vi.advanceTimersByTimeAsync(151);
    const row = panel.getElement().querySelector('[data-cp-id="Suez Canal"] .sc-metric-row');
    const text = row?.textContent ?? '';
    panel.destroy();
    return text;
  }

  it('withholds nonzero warning and AIS counts in the supply-chain card when their sources are unavailable', async () => {
    const shown = await supplyChainCardMetrics(countersResponse(true));
    expect(shown).toContain(`${WARNINGS} `);
    expect(shown).toContain(`${AIS} `);

    const withheld = await supplyChainCardMetrics(countersResponse(false));
    expect(withheld).not.toContain(String(WARNINGS));
    expect(withheld).not.toContain(String(AIS));
  });

  it('withholds nonzero warning and AIS counts in the compact strip when their sources are unavailable', async () => {
    const render = async (data: GetChokepointStatusResponse) => {
      const panel = new ChokepointStripPanel();
      const harness = panel as unknown as { data: GetChokepointStatusResponse; render(): void };
      harness.data = data;
      harness.render();
      await vi.advanceTimersByTimeAsync(151);
      const el = panel.getElement();
      return {
        warn: el.querySelector('.cp-chip-warn')?.textContent ?? null,
        aisSample: el.querySelector('[data-attr-n]')?.getAttribute('data-attr-n') ?? null,
      };
    };

    expect(await render(countersResponse(true))).toEqual({ warn: String(WARNINGS), aisSample: String(AIS) });
    expect(await render(countersResponse(false))).toEqual({ warn: null, aisSample: null });
  });

  it('withholds a nonzero warning count in the partner embed when navigational warnings are unavailable', async () => {
    const mount = async (data: GetChokepointStatusResponse) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(data));
      const root = document.createElement('div');
      await mountEmbedChokepointStrip(root, 'wm_test_key');
      return root.querySelector('.wm-embed-cp-warn')?.textContent ?? null;
    };

    expect(await mount(countersResponse(true))).toBe(String(WARNINGS));
    expect(await mount(countersResponse(false))).toBeNull();
  });
});
