import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { selectWebMcpPanelTab } from '@/app/webmcp-panel-tab-binding';
import { CommoditiesPanel } from '@/components/MarketPanel';
import {
  buildWebMcpTools,
  type WebMcpAppBindings,
} from '@/services/webmcp';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
});

describe('production WebMCP panel-tab binding', () => {
  it('opens the tool path and selects the physical tab on the real panel', async () => {
    const panel = new CommoditiesPanel();
    panel.updatePhysicalPremiums({
      premiums: [{
        metal: 'gold',
        premiumUsdPerOz: 1,
        premiumPct: 1,
        computedAt: '2026-08-18T12:30:00.000Z',
      }],
    });
    const bindings = {
      applyDashboardAction: async (action: { type: string }) => ({
        ok: true as const,
        status: 'applied' as const,
        actionType: action.type,
        message: 'Opened panel.',
        targets: [],
      }),
      selectPanelTab: (panelId: string, tab: string, options?: { signal?: AbortSignal }) => (
        selectWebMcpPanelTab({ commodities: panel }, panelId, tab, {
          waitForUiReady: async () => {},
          signal: options?.signal,
        })
      ),
    } as unknown as WebMcpAppBindings;
    const tool = buildWebMcpTools(bindings, () => {})
      .find((candidate) => candidate.name === 'open_dashboard_panel');
    expect(tool).toBeDefined();

    const result = await tool!.execute({ panelId: 'commodities', tab: 'physical' }) as {
      ok: boolean;
      panelTab: { effectiveTab?: string };
    };

    expect(result.ok).toBe(true);
    expect(result.panelTab.effectiveTab).toBe('physical');
    expect(panel.getActiveTab()).toBe('physical');
  });

  it('reports unsupported and not-live panels through the production mapping', async () => {
    const waitForUiReady = vi.fn(async () => {});
    await expect(selectWebMcpPanelTab({}, 'markets', 'physical', { waitForUiReady }))
      .resolves.toMatchObject({ ok: false, status: 'invalid', reason: 'panel_unsupported' });
    await expect(selectWebMcpPanelTab({}, 'commodities', 'physical', { waitForUiReady }))
      .resolves.toMatchObject({ ok: false, status: 'denied', reason: 'panel_not_live' });
    expect(waitForUiReady).toHaveBeenCalledTimes(2);
  });

  it('waits for a cold physical comparison before selecting the tab', async () => {
    const panel = new CommoditiesPanel();
    const order: string[] = [];
    const selected = await selectWebMcpPanelTab(
      { commodities: panel },
      'commodities',
      'physical',
      {
        waitForUiReady: async () => { order.push('ready'); },
        prepareTab: async () => {
          order.push('load');
          panel.updatePhysicalPremiums({
            premiums: [{
              metal: 'gold',
              premiumUsdPerOz: 1,
              premiumPct: 1,
              computedAt: '2026-08-18T12:30:00.000Z',
            }],
          });
        },
      },
    );

    expect(order).toEqual(['ready', 'load']);
    expect(selected).toMatchObject({ ok: true, effectiveTab: 'physical' });
    expect(panel.getActiveTab()).toBe('physical');
  });

  it('selects a warm physical tab without refreshing or erasing retained data', async () => {
    const panel = new CommoditiesPanel();
    panel.updatePhysicalPremiums({
      premiums: [{
        metal: 'gold',
        premiumUsdPerOz: 1,
        premiumPct: 1,
        computedAt: '2026-08-18T12:30:00.000Z',
      }],
    });
    const prepareTab = vi.fn(async () => panel.updatePhysicalPremiums({ premiums: [] }));

    const selected = await selectWebMcpPanelTab(
      { commodities: panel },
      'commodities',
      'physical',
      { waitForUiReady: async () => {}, prepareTab },
    );

    expect(selected).toMatchObject({ ok: true, effectiveTab: 'physical' });
    expect(prepareTab).not.toHaveBeenCalled();
    expect(panel.getActiveTab()).toBe('physical');
  });

  it('keeps a completed empty physical comparison unavailable', async () => {
    const panel = new CommoditiesPanel();
    const selected = await selectWebMcpPanelTab(
      { commodities: panel },
      'commodities',
      'physical',
      {
        waitForUiReady: async () => {},
        prepareTab: async () => panel.updatePhysicalPremiums({ premiums: [] }),
      },
    );

    expect(selected).toMatchObject({
      ok: false,
      status: 'denied',
      reason: 'tab_unavailable',
      effectiveTab: 'commodities',
    });
    expect(panel.getActiveTab()).toBe('commodities');
  });

  it('does not mutate the panel after cancellation', async () => {
    const panel = new CommoditiesPanel();
    const controller = new AbortController();
    controller.abort(new DOMException('Cancelled.', 'AbortError'));

    await expect(selectWebMcpPanelTab({ commodities: panel }, 'commodities', 'physical', {
      waitForUiReady: async () => {},
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(panel.getActiveTab()).toBe('commodities');
  });

  it('does not select the physical tab when cancellation arrives during preparation', async () => {
    const panel = new CommoditiesPanel();
    const controller = new AbortController();
    let finishPreparation!: () => void;
    const prepareTab = vi.fn(() => new Promise<void>((resolve) => {
      finishPreparation = resolve;
    }));

    const selection = selectWebMcpPanelTab({ commodities: panel }, 'commodities', 'physical', {
      waitForUiReady: async () => {},
      prepareTab,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(prepareTab).toHaveBeenCalledOnce());
    controller.abort(new DOMException('Cancelled.', 'AbortError'));
    finishPreparation();

    await expect(selection).rejects.toMatchObject({ name: 'AbortError' });
    expect(panel.getActiveTab()).toBe('commodities');
  });
});
