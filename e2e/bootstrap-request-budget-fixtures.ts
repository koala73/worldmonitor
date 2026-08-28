import { expect, type Page } from '@playwright/test';

// Shared bootstrap request-budget fixtures. Two specs assert against the same
// startup surface — the energy on-demand budget (#7046) and the hydration reuse
// budget (#7045 U5) — and they must agree on what a valid registry payload and
// a completed startup look like. They live in separate spec FILES so the heavy
// deck.gl map-harness assertion in the first one keeps its own worker and its
// own timing budget.

export const ENERGY_KEYS = ['pipelinesGas', 'pipelinesOil', 'storageFacilities'] as const;

const PIPELINE_EVIDENCE = {
  physicalState: 'flowing',
  physicalStateSource: 'operator',
  commercialState: 'active',
  sanctionRefs: [],
  lastEvidenceUpdate: '2026-08-20T12:00:00Z',
  classifierVersion: 'v2',
  classifierConfidence: 0.98,
};

export const ENERGY_BOOTSTRAP_DATA: Record<(typeof ENERGY_KEYS)[number], unknown> = {
  pipelinesGas: {
    pipelines: {
      'browser-gas': {
        id: 'browser-gas',
        name: 'Browser Gas Link',
        operator: 'Gas Operator',
        commodityType: 'gas',
        fromCountry: 'NO',
        toCountry: 'DE',
        capacityBcmYr: 55,
        startPoint: { lat: 58, lon: 6 },
        endPoint: { lat: 53, lon: 8 },
        evidence: PIPELINE_EVIDENCE,
      },
    },
    classifierVersion: 'v2',
    updatedAt: '2026-08-20T12:00:00Z',
  },
  pipelinesOil: {
    pipelines: {
      'browser-oil': {
        id: 'browser-oil',
        name: 'Browser Oil Link',
        operator: 'Oil Operator',
        commodityType: 'oil',
        fromCountry: 'PL',
        toCountry: 'DE',
        capacityMbd: 1.4,
        startPoint: { lat: 52, lon: 19 },
        endPoint: { lat: 52, lon: 13 },
        evidence: PIPELINE_EVIDENCE,
      },
    },
    classifierVersion: 'v2',
    updatedAt: '2026-08-20T12:00:00Z',
  },
  storageFacilities: {
    facilities: {
      'browser-storage': {
        id: 'browser-storage',
        name: 'Browser Storage Hub',
        operator: 'Storage Operator',
        facilityType: 'ugs',
        country: 'DE',
        location: { lat: 52.6, lon: 8.4 },
        capacityTwh: 42.5,
        evidence: {
          physicalState: 'operational',
          physicalStateSource: 'operator',
          commercialState: 'active',
          sanctionRefs: [],
          fillDisclosed: true,
          fillSource: 'operator',
          lastEvidenceUpdate: '2026-08-20T12:00:00Z',
          classifierVersion: 'v2',
          classifierConfidence: 0.98,
        },
      },
    },
    classifierVersion: 'v2',
    updatedAt: '2026-08-20T12:00:00Z',
  },
};

/** Logical bootstrap keys behind a `?keys=a,b&public=1` per-key request. */
export function requestedKeys(url: string): string[] {
  const parsed = new URL(url);
  const keys = parsed.searchParams.get('keys');
  return keys ? keys.split(',').filter(Boolean) : [];
}

type AnonymousDashboardSeedOptions = {
  /** Values written on every document before the app starts. */
  localStorage?: Record<string, string>;
  /**
   * One-time initialization guarded by a session-storage sentinel. The clear,
   * configured writes, and sentinel update run in that order inside the same
   * init script, so callers never depend on Playwright's ordering across
   * separate addInitScript registrations.
   */
  initializeOnce?: {
    sessionKey: string;
    clearStorage?: boolean;
    localStorage?: Record<string, string>;
  };
};

export async function seedAnonymousDashboard(
  page: Page,
  variant: 'full' | 'happy' | 'energy',
  options: AnonymousDashboardSeedOptions = {},
): Promise<void> {
  await page.addInitScript(({ selectedVariant, seedOptions }) => {
    const initializeOnce = seedOptions.initializeOnce;
    const shouldInitialize = !initializeOnce
      || !sessionStorage.getItem(initializeOnce.sessionKey);

    if (shouldInitialize && initializeOnce?.clearStorage) {
      localStorage.clear();
      sessionStorage.clear();
    }

    // Keep the anonymous variant and dismissal policy shared by every request-
    // budget spec. These values are restored on each document, matching the
    // original helper behavior across reloads.
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('worldmonitor-variant', selectedVariant);

    if (shouldInitialize && initializeOnce) {
      for (const [key, value] of Object.entries(initializeOnce.localStorage ?? {})) {
        localStorage.setItem(key, value);
      }
    }
    for (const [key, value] of Object.entries(seedOptions.localStorage ?? {})) {
      localStorage.setItem(key, value);
    }

    if (shouldInitialize && initializeOnce) {
      sessionStorage.setItem(initializeOnce.sessionKey, '1');
    }
  }, { selectedVariant: variant, seedOptions: options });
}

export async function waitForStartup(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', {
    timeout: 45_000,
  });
  await expect(page.locator('html')).toHaveAttribute('data-wm-initial-data-ready', 'true', {
    timeout: 45_000,
  });
}
