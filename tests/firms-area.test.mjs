import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  hasCompleteWorldwideWildfireCoverage,
  mergeWildfireSourcesWithBc,
} from '../scripts/wildfire/bc-fire-points.mjs';

import {
  fetchAllFirmsRegions,
  fetchFirmsRegionSource,
  FIRMS_API_BASE_URLS,
  FIRMS_SOURCES,
  MONITORED_REGIONS,
} from '../scripts/wildfire/firms-area.mjs';

const EMPTY_CSV = 'latitude,longitude,acq_date,acq_time,bright_ti4,frp,confidence,satellite,daynight\n';
const DETECTION_CSV = `${EMPTY_CSV}34.1,36.2,2026-09-04,0425,391.2,91.5,h,N,D\n`;

function response(status, body = EMPTY_CSV) {
  return new Response(body, { status });
}

function captureLogger() {
  const messages = { log: [], warn: [], error: [] };
  return {
    messages,
    logger: {
      log: (message) => messages.log.push(message),
      warn: (message) => messages.warn.push(message),
      error: (message) => messages.error.push(message),
    },
  };
}

describe('NASA FIRMS Area API sequence', () => {
  it('recovers complete coverage after a primary transport error and secondary MAP_KEY rejection', async () => {
    const urls = [];
    const sleeps = [];
    const { logger, messages } = captureLogger();
    const failedPath = `/${FIRMS_SOURCES[0]}/${MONITORED_REGIONS.Ukraine}/`;
    let affectedAttempts = 0;
    const firms = await fetchAllFirmsRegions('test-map-key', {
      fetchFn: async (url) => {
        urls.push(url);
        if (new URL(url).pathname.includes(failedPath)) {
          affectedAttempts++;
          if (affectedAttempts === 1) throw new TypeError('fetch failed');
          if (affectedAttempts === 2) return response(400, 'Invalid MAP_KEY.');
          return response(200, DETECTION_CSV);
        }
        return response(200);
      },
      sleepFn: async (ms) => sleeps.push(ms),
      logger,
    });
    const merged = await mergeWildfireSourcesWithBc({
      fetchFirms: async () => firms,
      fetchCwfis: async () => ({ fireDetections: [] }),
      fetchBcWildfire: async () => ({ fireDetections: [] }),
    });
    assert.equal(hasCompleteWorldwideWildfireCoverage(merged), true);
    assert.equal(firms._firmsFulfilledCalls, 27);
    assert.equal(firms._firmsFailedCalls, 0);
    assert.equal(firms.fireDetections.length, 1);
    assert.deepEqual(urls.slice(0, 3).map((url) => new URL(url).origin), [
      ...FIRMS_API_BASE_URLS, FIRMS_API_BASE_URLS[0],
    ]);
    assert.equal(new Set(urls.slice(0, 3).map((url) => new URL(url).pathname)).size, 1);
    assert.equal(urls.length, 29);
    assert.equal(sleeps.length, 29);
    assert.ok(sleeps.every((ms) => ms === 6_000));
    assert.equal(messages.error.length, 0);
    assert.doesNotMatch(messages.warn.join('\n'), /test-map-key/);
  });

  it('bounds an exhausted run below the seed lock with publication headroom', async (t) => {
    let attempts = 0;
    let budgetMs = 0;
    t.mock.method(AbortSignal, 'timeout', (ms) => {
      budgetMs += ms;
      return new AbortController().signal;
    });
    const { logger } = captureLogger();
    const firms = await fetchAllFirmsRegions('test-map-key', {
      fetchFn: async () => {
        attempts++;
        throw new DOMException('timed out', 'TimeoutError');
      },
      sleepFn: async (ms) => { budgetMs += ms; },
      logger,
    });
    assert.equal(attempts, 81);
    assert.equal(firms._firmsFulfilledCalls, 0);
    assert.equal(firms._firmsFailedCalls, 27);
    const source = readFileSync(new URL('../scripts/seed-fire-detections.mjs', import.meta.url), 'utf8');
    const lockMs = Number(source.match(/lockTtlMs:\s*([\d_]+)/)[1].replaceAll('_', ''));
    const deadlineMatch = source.match(/fetchPhaseTimeoutMs:\s*([\d_]+)/);
    assert.ok(deadlineMatch, 'bound outer all-source retries before the seed lock expires');
    const deadlineMs = Number(deadlineMatch[1].replaceAll('_', ''));
    assert.ok(deadlineMs >= budgetMs + 5 * 60_000, `${deadlineMs} must cover ${budgetMs} plus fetch headroom`);
    assert.ok(lockMs >= deadlineMs + 5 * 60_000, 'leave publication and cleanup headroom inside the lock');
  });
  it('tries the official secondary host after a primary HTTP failure', async () => {
    const urls = [];
    const sleeps = [];
    const { logger, messages } = captureLogger();
    const rows = await fetchFirmsRegionSource(
      'test-map-key',
      'Ukraine',
      MONITORED_REGIONS.Ukraine,
      FIRMS_SOURCES[0],
      {
        fetchFn: async (url) => {
          urls.push(url);
          return response(urls.length === 1 ? 500 : 200);
        },
        sleepFn: async (milliseconds) => sleeps.push(milliseconds),
        logger,
      },
    );

    assert.deepEqual(rows, []);
    assert.deepEqual(
      urls.map((url) => new URL(url).origin),
      FIRMS_API_BASE_URLS,
    );
    assert.equal(new URL(urls[0]).pathname, new URL(urls[1]).pathname);
    assert.deepEqual(sleeps, [6_000]);
    assert.match(messages.warn[0], /VIIRS_SNPP_NRT\/Ukraine: primary HTTP 500; trying secondary/);
    assert.doesNotMatch(messages.warn[0], /test-map-key/);
  });

  it('keeps the source-major 27-call worldwide sequence and six-second cadence', async () => {
    const urls = [];
    const sleeps = [];
    const { logger } = captureLogger();
    const result = await fetchAllFirmsRegions('test-map-key', {
      fetchFn: async (url) => {
        urls.push(url);
        return response(200, urls.length === 1 ? DETECTION_CSV : EMPTY_CSV);
      },
      sleepFn: async (milliseconds) => sleeps.push(milliseconds),
      logger,
    });

    assert.equal(result._firmsFulfilledCalls, 27);
    assert.equal(result._firmsFailedCalls, 0);
    assert.deepEqual(result.fireDetections, [{
      id: '34.1-36.2-2026-09-04-0425',
      location: { latitude: 34.1, longitude: 36.2 },
      brightness: 391.2,
      frp: 91.5,
      confidence: 'FIRE_CONFIDENCE_HIGH',
      satellite: 'N',
      detectedAt: Date.parse('2026-09-04T04:25:00Z'),
      region: 'Ukraine',
      dayNight: 'D',
      possibleExplosion: true,
      source: 'firms',
      kind: 'active',
      emergency: true,
    }]);
    assert.equal(urls.length, FIRMS_SOURCES.length * Object.keys(MONITORED_REGIONS).length);
    assert.equal(sleeps.length, 27);
    assert.ok(sleeps.every((milliseconds) => milliseconds === 6_000));
    const requestPaths = urls.map((url) => new URL(url).pathname);
    assert.deepEqual(
      requestPaths.slice(0, 9),
      Object.values(MONITORED_REGIONS).map(
        (bbox) => `/api/area/csv/test-map-key/${FIRMS_SOURCES[0]}/${bbox}/1`,
      ),
    );
    assert.match(requestPaths[9], new RegExp(`/${FIRMS_SOURCES[1]}/`));
    assert.match(requestPaths[18], new RegExp(`/${FIRMS_SOURCES[2]}/`));
  });

  it('keeps region and satellite diagnostics when both hosts fail', async () => {
    const urls = [];
    const { logger, messages } = captureLogger();
    const failedPath = `/${FIRMS_SOURCES[0]}/${MONITORED_REGIONS.Ukraine}/`;
    const result = await fetchAllFirmsRegions('test-map-key', {
      fetchFn: async (url) => {
        urls.push(url);
        return response(new URL(url).pathname.includes(failedPath) ? 500 : 200);
      },
      sleepFn: async () => {},
      logger,
    });

    assert.equal(result._firmsFulfilledCalls, 26);
    assert.equal(result._firmsFailedCalls, 1);
    assert.equal(urls.length, 29);
    assert.match(
      messages.error[0],
      /VIIRS_SNPP_NRT\/Ukraine failed \(primary HTTP 500, secondary HTTP 500, primary retry HTTP 500\)/,
    );
    assert.doesNotMatch(messages.error[0], /test-map-key/);
  });
});
