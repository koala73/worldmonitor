import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchGdeltDocuments = vi.hoisted(() => vi.fn(async (req: { query: string }) => ({
  articles: [],
  query: req.query,
  error: '',
})));

vi.mock('@/services/generated-rpc-clients', () => ({
  IntelligenceServiceClient: class {
    searchGdeltDocuments = searchGdeltDocuments;
  },
}));

import { fetchGdeltArticles, fetchTopicIntelligence, hotspotSeededTopicId, INTEL_TOPICS, POSITIVE_GDELT_TOPICS, fetchPositiveTopicIntelligence } from '@/services/gdelt-intel';

describe('GDELT seeded topic queries', () => {
  beforeEach(() => {
    searchGdeltDocuments.mockClear();
  });

  it('asks the handler for the topic id, including maritime', async () => {
    const maritime = INTEL_TOPICS.find((topic) => topic.id === 'maritime');
    expect(maritime?.query.includes('maritime')).toBe(false);

    await fetchTopicIntelligence(maritime!);

    expect(searchGdeltDocuments).toHaveBeenCalledWith(expect.objectContaining({ query: 'maritime' }));
  });

  it('does not let one topic\'s empty response satisfy another topic', async () => {
    await fetchGdeltArticles('military');
    await fetchGdeltArticles('cyber');

    expect(searchGdeltDocuments.mock.calls.map((call) => call[0]?.query)).toEqual(['military', 'cyber']);
  });

  it('maps hotspot keywords onto a seeded topic instead of a DOC query', () => {
    expect(hotspotSeededTopicId({ keywords: ['piracy', 'bab el-mandeb'] })).toBe('maritime');
    expect(hotspotSeededTopicId({ keywords: ['ransomware', 'grid'] })).toBe('cyber');
    expect(hotspotSeededTopicId({ keywords: ['sahel', 'junta', 'coup'] })).toBe('military');
  });

  it('sends positive topic ids rather than the legacy DOC query', async () => {
    const topic = POSITIVE_GDELT_TOPICS[0]!;
    expect(topic.query.includes(topic.id)).toBe(false);

    await fetchPositiveTopicIntelligence(topic);

    expect(searchGdeltDocuments).toHaveBeenCalledWith(expect.objectContaining({ query: topic.id }));
  });
});
