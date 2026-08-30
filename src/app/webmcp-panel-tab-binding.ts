import { CommoditiesPanel } from '@/components/MarketPanel';
import {
  throwIfWebMcpAborted,
  type PanelTabSelectionResult,
} from '@/services/webmcp';

interface PanelTabBindingOptions {
  waitForUiReady: () => Promise<void> | void;
  signal?: AbortSignal;
}

export async function selectWebMcpPanelTab(
  panels: Record<string, unknown>,
  panelId: string,
  tab: string,
  options: PanelTabBindingOptions,
): Promise<PanelTabSelectionResult> {
  await options.waitForUiReady();
  throwIfWebMcpAborted(options.signal);
  if (panelId !== 'commodities') {
    return {
      ok: false,
      status: 'invalid',
      panelId,
      requestedTab: tab,
      reason: 'panel_unsupported',
      message: 'That panel does not expose a selectable subtab.',
    };
  }
  const panel = panels[panelId];
  if (!(panel instanceof CommoditiesPanel)) {
    return {
      ok: false,
      status: 'denied',
      panelId,
      requestedTab: tab,
      reason: 'panel_not_live',
      message: 'The commodities panel is not live.',
    };
  }
  const selected = panel.selectTab(tab);
  return {
    ...selected,
    panelId,
    requestedTab: tab,
    message: selected.ok
      ? selected.status === 'skipped' ? 'Panel tab was already selected.' : 'Selected panel tab.'
      : selected.reason === 'unknown_tab'
        ? 'Unknown commodities panel tab.'
        : 'That commodities panel tab is not currently available.',
  };
}
