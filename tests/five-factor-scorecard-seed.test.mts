import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildFiveFactorSnapshot,
  FIVE_FACTOR_SCORECARD_MAX_BYTES,
  scorecardSnapshotBytes,
  validateFiveFactorSnapshot,
} from '../server/worldmonitor/scorecard/v1/_snapshot';
import { runSeed } from '../scripts/_seed-utils.mjs';

const sources = {
  population: { countries: { AA: { populationMillions: 10, year: 2024 } } },
  foodStocks: {
    AA: { commodities: { wheat: { marketingYear: '2024/25', production: 120, consumption: 100, exports: 0, endingStocks: 20 } } },
  },
  demographics: null,
  defense: null,
  energyMix: { AA: { year: 2024, primaryEnergyConsumptionTwh: 100, importShare: 0 } },
  staticByCountry: { AA: {} },
  lowCarbon: { countries: { AA: { value: 50, year: 2024 } } },
  powerLosses: { countries: { AA: { value: 5, year: 2024 } } },
  importHhi: null,
  techByIso2: null,
};

describe('five-factor atomic snapshot', () => {
  it('keeps evidence and its reproducible result in one bounded value', () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    assert.equal(validateFiveFactorSnapshot(snapshot, { minimumCountries: 1 }), true);
    assert.ok(scorecardSnapshotBytes(snapshot) < FIVE_FACTOR_SCORECARD_MAX_BYTES);
    assert.equal(snapshot.countries.AA?.result.pillars.energy.hasScore, true);
    assert.equal(snapshot.sourceStates['demographics:capability:v1']?.status, 'unavailable');
  });

  it('rejects a result that no longer matches its adjacent evidence', () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    snapshot.countries.AA!.result.pillars.energy.subScore = 99;
    assert.equal(validateFiveFactorSnapshot(snapshot, { minimumCountries: 1 }), false);
  });

  it('uses runSeed as the only canonical publisher so a failed attempt preserves last-good', () => {
    const source = readFileSync(new URL('../scripts/seed-five-factor-scorecard.mjs', import.meta.url), 'utf8');
    assert.match(source, /runSeed\('scorecard', 'five-factor', FIVE_FACTOR_SCORECARD_KEY/);
    assert.doesNotMatch(source, /\['SET',\s*FIVE_FACTOR_SCORECARD_KEY/);
    assert.match(source, /emptyDataIsFailure:\s*true/);
    assert.match(source, /validateFn:\s*validateFiveFactorSnapshot/);
  });

  it('executes the scorecard validation-failure path without replacing the canonical last-good value', async () => {
    const originalFetch = globalThis.fetch;
    const originalExit = process.exit;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const originalSigterm = new Set(process.rawListeners('SIGTERM'));
    const calls: Array<{ url: string; body: unknown }> = [];
    class ExitCalled extends Error {
      constructor(readonly exitCode: number) { super(`exit(${exitCode})`); }
    }
    try {
      process.env.UPSTASH_REDIS_REST_URL = 'https://scorecard-test-upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      globalThis.fetch = async (input, init = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: String(input), body });
        if (Array.isArray(body) && Array.isArray(body[0])) {
          return new Response(JSON.stringify(body.map(() => ({ result: 1 }))), { status: 200 });
        }
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      };
      process.exit = ((code?: number) => { throw new ExitCalled(code ?? 0); }) as never;

      let exitCode: number | null = null;
      try {
        await runSeed('scorecard', 'five-factor', 'scorecard:five-factor:v1', async () => {
          const invalidSnapshot = buildFiveFactorSnapshot(
            ['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ'],
            sources,
            '2026-08-29T00:00:00.000Z',
          );
          invalidSnapshot.countries.AA!.result.pillars.energy.subScore = 99;
          return invalidSnapshot;
        }, {
          validateFn: validateFiveFactorSnapshot,
          ttlSeconds: 3 * 24 * 3600,
          declareRecords: (snapshot: { countries?: Record<string, unknown> }) => Object.keys(snapshot.countries ?? {}).length,
          sourceVersion: 'five-factor-scorecard-1.0.0',
          schemaVersion: 1,
          maxStaleMin: 36 * 60,
          emptyDataIsFailure: true,
        });
      } catch (error) {
        if (!(error instanceof ExitCalled)) throw error;
        exitCode = error.exitCode;
      }

      assert.equal(exitCode, 1);
      const commands = calls.map((call) => call.body);
      assert.equal(commands.some((body) => Array.isArray(body) && body[0] === 'SET' && body[1] === 'scorecard:five-factor:v1'), false);
      assert.equal(commands.some((body) => Array.isArray(body) && body[0] === 'SET' && body[1] === 'seed-meta:scorecard:five-factor'), false);
      assert.equal(commands.some((body) => Array.isArray(body)
        && Array.isArray(body[0])
        && body.some((command) => Array.isArray(command) && command[0] === 'EXPIRE' && command[1] === 'scorecard:five-factor:v1')), true);
    } finally {
      globalThis.fetch = originalFetch;
      process.exit = originalExit;
      if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      for (const listener of process.rawListeners('SIGTERM')) {
        if (!originalSigterm.has(listener)) process.removeListener('SIGTERM', listener);
      }
    }
  });
});
