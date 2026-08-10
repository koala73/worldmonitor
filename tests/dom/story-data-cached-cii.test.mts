import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const storedValues = new Map<string, string>();
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  vi.resetModules();
  storedValues.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storedValues.get(key) ?? null,
      setItem: (key: string, value: string) => storedValues.set(key, value),
      removeItem: (key: string) => storedValues.delete(key),
      clear: () => storedValues.clear(),
    },
  });
});

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

it('selects the canonical cached score for a normalized country code', async () => {
  localStorage.setItem('wm:risk-scores', JSON.stringify({
    savedAt: Date.now(),
    data: {
      cii: [{
        code: 'IR',
        name: 'Iran',
        score: 72,
        level: 'high',
        trend: 'rising',
        change24h: 4,
        components: { unrest: 20, conflict: 30, security: 40, information: 10 },
        lastUpdated: null,
      }],
      strategicRisk: {
        score: 72,
        level: 'high',
        trend: 'rising',
        lastUpdated: null,
        contributors: [{ country: 'Iran', code: 'IR', score: 72, level: 'high' }],
      },
      protestCount: 0,
      computedAt: null,
      cached: true,
      degraded: false,
      stale: false,
    },
  }));

  const { collectStoryData } = await import('../../src/services/story-data.ts');
  const story = collectStoryData('ir', 'Iran', [], [], []);

  expect(story.countryCode).toBe('IR');
  expect(story.cii).toEqual({
    score: 72,
    level: 'high',
    trend: 'rising',
    components: { unrest: 20, conflict: 30, security: 40, information: 10 },
    change24h: 4,
  });
});
