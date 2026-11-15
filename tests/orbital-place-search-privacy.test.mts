import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseTypedCoordinates, searchPlaces } from '../src/services/orbital/place-search.ts';
import { buildOrbitalShareFragment } from '../src/utils/urlState.ts';

/** DebugBear rum-1.1.2.js names a resource by host and path, keeping only the last segment of a long path. */
const reportedName = (url: string) => {
  const { hostname, pathname } = new URL(url);
  return hostname.slice(0, 25) + (pathname.length < 30 ? pathname : `/…/${pathname.split('/').pop()}`);
};
const coordinatesIn = (text: string) => text.match(/-?\d+\.\d{2,}/g) ?? [];

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function recordRequests(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(new URL(String(input instanceof Request ? input.url : input), 'https://www.worldmonitor.app').toString());
    return new Response(JSON.stringify({ places: [{ name: 'Palm Jumeirah, Dubai', lat: 25.112, lon: 55.139, kind: 'island' }] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return urls;
}

describe('place search keeps the point out of the request names a RUM collector reports', () => {
  it('sends a searched name only in the query of a fixed path', async () => {
    const urls = recordRequests();
    const outcome = await searchPlaces('Palm Jumeirah');
    assert.equal(outcome.kind, 'searched');
    assert.equal(urls.length, 1);
    assert.equal(new URL(urls[0]!).pathname, '/api/infrastructure/v1/search-place');
    assert.deepEqual(coordinatesIn(reportedName(urls[0]!)), [], reportedName(urls[0]!));
  });

  it('resolves typed coordinates without any request', async () => {
    const urls = recordRequests();
    const pasted = [
      '25.112, 55.139', '25.112N 55.139E', '(25.112, 55.139)', '[25.112 55.139]',
      `25°06'43"N 55°08'20"E`, '25° 6′ 43″ N, 55° 8′ 20″ E', '25°06’43”N 55°08’20”E', '25º06\'43"N 55º08\'20"E', `25°06'43''N 55°08'20''E`,
    ];
    for (const text of pasted) assert.equal((await searchPlaces(text)).kind, 'local', text);
    assert.deepEqual(urls, []);
  });

  it('reads degrees, minutes and seconds with their hemisphere', () => {
    const near = (text: string, lat: number, lon: number) => {
      const point = parseTypedCoordinates(text);
      assert.ok(point && point !== 'invalid', text);
      assert.ok(Math.abs(point.lat - lat) < 1e-6 && Math.abs(point.lon - lon) < 1e-6, `${text} -> ${JSON.stringify(point)}`);
    };
    near(`25°06'43"N 55°08'20"E`, 25 + 6 / 60 + 43 / 3600, 55 + 8 / 60 + 20 / 3600);
    near(`33°51'S 151°12'E`, -(33 + 51 / 60), 151 + 12 / 60);
    near(`40°26'46"N 79°58'56"W`, 40 + 26 / 60 + 46 / 3600, -(79 + 58 / 60 + 56 / 3600));
    near('(-0.5, -78.5)', -0.5, -78.5);
  });

  it('keeps unreadable coordinate attempts in the browser', async () => {
    const urls = recordRequests();
    for (const text of [`25°61'N 55°08'E`, `25°06'61"N 55°08'E`, '(25.112, 55.139, 3)', '25.112E 55.139N', `-25°06'N 55°E`, `25.5°06'N 55°E`]) {
      assert.equal((await searchPlaces(text)).kind, 'invalid-coordinates', text);
    }
    assert.deepEqual(urls, []);
  });

  it('carries a share link point only in the fragment', () => {
    const link = `https://www.worldmonitor.app/dashboard#${buildOrbitalShareFragment({ lat: 25.112, lon: 55.139 }, null, 'full')}`;
    assert.deepEqual(coordinatesIn(reportedName(link)), [], reportedName(link));
    assert.match(new URL(link).hash, /orbital=25\.11,55\.14/);
  });
});
