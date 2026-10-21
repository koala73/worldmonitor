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

// #6677: this file's single test pays for the story-data module graph's
// transform (the generated IntelligenceServiceClient alone is ~1.9k lines)
// inside its testTimeout, which under load lands just over the 5000ms vitest
// default — a false red on a green tree. Importing the graph once at module
// scope moves the transform cost into the file's import phase, which vitest
// does not bill to any testTimeout. The vi.resetModules() in beforeEach still
// re-executes the module against this test's localStorage afterwards.
await import('../../src/services/story-data.ts');

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
