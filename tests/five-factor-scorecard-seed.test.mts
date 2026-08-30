import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildFiveFactorSnapshot,
  buildFiveFactorReadModel,
  FIVE_FACTOR_SCORECARD_MAX_BYTES,
  hasFiveFactorSnapshotShape,
  SCORECARD_SOURCE_KEYS,
  scorecardCoverage,
  scorecardSnapshotBytes,
  validateFiveFactorSnapshot,
} from '../server/worldmonitor/scorecard/v1/_snapshot';
import {
  __resetFiveFactorSnapshotCacheForTests,
  asFiveFactorSnapshot,
  readFiveFactorListProjection,
  readFiveFactorSnapshot,
} from '../server/worldmonitor/scorecard/v1/_read-snapshot';
import { runSeed } from '../scripts/_seed-utils.mjs';
import { listRankableCountries } from '../scripts/shared/rankable-universe.mjs';
import {
  declareScorecardRecords,
  publishScorecardCohortAtomically,
  readScorecardSources,
  redisPipeline,
  SCORECARD_ACTIVATION_KEY,
  SCORECARD_FINGERPRINT_KEY,
  scorecardPayloadFingerprint,
  stageScorecardReadModel,
} from '../scripts/seed-five-factor-scorecard.mjs';

const sources = {
  population: { countries: { AA: { populationMillions: 10, year: 2024 } } },
  foodStocks: {
    AA: { commodities: { wheat: { marketingYear: '2024/25', production: 120, consumption: 100, exports: 0, endingStocks: 20 } } },
  },
  demographics: null,
  defense: null,
  energyMix: { AA: { year: 2024, balanceYear: 2024, primaryEnergyConsumptionTwh: 100, balanceImportSharePercent: 0 } },
  staticByCountry: { AA: {} },
  lowCarbon: { countries: { AA: { value: 50, year: 2024 } } },
  powerLosses: { countries: { AA: { value: 5, year: 2024 } } },
  importHhi: null,
  techByIso2: null,
};

const syntheticIso2Codes = (count: number): string[] => Array.from({ length: count }, (_, index) =>
  `${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`);

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

  it('rejects every publication guard branch', () => {
    const valid = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    const cases: Array<[string, (snapshot: typeof valid) => void, Parameters<typeof validateFiveFactorSnapshot>[1]?]> = [
      ['schema version', (snapshot) => { snapshot.schemaVersion = 99 as never; }],
      ['methodology version', (snapshot) => { snapshot.methodologyVersion = '9.9.9' as never; }],
      ['input registry version', (snapshot) => { snapshot.inputRegistryVersion = '9.9.9' as never; }],
      ['timestamp', (snapshot) => { snapshot.computedAt = 'not-a-date'; }],
      ['country identity', (snapshot) => { snapshot.countries.AA!.evidence.countryCode = 'BB'; }],
      ['nested pillar shape', (snapshot) => { delete (snapshot.countries.AA!.result.pillars as Partial<typeof snapshot.countries.AA.result.pillars>).energy; }],
      ['undeclared evidence input', (snapshot) => {
        (snapshot.countries.AA!.evidence.inputs as unknown as Record<string, unknown>)['undeclared.rawProviderPayload'] = { rows: [] };
      }],
      ['undeclared source state', (snapshot) => {
        (snapshot.sourceStates as Record<string, unknown>)['undeclared:source:v1'] = {
          status: 'available', sourceKey: 'undeclared:source:v1',
        };
      }],
      ['malformed nested observation', (snapshot) => {
        const input = snapshot.countries.AA!.evidence.inputs['energy.lowCarbonShare'];
        if (input.availability === 'available') input.observations = [42] as never;
      }],
      ['unavailable evidence carrying a value', (snapshot) => {
        const input = snapshot.countries.AA!.evidence.inputs['demographics.totalDependency'];
        (input as unknown as Record<string, unknown>).value = 0;
      }],
      ['malformed result input', (snapshot) => {
        snapshot.countries.AA!.result.pillars.energy.inputs = [42] as never;
      }],
      ['wrong registered unit', (snapshot) => {
        const input = snapshot.countries.AA!.evidence.inputs['energy.lowCarbonShare'];
        if (input.availability === 'available') input.unit = 'kg';
      }],
      ['available evidence without provenance observations', (snapshot) => {
        const input = snapshot.countries.AA!.evidence.inputs['energy.lowCarbonShare'];
        if (input.availability === 'available') input.observations = [];
      }],
      ['physical aggregation inconsistent with its value', (snapshot) => {
        const input = snapshot.countries.AA!.evidence.inputs['energy.productionBalance'];
        if (input.availability === 'available' && input.aggregation) input.aggregation.numerator += 1;
      }],
      ['aggregation on a non-physical input', (snapshot) => {
        const input = snapshot.countries.AA!.evidence.inputs['energy.lowCarbonShare'];
        if (input.availability === 'available') {
          input.aggregation = { numerator: input.value, denominator: 1, unit: input.unit };
        }
      }],
      ['physical input missing aggregation totals', (snapshot) => {
        const input = snapshot.countries.AA!.evidence.inputs['energy.productionBalance'];
        if (input.availability === 'available') delete input.aggregation;
      }],
      ['minimum countries', () => {}, { minimumCountries: 2 }],
      ['byte budget', () => {}, { minimumCountries: 1, maxBytes: 1 }],
    ];
    for (const [label, mutate, options = { minimumCountries: 1 }] of cases) {
      const candidate = structuredClone(valid);
      mutate(candidate);
      assert.equal(validateFiveFactorSnapshot(candidate, options), false, label);
    }
    const unscoreable = buildFiveFactorSnapshot(['AA'], {
      population: null, foodStocks: null, demographics: null, defense: null, energyMix: null,
      staticByCountry: null, lowCarbon: null, powerLosses: null, importHhi: null, techByIso2: null,
    }, '2026-08-29T00:00:00.000Z');
    assert.equal(validateFiveFactorSnapshot(unscoreable, { minimumCountries: 1 }), false, 'zero scoreable pillars');
    assert.equal(hasFiveFactorSnapshotShape({ ...valid, sourceStates: null }), false);
  });

  it('rejects a large cohort when usable pillar coverage collapses', () => {
    const countryCodes = syntheticIso2Codes(150);
    const coveredCountry = countryCodes[0]!;
    const degraded = buildFiveFactorSnapshot(countryCodes, {
      ...sources,
      population: { countries: { [coveredCountry]: { populationMillions: 10, year: 2024 } } },
      energyMix: { [coveredCountry]: { balanceYear: 2024, primaryEnergyConsumptionTwh: 100, balanceImportSharePercent: 0 } },
    }, '2026-08-29T00:00:00.000Z');
    const coverage = scorecardCoverage(degraded);
    assert.equal(coverage.scoreableCountries, 1);
    assert.equal(coverage.scoreableCountriesByPillar.energy, 1);
    assert.equal(validateFiveFactorSnapshot(degraded), false);
    assert.equal(declareScorecardRecords(degraded), 1, 'seed health counts usable countries, not object shape');
  });

  it('rejects a production cohort when population evidence falls below its frozen floor', () => {
    const countryCodes = syntheticIso2Codes(180);
    const cohortSources = {
      ...sources,
      population: {
        countries: Object.fromEntries(countryCodes.slice(0, 149).map((countryCode) => [
          countryCode,
          { populationMillions: 10, year: 2024 },
        ])),
      },
      energyMix: Object.fromEntries(countryCodes.map((countryCode) => [
        countryCode,
        { balanceYear: 2024, primaryEnergyConsumptionTwh: 100, balanceImportSharePercent: 0 },
      ])),
    };
    const snapshot = buildFiveFactorSnapshot(countryCodes, cohortSources, '2026-08-29T00:00:00.000Z');
    const coverage = scorecardCoverage(snapshot);
    assert.equal(coverage.scoreableCountries, 180);
    assert.equal(coverage.populationEvidenceCountries, 149);
    assert.equal(validateFiveFactorSnapshot(snapshot), false);
  });

  it('enforces every per-pillar publication floor independently', () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    const coverage = scorecardCoverage(snapshot);
    for (const [pillar, count] of Object.entries(coverage.scoreableCountriesByPillar)) {
      const common = {
        minimumCountries: 1,
        minimumScoreableCountries: 0,
        minimumPopulationEvidenceCountries: 0,
      };
      assert.equal(validateFiveFactorSnapshot(snapshot, {
        ...common,
        minimumScoreableCountriesByPillar: { [pillar]: count + 1 },
      }), false, `${pillar} rejects below its floor`);
      assert.equal(validateFiveFactorSnapshot(snapshot, {
        ...common,
        minimumScoreableCountriesByPillar: { [pillar]: count },
      }), true, `${pillar} accepts its exact floor`);
    }
  });

  it('derives the source-state ledger from the source-read registry', () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    assert.deepEqual(Object.keys(snapshot.sourceStates).sort(), Object.values(SCORECARD_SOURCE_KEYS).sort());
  });

  it('assembles the complete source snapshot from one ordered Redis pipeline', async () => {
    const fixedKeys = Object.entries(SCORECARD_SOURCE_KEYS).filter(([field]) => field !== 'staticByCountry');
    const expectedKeys = [...fixedKeys.map(([, key]) => key), 'resilience:static:US', 'resilience:static:DE'];
    const values = Object.fromEntries(expectedKeys.map((key) => [key, { key }]));
    values[SCORECARD_SOURCE_KEYS.techByIso2] = [{ country: 'USA', observations: { internet: { value: 1 } } }];
    let commands: unknown[] = [];
    const result = await readScorecardSources(['US', 'DE'], {
      pipeline: async (input: unknown[]) => {
        commands = input;
        return expectedKeys.map((key) => ({ result: JSON.stringify(values[key]) }));
      },
    });
    assert.deepEqual(commands, expectedKeys.map((key) => ['GET', key]));
    assert.deepEqual(result.population, values[SCORECARD_SOURCE_KEYS.population]);
    assert.deepEqual(result.staticByCountry, {
      US: values['resilience:static:US'],
      DE: values['resilience:static:DE'],
    });
    assert.deepEqual(result.techByIso2?.US, values[SCORECARD_SOURCE_KEYS.techByIso2][0]);
    await assert.rejects(() => readScorecardSources(['US'], { pipeline: async () => [] }), /returned 0\/10 rows/);
  });

  it('retains expired source-envelope freshness for stale evidence semantics', async () => {
    const fixedKeys = Object.entries(SCORECARD_SOURCE_KEYS).filter(([field]) => field !== 'staticByCountry');
    const expectedKeys = [...fixedKeys.map(([, key]) => key), 'resilience:static:US'];
    const freshAt = Date.parse('2026-08-01T00:00:00.000Z');
    const result = await readScorecardSources(['US'], {
      nowMs: freshAt + 61 * 60_000,
      pipeline: async () => expectedKeys.map((key) => ({
        result: JSON.stringify({
          _seed: { fetchedAt: freshAt, newestItemAt: freshAt, maxContentAgeMin: 60 },
          data: key === SCORECARD_SOURCE_KEYS.population
            ? { countries: { US: { populationMillions: 10, year: 2026 } } }
            : {},
        }),
      })),
    });
    assert.equal(result.sourceFreshness?.population?.status, 'stale');
    const snapshot = buildFiveFactorSnapshot(['US'], result, '2026-08-01T01:01:00.000Z');
    assert.equal(snapshot.sourceStates[SCORECARD_SOURCE_KEYS.population]?.status, 'stale');
    assert.equal(snapshot.countries.US?.evidence.inputs.population.availability, 'unavailable');
    assert.equal(snapshot.countries.US?.evidence.inputs.population.availability === 'unavailable'
      && snapshot.countries.US.evidence.inputs.population.reason, 'stale');
  });

  it('sets the seed User-Agent and rejects failed Redis source reads', async () => {
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      process.env.UPSTASH_REDIS_REST_URL = 'https://scorecard-test-upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      let init: RequestInit | undefined;
      await redisPipeline([['GET', 'key']], async (_input, requestInit) => {
        init = requestInit;
        return new Response(JSON.stringify([{ result: null }]), { status: 200 });
      });
      assert.equal((init?.headers as Record<string, string>)['User-Agent'], 'WorldMonitor-Seed/1.0 (https://worldmonitor.app)');
      await assert.rejects(() => redisPipeline([['GET', 'key']], async () => new Response('', { status: 503 })), /HTTP 503/);
    } finally {
      if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  });

  it('stages all read-model fields before one atomic cohort switch', async () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    const calls: unknown[][][] = [];
    const pipeline = async (commands: unknown[][]) => { calls.push(commands); return commands.map(() => ({ result: 1 })); };
    const stagingKey = await stageScorecardReadModel(snapshot, { runId: 'test-run', pipeline, batchSize: 2 });
    await publishScorecardCohortAtomically(stagingKey, { pipeline, ttlSeconds: 123, payload: '{"cohort":1}' });
    const commands = calls.flat();
    assert.ok(commands.some((command) => command[0] === 'HSET' && command[1] === stagingKey));
    assert.ok(commands.some((command) => command[0] === 'EXPIRE' && command[1] === stagingKey));
    const atomicCommand = commands.at(-1)!;
    assert.equal(atomicCommand[0], 'EVAL');
    assert.match(String(atomicCommand[1]), /SET.*RENAME.*EXPIRE.*SET.*KEYS\[4\]/);
    assert.match(String(atomicCommand[1]), /redis\.call\('SET', KEYS\[4\], '1'\)/);
    assert.doesNotMatch(String(atomicCommand[1]), /KEYS\[4\].*'EX'/);
    // The idempotency branch must compare the fingerprint, never the payload:
    // GET KEYS[1] == ARGV[1] copied and compared the whole multi-MB canonical
    // value inside the script.
    assert.match(String(atomicCommand[1]), /redis\.call\('GET', KEYS\[5\]\) == ARGV\[3\]/);
    assert.doesNotMatch(String(atomicCommand[1]), /redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\]/);
    assert.deepEqual(atomicCommand.slice(2), [
      '5',
      'scorecard:five-factor:v1',
      stagingKey,
      'scorecard:five-factor:v1:read-model',
      SCORECARD_ACTIVATION_KEY,
      SCORECARD_FINGERPRINT_KEY,
      '{"cohort":1}',
      '123',
      scorecardPayloadFingerprint('{"cohort":1}'),
    ]);
    const hsetValues = commands.filter((command) => command[0] === 'HSET').flatMap((command) => command.slice(2));
    const fields = new Map<string, string>();
    for (let index = 0; index < hsetValues.length; index += 2) fields.set(String(hsetValues[index]), String(hsetValues[index + 1]));
    assert.ok(fields.has('metadata'));
    assert.ok(fields.has('country:AA'));
    const list = JSON.parse(fields.get('list')!);
    assert.equal('inputs' in list[0].pillars.energy, false);
  });

  it('retries an ambiguous atomic-switch response idempotently and preserves the live cohort without staging', async () => {
    const canonicalKey = 'scorecard:test:canonical';
    const stagingKey = 'scorecard:five-factor:v1:read-model:staging:ambiguous-run';
    const liveReadModelKey = 'scorecard:five-factor:v1:read-model';
    const values = new Map<string, string>([
      [canonicalKey, 'old-canonical'],
      [liveReadModelKey, 'old-read-model'],
      [stagingKey, 'new-read-model'],
    ]);
    const ttls = new Map<string, number>();
    let loseFirstResponse = true;
    const pipeline = async (commands: unknown[][]) => {
      assert.equal(commands.length, 1);
      const command = commands[0]!;
      assert.equal(command[0], 'EVAL');
      const [, script, keyCount, commandCanonicalKey, commandStagingKey, commandLiveKey, commandActivationKey, commandFingerprintKey, payload, ttl, fingerprint] = command.map(String);
      assert.equal(keyCount, '5');
      assert.equal(commandActivationKey, SCORECARD_ACTIVATION_KEY);
      assert.equal(commandFingerprintKey, SCORECARD_FINGERPRINT_KEY);
      assert.equal(fingerprint, scorecardPayloadFingerprint(payload));
      assert.match(script, /scorecard staging cohort missing/);
      assert.match(script, /redis\.call\('SET', KEYS\[4\], '1'\)/);
      if (values.has(commandStagingKey)) {
        values.set(commandCanonicalKey, payload);
        values.set(commandLiveKey, values.get(commandStagingKey)!);
        values.set(commandActivationKey, '1');
        values.set(commandFingerprintKey, fingerprint);
        values.delete(commandStagingKey);
        ttls.set(commandCanonicalKey, Number(ttl));
        ttls.set(commandLiveKey, Number(ttl));
        ttls.set(commandFingerprintKey, Number(ttl));
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error('synthetic response lost after Redis committed');
        }
        return [{ result: 1 }];
      }
      // Idempotency is decided by the fingerprint, never by re-reading the
      // multi-MB canonical value.
      if (values.get(commandFingerprintKey) === fingerprint
        && values.has(commandCanonicalKey)
        && values.has(commandLiveKey)) {
        values.set(commandActivationKey, '1');
        return [{ result: 1 }];
      }
      throw new Error('scorecard staging cohort missing');
    };

    await assert.rejects(
      publishScorecardCohortAtomically(stagingKey, { canonicalKey, payload: 'new-canonical', ttlSeconds: 321, pipeline }),
      /response lost/,
    );
    assert.deepEqual(
      [values.get(canonicalKey), values.get(liveReadModelKey), values.get(SCORECARD_ACTIVATION_KEY), ttls.get(canonicalKey), ttls.get(liveReadModelKey)],
      ['new-canonical', 'new-read-model', '1', 321, 321],
    );
    assert.equal(ttls.has(SCORECARD_ACTIVATION_KEY), false);
    await publishScorecardCohortAtomically(stagingKey, { canonicalKey, payload: 'new-canonical', ttlSeconds: 321, pipeline });
    await assert.rejects(
      publishScorecardCohortAtomically('scorecard:missing:staging', { canonicalKey, payload: 'other-canonical', ttlSeconds: 321, pipeline }),
      /staging cohort missing/,
    );
    assert.deepEqual([values.get(canonicalKey), values.get(liveReadModelKey)], ['new-canonical', 'new-read-model']);
  });

  it('deletes a partial staging hash when a batch fails permanently', async () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    const calls: unknown[][][] = [];
    let call = 0;
    await assert.rejects(() => stageScorecardReadModel(snapshot, {
      runId: 'failed-run',
      batchSize: 1,
      pipeline: async (commands) => {
        calls.push(commands);
        call += 1;
        if (call === 2) {
          // Tagged non-retryable so this exercises the cleanup path directly
          // rather than waiting out the retry ladder a transient error now gets.
          const error = Object.assign(new Error('synthetic staging failure'), { nonRetryable: true });
          throw error;
        }
        return commands.map(() => ({ result: 1 }));
      },
    }), /synthetic staging failure/);
    assert.ok(calls.flat().some((command) => command[0] === 'DEL' && command[1] === 'scorecard:five-factor:v1:read-model:staging:failed-run'));
  });

  it('still stages the cohort when a batch fails once and succeeds on retry', async () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    const calls: unknown[][][] = [];
    let call = 0;
    // atomicPublish invokes beforePublish outside its own retry loop, so an
    // unretried transient Upstash 5xx on any one of the staging requests used to
    // abort the whole daily publication until the next six-hour tick.
    const stagingKey = await stageScorecardReadModel(snapshot, {
      runId: 'flaky-run',
      batchSize: 1,
      pipeline: async (commands) => {
        calls.push(commands);
        call += 1;
        if (call === 2) throw new Error('synthetic transient Upstash failure');
        return commands.map(() => ({ result: 1 }));
      },
    });
    assert.equal(stagingKey, 'scorecard:five-factor:v1:read-model:staging:flaky-run');
    assert.equal(
      calls.flat().some((command) => command[0] === 'DEL'),
      false,
      'a recovered staging run must not delete the cohort it just wrote',
    );
  });

  it('reads one country and the compact list without downloading the canonical cohort', async () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    const readModel = buildFiveFactorReadModel(snapshot);
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const commands: unknown[][] = [];
    const requestHeaders: Headers[] = [];
    try {
      process.env.UPSTASH_REDIS_REST_URL = 'https://scorecard-test-upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      globalThis.fetch = async (_input, init = {}) => {
        requestHeaders.push(new Headers(init.headers));
        const body = JSON.parse(String(init.body)) as unknown[][];
        commands.push(...body);
        const fields = body[0]!.slice(2).map(String);
        const values = fields.map((field) => field === 'metadata'
          ? JSON.stringify(readModel.metadata)
          : field === 'list'
            ? JSON.stringify(readModel.list)
            : field === 'country:AA'
              ? JSON.stringify(readModel.countries.AA)
              : null);
        return new Response(JSON.stringify([{ result: values }]), { status: 200 });
      };
      const selected = await readFiveFactorSnapshot(['AA']);
      assert.equal((selected as typeof snapshot).countries.AA?.result.countryCode, 'AA');
      const projection = await readFiveFactorListProjection();
      assert.equal(projection?.scorecards[0]?.countryCode, 'AA');
      assert.deepEqual(commands, [
        ['HMGET', 'scorecard:five-factor:v1:read-model', 'metadata', 'country:AA'],
        ['HMGET', 'scorecard:five-factor:v1:read-model', 'metadata', 'list'],
      ]);
      assert.ok(requestHeaders.every((headers) => headers.get('User-Agent') === 'worldmonitor-server/1.0 (redis)'));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  });

  it('falls back to canonical when a known country hash field is absent', async () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    const readModel = buildFiveFactorReadModel(snapshot);
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const commands: unknown[][] = [];
    let canonicalHeaders: Headers | null = null;
    try {
      __resetFiveFactorSnapshotCacheForTests();
      process.env.UPSTASH_REDIS_REST_URL = 'https://scorecard-test-upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      globalThis.fetch = async (_input, init = {}) => {
        const body = JSON.parse(String(init.body)) as unknown[] | unknown[][];
        if (body[0] === 'GET') {
          commands.push(body as unknown[]);
          canonicalHeaders = new Headers(init.headers);
          return new Response(JSON.stringify({ result: JSON.stringify(snapshot) }), { status: 200 });
        }
        commands.push(...body as unknown[][]);
        return new Response(JSON.stringify([{ result: [JSON.stringify(readModel.metadata), null] }]), { status: 200 });
      };
      const selected = await readFiveFactorSnapshot(['AA']);
      assert.equal((selected as typeof snapshot).countries.AA?.result.countryCode, 'AA');
      assert.equal(commands.some((command) => command[0] === 'GET' && command[1] === 'scorecard:five-factor:v1'), true);
      assert.equal(canonicalHeaders?.get('User-Agent'), 'worldmonitor-server/1.0 (redis)');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      __resetFiveFactorSnapshotCacheForTests();
    }
  });

  it('rejects a shape-valid but non-reproducible country hash and uses canonical last-good', async () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    const readModel = buildFiveFactorReadModel(snapshot);
    const tampered = structuredClone(readModel.countries.AA!);
    tampered.result.pillars.energy.subScore = 99;
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const commands: unknown[][] = [];
    try {
      __resetFiveFactorSnapshotCacheForTests();
      process.env.UPSTASH_REDIS_REST_URL = 'https://scorecard-test-upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      globalThis.fetch = async (_input, init = {}) => {
        const body = JSON.parse(String(init.body)) as unknown[] | unknown[][];
        if (body[0] === 'GET') {
          commands.push(body as unknown[]);
          return new Response(JSON.stringify({ result: JSON.stringify(snapshot) }), { status: 200 });
        }
        commands.push(...body as unknown[][]);
        return new Response(JSON.stringify([{
          result: [JSON.stringify(readModel.metadata), JSON.stringify(tampered)],
        }]), { status: 200 });
      };
      const selected = await readFiveFactorSnapshot(['AA']);
      assert.equal((selected as typeof snapshot).countries.AA?.result.pillars.energy.subScore,
        snapshot.countries.AA?.result.pillars.energy.subScore);
      assert.equal(commands.some((command) => command[0] === 'GET'), true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      __resetFiveFactorSnapshotCacheForTests();
    }
  });

  it('does not start a full canonical fallback after the shared read deadline expires', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    let requestCount = 0;
    try {
      __resetFiveFactorSnapshotCacheForTests();
      process.env.UPSTASH_REDIS_REST_URL = 'https://scorecard-test-upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      globalThis.fetch = async (_input, init = {}) => {
        requestCount += 1;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          if (!signal) return reject(new Error('missing Redis deadline signal'));
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      };
      const deadlineAtMs = Date.now() + 40;
      const startedAtMs = Date.now();
      assert.equal(await readFiveFactorSnapshot(['AA'], deadlineAtMs), null);
      assert.equal(requestCount, 1, 'expired read-model budget must not start the canonical fallback');
      assert.ok(Date.now() - startedAtMs < 500, 'scorecard Redis fallback must stay within the caller budget');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      __resetFiveFactorSnapshotCacheForTests();
    }
  });

  it('scopes one corrupt country hash to that country instead of discarding the cohort', async () => {
    const snapshot = buildFiveFactorSnapshot(['AA', 'AB'], sources, '2026-08-29T00:00:00.000Z');
    const readModel = buildFiveFactorReadModel(snapshot);
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const commands: unknown[][] = [];
    try {
      __resetFiveFactorSnapshotCacheForTests();
      process.env.UPSTASH_REDIS_REST_URL = 'https://scorecard-test-upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      globalThis.fetch = async (_input, init = {}) => {
        const body = JSON.parse(String(init.body)) as unknown[] | unknown[][];
        if (body[0] === 'GET') {
          commands.push(body as unknown[]);
          return new Response(JSON.stringify({ result: JSON.stringify(snapshot) }), { status: 200 });
        }
        commands.push(...body as unknown[][]);
        const fields = (body as unknown[][])[0]!.slice(2).map(String);
        return new Response(JSON.stringify([{
          result: fields.map((field) => {
            if (field === 'metadata') return JSON.stringify(readModel.metadata);
            if (field === 'country:AA') return JSON.stringify(readModel.countries.AA);
            return 'not-json';
          }),
        }]), { status: 200 });
      };
      const selected = await readFiveFactorSnapshot(['AA', 'AB']) as typeof snapshot;
      assert.equal(selected.countries.AA?.result.countryCode, 'AA', 'the readable country still comes from the read model');
      assert.equal(selected.countries.AB, undefined, 'the corrupt country is simply absent');
      assert.equal(
        commands.some((command) => command[0] === 'GET' && command[1] === 'scorecard:five-factor:v1'),
        false,
        'one bad field must not force the expensive full-snapshot fallback',
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      __resetFiveFactorSnapshotCacheForTests();
    }
  });

  it('serves the warm canonical cohort when its refresh fails', async () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const originalNow = Date.now;
    let canonicalReads = 0;
    let failCanonical = false;
    try {
      __resetFiveFactorSnapshotCacheForTests();
      process.env.UPSTASH_REDIS_REST_URL = 'https://scorecard-test-upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      globalThis.fetch = async (_input, init = {}) => {
        const body = JSON.parse(String(init.body)) as unknown[] | unknown[][];
        if (body[0] === 'GET') {
          canonicalReads += 1;
          if (failCanonical) return new Response('upstream down', { status: 503 });
          return new Response(JSON.stringify({ result: JSON.stringify(snapshot) }), { status: 200 });
        }
        // No usable read model, so every call goes to the canonical fallback.
        return new Response(JSON.stringify([{ result: [null, null] }]), { status: 200 });
      };
      const warmed = await readFiveFactorSnapshot(['AA']) as typeof snapshot;
      assert.equal(warmed.countries.AA?.result.countryCode, 'AA');
      assert.equal(canonicalReads, 1);

      // Age past the 5-minute refresh window so the next read must refresh,
      // and make that refresh fail the way an Upstash blip does.
      const advanced = originalNow() + (6 * 60_000);
      Date.now = () => advanced;
      failCanonical = true;
      const stale = await readFiveFactorSnapshot(['AA']) as typeof snapshot;
      assert.equal(canonicalReads, 2, 'a stale cohort still attempts a refresh');
      assert.equal(
        stale?.countries.AA?.result.countryCode,
        'AA',
        'a failed refresh must not discard a cohort this isolate is still holding',
      );
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
      if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      __resetFiveFactorSnapshotCacheForTests();
    }
  });

  it('stops re-scoring a cohort it has already validated', () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    assert.equal(asFiveFactorSnapshot(snapshot), snapshot, 'first call validates and memoizes');
    // hasFiveFactorSnapshotShape re-runs scoreCountry for every country, so the
    // handlers' second asFiveFactorSnapshot call on the reader's own object used
    // to pay the full cost again. Tampering after the memo proves the re-scoring
    // is genuinely skipped -- the object never escapes the module between the
    // read and the handler, so trusting identity here is safe.
    snapshot.countries.AA!.result.pillars.energy.subScore = 99;
    assert.equal(asFiveFactorSnapshot(snapshot), snapshot, 'a memoized cohort is not re-scored');
    // A different object with the same tampering is still rejected.
    assert.equal(asFiveFactorSnapshot(structuredClone(snapshot)), null);
  });

  it('fails malformed read-model country metadata closed and uses the bounded canonical fallback', async () => {
    const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
    const malformed = { ...buildFiveFactorReadModel(snapshot).metadata, countryCodes: null };
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const commands: unknown[][] = [];
    try {
      __resetFiveFactorSnapshotCacheForTests();
      process.env.UPSTASH_REDIS_REST_URL = 'https://scorecard-test-upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      globalThis.fetch = async (_input, init = {}) => {
        const body = JSON.parse(String(init.body)) as unknown[] | unknown[][];
        if (body[0] === 'GET') {
          commands.push(body as unknown[]);
          return new Response(JSON.stringify({ result: JSON.stringify(snapshot) }), { status: 200 });
        }
        commands.push(...body as unknown[][]);
        const fields = (body as unknown[][])[0]!.slice(2).map(String);
        return new Response(JSON.stringify([{ result: fields.map((field) => field === 'metadata' ? JSON.stringify(malformed) : null) }]), { status: 200 });
      };
      const selected = await readFiveFactorSnapshot(['AA']);
      assert.equal((selected as typeof snapshot).countries.AA?.result.countryCode, 'AA');
      assert.equal(await readFiveFactorListProjection(), null);
      assert.equal((await readFiveFactorSnapshot() as typeof snapshot).countries.AA?.result.countryCode, 'AA');
      assert.equal(commands.filter((command) => command[0] === 'GET').length, 1, 'canonical fallback is cached in-process');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
      __resetFiveFactorSnapshotCacheForTests();
    }
  });

  it('keeps the real rankable cohort summary below the MCP bulk budget', () => {
    const countryCodes = listRankableCountries();
    const snapshot = buildFiveFactorSnapshot(countryCodes, {
      population: null, foodStocks: null, demographics: null, defense: null, energyMix: null,
      staticByCountry: null, lowCarbon: null, powerLosses: null, importHhi: null, techByIso2: null,
    }, '2026-08-29T00:00:00.000Z');
    const readModel = buildFiveFactorReadModel(snapshot);
    const response = {
      methodologyVersion: readModel.metadata.methodologyVersion,
      computedAt: readModel.metadata.computedAt,
      scorecards: readModel.list,
      unavailable: false,
      unavailableReason: '',
    };
    assert.ok(countryCodes.length >= 190);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 262_144);
  });

  it('uses runSeed as the only canonical publisher so a failed attempt preserves last-good', () => {
    const source = readFileSync(new URL('../scripts/seed-five-factor-scorecard.mjs', import.meta.url), 'utf8');
    assert.match(source, /runSeed\('scorecard', 'five-factor', FIVE_FACTOR_SCORECARD_KEY/);
    assert.doesNotMatch(source, /\['SET',\s*FIVE_FACTOR_SCORECARD_KEY/);
    assert.match(source, /SCORECARD_ACTIVATION_KEY = 'seed-activated:scorecard:five-factor'/);
    assert.match(source, /SCORECARD_ACTIVATION_KEY,/);
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

  it('preserves both last-good scorecard keys when the atomic cohort switch fails', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const originalSigterm = new Set(process.rawListeners('SIGTERM'));
    const calls: unknown[] = [];
    try {
      process.env.UPSTASH_REDIS_REST_URL = 'https://scorecard-test-upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      globalThis.fetch = async (_input, init = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push(body);
        if (Array.isArray(body) && Array.isArray(body[0])) {
          return new Response(JSON.stringify(body.map(() => ({ result: 1 }))), { status: 200 });
        }
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      };

      const snapshot = buildFiveFactorSnapshot(['AA'], sources, '2026-08-29T00:00:00.000Z');
      let staged = false;
      await assert.rejects(() => runSeed(
        'scorecard',
        'five-factor',
        'scorecard:five-factor:v1',
        async () => snapshot,
        {
          validateFn: (candidate: typeof snapshot) => validateFiveFactorSnapshot(candidate, { minimumCountries: 1 }),
          ttlSeconds: 3 * 24 * 3600,
          declareRecords: () => 1,
          sourceVersion: 'five-factor-scorecard-1.0.0',
          schemaVersion: 1,
          maxStaleMin: 36 * 60,
          preserveKeys: ['scorecard:five-factor:v1:read-model'],
          beforePublish: async () => { staged = true; },
          publishAtomically: async () => { throw new Error('synthetic atomic switch failure'); },
        },
      ), /synthetic atomic switch failure/);

      assert.equal(staged, true);
      const commands = calls.flatMap((body) => Array.isArray(body) && Array.isArray(body[0]) ? body : [body]);
      assert.equal(commands.some((command) => Array.isArray(command) && command[0] === 'SET'
        && ['scorecard:five-factor:v1', 'scorecard:five-factor:v1:read-model'].includes(command[1])), false);
      assert.equal(commands.some((command) => Array.isArray(command) && command[0] === 'SET'
        && command[1] === 'seed-meta:scorecard:five-factor'), false);
      assert.equal(commands.some((command) => Array.isArray(command) && command[0] === 'EXPIRE'
        && command[1] === 'scorecard:five-factor:v1'), true);
      assert.equal(commands.some((command) => Array.isArray(command) && command[0] === 'EXPIRE'
        && command[1] === 'scorecard:five-factor:v1:read-model'), true);
    } finally {
      globalThis.fetch = originalFetch;
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
