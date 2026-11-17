// Which route the browser asks for headline history, and with which fetch.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ method: string; fetch: string; request: unknown }> = [];
let archiveError: unknown = null;
let archiveState = 'complete';

vi.mock('@/services/premium-fetch', () => ({ premiumFetch: function premiumFetch() {} }));
vi.mock('@/services/rpc-client', () => ({ getRpcBaseUrl: () => '' }));
vi.mock('@/services/generated-rpc-clients', () => ({
  NewsServiceClient: class {
    private readonly fetchName: string;
    constructor(_base: string, options: { fetch: { name: string } }) {
      this.fetchName = options.fetch.name === 'premiumFetch' ? 'premiumFetch' : 'plain';
    }
    async searchHeadlines(request: unknown) {
      calls.push({ method: 'searchHeadlines', fetch: this.fetchName, request });
      return { state: 'complete', headlines: [{ title: 'From the 24-hour route', source: 'Reuters World', link: 'https://www.reuters.com/a', publishedAt: 1, lastServedAt: 2 }] };
    }
    async searchHeadlineArchive(request: unknown) {
      calls.push({ method: 'searchHeadlineArchive', fetch: this.fetchName, request });
      if (archiveError) throw archiveError;
      return { state: archiveState, headlines: [{ title: 'From the 7-day route', source: 'Reuters World', link: 'https://www.reuters.com/b', publishedAt: 1, lastServedAt: 2 }] };
    }
  },
}));

import { searchHeadlineHistory } from '@/services/headline-history';

const query = { variant: 'full', lang: 'en' };

beforeEach(() => {
  calls.length = 0;
  archiveError = null;
  archiveState = 'complete';
});

describe('headline history route choice', () => {
  it('asks the 24-hour route with the plain fetch for a free or signed-out user', async () => {
    const headlines = await searchHeadlineHistory('hormuz', { ...query, premium: false });
    expect(headlines.map((item) => item.title)).toEqual(['From the 24-hour route']);
    expect(calls).toEqual([{ method: 'searchHeadlines', fetch: 'plain', request: { query: 'hormuz', variant: 'full', lang: 'en' } }]);
  });

  it('asks the 7-day route through premiumFetch for a Pro user', async () => {
    const headlines = await searchHeadlineHistory('hormuz', { ...query, premium: true });
    expect(headlines.map((item) => item.title)).toEqual(['From the 7-day route']);
    expect(calls.map((call) => `${call.method}:${call.fetch}`)).toEqual(['searchHeadlineArchive:premiumFetch']);
  });

  it.each([401, 403])('falls back to the 24-hour route when the server answers a Pro user with %i', async (statusCode) => {
    archiveError = Object.assign(new Error('denied'), { statusCode });
    const headlines = await searchHeadlineHistory('hormuz', { ...query, premium: true });
    expect(headlines.map((item) => item.title)).toEqual(['From the 24-hour route']);
    expect(calls.map((call) => call.method)).toEqual(['searchHeadlineArchive', 'searchHeadlines']);
  });

  it('reports a failed 7-day search as a failure, not as a 24-hour answer', async () => {
    archiveError = Object.assign(new Error('boom'), { statusCode: 503 });
    await expect(searchHeadlineHistory('hormuz', { ...query, premium: true })).rejects.toThrow('boom');
    expect(calls.map((call) => call.method)).toEqual(['searchHeadlineArchive']);
  });

  it('reports a search the server could not run as a failure, so it is not remembered as no results', async () => {
    archiveState = 'unavailable';
    await expect(searchHeadlineHistory('hormuz', { ...query, premium: true })).rejects.toThrow('unavailable');
  });
});
