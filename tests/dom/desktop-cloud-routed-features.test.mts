// Desktop gated these features on local API keys, but the sidecar sends their
// routes to the cloud seed cache, where no local key is read. A desktop
// without a Cloudflare token lost the Internet Outages layer moments after
// launch (#5829); FRED, EIA, WTO and shipping-rate panels stayed empty the same way.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/runtime')>(),
  isDesktopRuntime: () => true,
}));

// tests/desktop-cloud-routed-features.test.mts pins that each one's routes are
// cloud-routed by the sidecar and served to the sidecar's anonymous session.
const CLOUD_ROUTED = ['economicFred', 'internetOutages', 'energyEia', 'wtoTrade', 'supplyChain'] as const;

describe('desktop features served from the cloud seed cache', () => {
  it('are available without a local key', async () => {
    const { isFeatureAvailable } = await import('@/services/runtime-config');
    for (const feature of CLOUD_ROUTED) expect(isFeatureAvailable(feature), feature).toBe(true);
  });

  it('keep the key gate where the key is still needed', async () => {
    const { isFeatureAvailable } = await import('@/services/runtime-config');
    // Wingbits runs locally and calls the vendor with the user's key.
    expect(isFeatureAvailable('wingbitsEnrichment')).toBe(false);
  });
});
