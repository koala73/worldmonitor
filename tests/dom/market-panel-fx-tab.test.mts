/**
 * CommoditiesPanel "EUR FX" tab — the zero-change rendering (#6199).
 *
 * This tab and the FX panel render the SAME seeded field
 * (`economic:ecb-fx-rates:v1` `change1d`), so they must not disagree about it.
 * `scripts/seed-ecb-fx-rates.mjs` writes 0 both when the rate did not move and
 * when there is no prior observation, so painting 0 green claims a gain that
 * may not even be a measurement.
 *
 * Guarding the parity here rather than only in the FX panel is deliberate: this
 * is the surface that already shipped, and hardening one half of a pair while
 * leaving the other is how the two drift apart.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { CommoditiesPanel } = await import('@/components/MarketPanel');

const CONTENT_DEBOUNCE_MS = 150;

let panel: InstanceType<typeof CommoditiesPanel>;

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 1);
}

async function mountWithFx(rates: Array<{ currency: string; rate: number; change1d: number | null }>): Promise<void> {
  panel = new CommoditiesPanel();
  document.body.appendChild(panel.getElement());
  panel.updateFxRates(rates);
  await flush();
  // The panel opens on its commodities tab; the FX rows only render once the
  // EUR FX tab is selected.
  const fxTab = panel.getElement().querySelector('.panel-tab[data-tab="fx"]') as HTMLElement | null;
  if (!fxTab) {
    const seen = Array.from(panel.getElement().querySelectorAll('.panel-tab'))
      .map((el) => (el as HTMLElement).dataset.tab).join(', ');
    throw new Error(`no EUR FX tab rendered; tabs present: [${seen}]`);
  }
  fxTab.click();
  await flush();
}

function fxCell(currency: string): Element | null | undefined {
  return Array.from(panel.getElement().querySelectorAll('.commodity-item'))
    .find((el) => el.textContent?.includes(`EUR/${currency}`))
    ?.querySelector('.commodity-change');
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('CommoditiesPanel EUR FX tab', () => {
  it('renders a zero day change unsigned and without a gain colour', async () => {
    await mountWithFx([{ currency: 'GBP', rate: 0.861, change1d: 0 }]);
    const cell = fxCell('GBP');
    expect(cell?.textContent).toContain('0.0000');
    expect(cell?.textContent).not.toContain('+0.0000');
    expect(cell?.classList.contains('change-positive')).toBe(false);
    expect(cell?.classList.contains('change-negative')).toBe(false);
  });

  it('still signs and colours a real move', async () => {
    // The neutral-zero change must not flatten genuine movement.
    await mountWithFx([
      { currency: 'JPY', rate: 171.2, change1d: 0.85 },
      { currency: 'USD', rate: 1.148, change1d: -0.02 },
    ]);
    expect(fxCell('JPY')?.textContent).toContain('+0.8500');
    expect(fxCell('JPY')?.classList.contains('change-positive')).toBe(true);
    expect(fxCell('USD')?.textContent).toContain('-0.0200');
    expect(fxCell('USD')?.classList.contains('change-negative')).toBe(true);
  });

  it('renders the change as an absolute delta, never a percentage', async () => {
    // Same contract the FX panel asserts: change1d is `rate - prev.value`.
    await mountWithFx([{ currency: 'JPY', rate: 171.2, change1d: 0.85 }]);
    expect(fxCell('JPY')?.textContent).not.toContain('%');
  });
});
