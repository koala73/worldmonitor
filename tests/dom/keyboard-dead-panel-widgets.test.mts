/**
 * #7023 (phase-2 residual) — keyboard access for the two remaining
 * click-only table widgets:
 *
 *   - WsbTickerScannerPanel exposes native sort buttons while keeping
 *     aria-sort on each column header.
 *   - CountryDeepDivePanel exposes native disclosure buttons inside its
 *     sector rows without overriding the table row semantics.
 *
 * Both widgets rebuild their DOM after activation, so these tests also prove
 * that focus moves to the equivalent replacement control.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { WsbTickerScannerPanel } from '@/components/WsbTickerScannerPanel';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import type {
  GetCountryChokepointIndexResponse,
  SectorExposureSummary,
} from '@/services/supply-chain';

/** Panel.setSafeContent debounces string content by 150ms. */
const flushPanelContent = () => new Promise((resolve) => setTimeout(resolve, 200));

function ticker(symbol: string, mentionCount: number, totalScore: number) {
  return {
    symbol,
    mentionCount,
    uniquePosts: 1,
    totalScore,
    avgUpvoteRatio: 0.9,
    subreddits: ['wallstreetbets'],
    velocityScore: 1,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});
describe('WsbTickerScannerPanel sortable headers (#7023)', () => {
  async function renderedPanel(): Promise<{ panel: WsbTickerScannerPanel; content: HTMLElement }> {
    const panel = new WsbTickerScannerPanel();
    document.body.appendChild(panel.getElement());
    panel.updateData([ticker('GME', 50, 10), ticker('AMC', 20, 90)]);
    await flushPanelContent();
    const content = panel.getElement().querySelector<HTMLElement>('.panel-content');
    expect(content).toBeTruthy();
    return { panel, content: content! };
  }

  it('uses native sort buttons while aria-sort stays on the column headers', async () => {
    const { content } = await renderedPanel();
    const headers = [...content.querySelectorAll<HTMLElement>('th[data-sort]')];
    const buttons = [...content.querySelectorAll<HTMLButtonElement>('button[data-sort]')];

    expect(headers).toHaveLength(3);
    expect(buttons).toHaveLength(3);
    for (const th of headers) {
      expect(th.hasAttribute('tabindex')).toBe(false);
    }
    for (const button of buttons) {
      expect(button.type).toBe('button');
    }

    // Default sort: mentionCount descending.
    expect(content.querySelector('th[data-sort="mentionCount"]')!.getAttribute('aria-sort')).toBe('descending');
    expect(content.querySelector('th[data-sort="totalScore"]')!.hasAttribute('aria-sort')).toBe(false);
  });

  it('sorts through the native control and restores focus after the debounced render', async () => {
    const { content } = await renderedPanel();
    const button = content.querySelector<HTMLButtonElement>('button[data-sort="totalScore"]')!;

    button.focus();
    button.click();
    await flushPanelContent();

    const replacement = content.querySelector<HTMLButtonElement>('button[data-sort="totalScore"]')!;
    const rows = [...content.querySelectorAll<HTMLElement>('tbody tr')];
    expect(rows[0]?.textContent ?? '').toContain('AMC');
    expect(content.querySelector('th[data-sort="totalScore"]')!.getAttribute('aria-sort')).toBe('descending');
    expect(document.activeElement).toBe(replacement);
  });

  it('keeps focus when the active sort button flips the direction', async () => {
    const { content } = await renderedPanel();
    const button = content.querySelector<HTMLButtonElement>('button[data-sort="mentionCount"]')!;

    button.focus();
    button.click();
    await flushPanelContent();

    const replacement = content.querySelector<HTMLButtonElement>('button[data-sort="mentionCount"]')!;
    expect(content.querySelector('th[data-sort="mentionCount"]')!.getAttribute('aria-sort')).toBe('ascending');
    const rows = [...content.querySelectorAll<HTMLElement>('tbody tr')];
    expect(rows[0]?.textContent ?? '').toContain('AMC');
    expect(document.activeElement).toBe(replacement);
  });
});

describe('CountryDeepDivePanel sector rows (#7023)', () => {
  type CdpInternals = {
    tradeExposureBody: HTMLElement | null;
    cachedTradeExposureData: GetCountryChokepointIndexResponse | null;
    cachedSectors: SectorExposureSummary[];
    renderTradeExposureContent(): void;
  };

  const exposureData: GetCountryChokepointIndexResponse = {
    iso2: 'US',
    hs2: '',
    exposures: [],
    primaryChokepointId: '',
    vulnerabilityIndex: 42,
    fetchedAt: '2026-09-01T00:00:00Z',
  };

  const sectors: SectorExposureSummary[] = [
    {
      hs2: '85',
      label: 'Electronics',
      dependencyFlag: 'DEPENDENCY_FLAG_DIVERSIFIABLE',
      primaryChokepointId: 'test-electronics-route',
      primaryChokepointName: 'Malacca',
      exposureScore: 61,
      vulnerabilityIndex: 42,
      primaryExporterIso2: 'CN',
      primaryExporterShare: 0.4,
    },
    {
      hs2: '27',
      label: 'Fuels',
      dependencyFlag: 'DEPENDENCY_FLAG_COMPOUND_RISK',
      primaryChokepointId: 'test-fuels-route',
      primaryChokepointName: 'Hormuz',
      exposureScore: 88,
      vulnerabilityIndex: 64,
      primaryExporterIso2: 'SA',
      primaryExporterShare: 0.3,
    },
  ];

  function renderedRows(): { body: HTMLElement } {
    const panel = new CountryDeepDivePanel(null);
    const internals = panel as unknown as CdpInternals;
    const body = document.createElement('div');
    document.body.appendChild(body);
    internals.tradeExposureBody = body;
    internals.cachedTradeExposureData = exposureData;
    internals.cachedSectors = sectors;
    internals.renderTradeExposureContent();
    return { body };
  }

  it('keeps row semantics and puts disclosure state on native buttons', () => {
    const { body } = renderedRows();
    const rows = [...body.querySelectorAll<HTMLElement>('tr.cdp-sector-row')];
    const buttons = [...body.querySelectorAll<HTMLButtonElement>('button.cdp-sector-toggle')];

    expect(rows).toHaveLength(2);
    expect(buttons).toHaveLength(2);
    for (const row of rows) {
      expect(row.hasAttribute('tabindex')).toBe(false);
      expect(row.hasAttribute('aria-expanded')).toBe(false);
      expect(row.hasAttribute('role')).toBe(false);
    }
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-controls')).toBe(`cdp-sector-detail-${button.dataset.hs2}`);
    }
  });

  it('expands and collapses through the real handler while preserving focus', () => {
    const { body } = renderedRows();
    const button = body.querySelector<HTMLButtonElement>('button.cdp-sector-toggle[data-hs2="27"]')!;

    button.focus();
    button.click();

    const expanded = body.querySelector<HTMLButtonElement>('button.cdp-sector-toggle[data-hs2="27"]')!;
    const detailId = expanded.getAttribute('aria-controls')!;
    const detail = body.querySelector<HTMLElement>(`#${detailId}`);
    expect(expanded.getAttribute('aria-expanded')).toBe('true');
    expect(detail?.classList.contains('cdp-sector-detail-row')).toBe(true);
    expect(detail?.textContent).toContain('No maritime route data');
    expect(document.activeElement).toBe(expanded);

    expanded.click();

    const collapsed = body.querySelector<HTMLButtonElement>('button.cdp-sector-toggle[data-hs2="27"]')!;
    expect(collapsed.getAttribute('aria-expanded')).toBe('false');
    expect(body.querySelector(`#${detailId}`)).toBeNull();
    expect(document.activeElement).toBe(collapsed);
  });
});
