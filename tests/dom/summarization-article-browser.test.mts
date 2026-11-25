import { expect, it, vi } from 'vitest';

const { summarize } = vi.hoisted(() => ({ summarize: vi.fn() }));
vi.mock('@/services/ml-worker', () => ({
  mlWorker: { isAvailable: true, isModelLoaded: () => false, loadModel: vi.fn(async () => {}), summarize },
}));
vi.mock('@/config/beta', () => ({ BETA_MODE: false }));
vi.mock('@/services/analytics', () => ({ trackLLMUsage: vi.fn(), trackLLMFailure: vi.fn() }));
vi.mock('@/services/i18n', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
import { generateSummary } from '@/services/summarization';

const story = ['Artist shares 5 things he sees differently after 50'];
const options = { mode: 'article' as const, bodies: ['A painter reflects on patience and curiosity.'], skipCloudProviders: true };

it('rejects browser-model commentary about the headline in article mode', async () => {
  summarize.mockResolvedValueOnce(['The most important headline is about an artist reflecting on aging.']);
  expect(await generateSummary(story, undefined, undefined, 'en', options)).toBeNull();
  expect(summarize.mock.calls[0]?.[0]?.[0]).toMatch(/^Summarize this article/);
  summarize.mockResolvedValueOnce(["Cet article parle d'un peintre qui réfléchit au vieillissement."]);
  expect(await generateSummary(story, undefined, undefined, 'fr', options)).toBeNull();
});

it('keeps a browser-model summary of the article itself', async () => {
  summarize.mockResolvedValueOnce(['A painter says turning 50 taught him patience and curiosity.']);
  expect(await generateSummary(story, undefined, undefined, 'en', options)).toMatchObject({
    summary: 'A painter says turning 50 taught him patience and curiosity.',
    provider: 'browser',
  });
});
