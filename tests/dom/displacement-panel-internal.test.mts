/**
 * UNHCR Displacement panel, Internal (IOM DTM) tab (#9014).
 *
 * The DTM tab must not depend on UNHCR: the two sources load independently, so
 * a UNHCR outage would otherwise hide DTM data the panel already holds. A row
 * with no placed region must not move the map to (0, 0).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { toInternalDisplacementData } from '@/services/displacement/internal';
import type { GetInternalDisplacementResponse } from '@/generated/client/worldmonitor/displacement/v1/service_client';

import { initTestI18n, tt } from './helpers/i18n.mts';

const { DisplacementPanel } = await import('@/components/DisplacementPanel');

const RESPONSE: GetInternalDisplacementResponse = {
  operations: [
    {
      countryCode: 'SDN', countryName: 'Sudan', operation: 'Armed Clashes in Sudan (Overview)', reportingDate: '2026-07-31', roundNumber: 38, totalIdps: 8622801,
      reasons: [{ reason: 'Conflict', idps: 8622801 }],
      regions: [{ pcode: 'SD11', name: 'Kassala', idps: 13596, location: { latitude: 15.66, longitude: 35.87 } }],
      flows: [],
    },
    {
      countryCode: 'BDI', countryName: 'Burundi', operation: 'Burundi Complex Emergency', reportingDate: '2025-07-31', roundNumber: 78, totalIdps: 89114,
      reasons: [],
      regions: [{ pcode: 'BI005', name: 'Cibitoke', idps: 24417 }],
      flows: [],
    },
  ],
  fetchedAt: 1785542400000,
  dataAvailable: true,
};

let panel: InstanceType<typeof DisplacementPanel>;

// Panel.setSafeContent commits on a 150 ms debounce.
const CONTENT_DEBOUNCE_MS = 150;
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 1);
}

function mount(): void {
  panel = new DisplacementPanel();
  document.body.appendChild(panel.getElement());
}

const rows = (): HTMLElement[] => Array.from(panel.getElement().querySelectorAll('.disp-row'));

beforeAll(async () => {
  await initTestI18n();
  expect(tt('components.displacement.internal')).toBe('Internal');
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
});

afterEach(() => {
  panel?.destroy();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('Internal tab', () => {
  it('shows DTM operations when UNHCR data never arrived', async () => {
    mount();
    panel.setInternalData(toInternalDisplacementData(RESPONSE));
    await flush();
    const tab = panel.getElement().querySelector<HTMLElement>('[data-tab="internal"]');
    expect(tab?.classList.contains('active')).toBe(true);
    expect(rows().map((row) => row.querySelector('.disp-name')?.firstChild?.textContent)).toEqual(['Sudan', 'Burundi']);
  });

  it('focuses the map on a placed operation and ignores an unplaced one', async () => {
    mount();
    const onClick = vi.fn();
    panel.setCountryClickHandler(onClick);
    panel.setInternalData(toInternalDisplacementData(RESPONSE));
    await flush();
    const [sudan, burundi] = rows();
    burundi!.click();
    expect(onClick).not.toHaveBeenCalled();
    sudan!.click();
    expect(onClick).toHaveBeenCalledWith(15.66, 35.87);
  });
});
