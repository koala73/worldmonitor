import { expect, it, vi } from 'vitest';

const { summarize } = vi.hoisted(() => ({ summarize: vi.fn() }));
vi.mock('@/services/ml-worker', () => ({
  mlWorker: { isAvailable: true, isModelLoaded: () => false, loadModel: vi.fn(async () => {}), summarize },
}));
vi.mock('@/config/beta', () => ({ BETA_MODE: false }));
vi.mock('@/services/analytics', () => ({ trackLLMUsage: vi.fn(), trackLLMFailure: vi.fn() }));
vi.mock('@/services/i18n', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
vi.mock('@/services/runtime-config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/runtime-config')>(),
  isFeatureAvailable: (feature: string) => feature === 'aiOpenRouter',
}));
// Translation is Pro and goes through the credentialed client; route it to the
// stubbed fetch so the circuit-recovery test counts every provider request.
vi.mock('@/services/panel-gating', () => ({ hasPremiumAccess: () => true }));
vi.mock('@/services/premium-fetch', () => ({
  premiumFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

import { generateSummary, translateText } from '@/services/summarization';

const story = ['Artist shares 5 things he sees differently after 50'];
const options = { mode: 'article' as const, bodies: ['A painter reflects on patience and curiosity.'], skipCloudProviders: true };

it('rejects browser-model commentary about the headline in article mode', async () => {
  summarize.mockResolvedValueOnce(['The most important headline is about an artist reflecting on aging.']);
  expect(await generateSummary(story, undefined, undefined, 'en', options)).toBeNull();
  expect(summarize.mock.calls[0]?.[0]?.[0]).toMatch(/^Summarize this article/);
  summarize.mockResolvedValueOnce(["Cet article parle d'un peintre qui réfléchit au vieillissement."]);
  expect(await generateSummary(story, undefined, undefined, 'fr', options)).toBeNull();
  for (const commentary of ["Let me explain the painter's reflections on aging.", 'The title describes an artist reflecting on aging.']) {
    summarize.mockResolvedValueOnce([commentary]);
    expect(await generateSummary(story, undefined, undefined, 'en', options)).toBeNull();
  }
});

it('keeps a browser-model summary of the article itself', async () => {
  summarize.mockResolvedValueOnce(['A painter says turning 50 taught him patience and curiosity.']);
  expect(await generateSummary(story, undefined, undefined, 'en', options)).toMatchObject({
    summary: 'A painter says turning 50 taught him patience and curiosity.',
    provider: 'browser',
  });
});


it('keeps concurrent translations distinct during circuit recovery', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { headlines: [text] } = JSON.parse(String(init?.body));
    return Response.json({ summary: `[de] ${text}` });
  });
  fetch.mockRejectedValueOnce(new Error('Provider offline')).mockRejectedValueOnce(new Error('Provider offline'));
  vi.stubGlobal('fetch', fetch);
  try {
    expect(await translateText('first failure', 'de')).toBeNull();
    expect(await translateText('second failure', 'de')).toBeNull();
    expect(await translateText('cooldown', 'de')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 5 * 60_000);
    await expect(Promise.all([translateText('headline', 'de'), translateText('summary', 'de')]))
      .resolves.toEqual(['[de] headline', '[de] summary']);
    expect(fetch).toHaveBeenCalledTimes(4);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
