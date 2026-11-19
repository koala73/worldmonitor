/**
 * Health must say when a CII input is dead. ACLED credentials went missing
 * around 2026-07 (#5134): Unrest and Conflict read 0 for every country for
 * months while /api/health.riskScores stayed OK, because the UCDP floor kept
 * the realtime conflict family "covered". The risk-scores build now reports
 * each scored input's availability on its seed-meta, and health turns that
 * into a verdict.
 */
import { strict as assert } from 'node:assert';
import { after, beforeEach, describe, it } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalConsoleWarn = console.warn;
const UPSTASH = 'https://upstash.test';

process.env.UPSTASH_REDIS_REST_URL = UPSTASH;
process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
delete process.env.VERCEL_ENV;
delete process.env.LOCAL_API_MODE;
delete process.env.IRAN_EVENTS_ENABLED;
// ACLED is not configured in this deployment: no OAuth pair, no static token.
delete process.env.ACLED_ACCESS_TOKEN;
delete process.env.ACLED_EMAIL;
delete process.env.ACLED_PASSWORD;

const { getRiskScores, CII_HEALTH_INPUT_IDS } = await import('../server/worldmonitor/intelligence/v1/get-risk-scores');
const { __clearLocalUnavailableBackoffForTests } = await import('../server/_shared/redis');
const { __testing__ } = await import('../api/health.js');
const { assessCiiInputs, CII_INPUT_POLICY } = await import('../api/_cii-input-health.js');

const {
  classifyKey,
  composeRiskScoresInputHealth,
  healthResponseBody,
  isContainedHealthWarning,
  BOOTSTRAP_KEYS,
  SEED_META,
  STATUS_COUNTS,
} = __testing__;

const SEED_META_KEY = 'seed-meta:intelligence:risk-scores';
const NOW = Date.now();
const MIN = 60_000;

let writes: Array<{ key: string; value: string }> = [];
let reads: string[] = [];

function stubRedis(stored: Record<string, string> = {}): void {
  writes = [];
  reads = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== UPSTASH) throw new Error(`unexpected fetch: ${url}`);
    if (url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice('/get/'.length));
      reads.push(key);
      return Response.json({ result: stored[key] ?? null });
    }
    const body = JSON.parse(String(init.body ?? '[]'));
    const commands: unknown[][] = Array.isArray(body[0]) ? body : [body];
    for (const command of commands) {
      if (command[0] === 'SET') writes.push({ key: String(command[1]), value: String(command[2]) });
    }
    return Response.json(Array.isArray(body[0]) ? commands.map(() => ({ result: 'OK' })) : { result: 'OK' });
  }) as typeof fetch;
}

/**
 * The fixture production had for months: UCDP, news and military
 * alive, no realtime conflict feed. The strike feed is off by default
 * (IRAN_EVENTS_ENABLED), so it reports not_configured beside ACLED.
 */
function liveFeedsWithoutRealtimeConflict(): Record<string, string> {
  const events = Array.from({ length: 120 }, (_, i) => ({ country: 'Ukraine', dateStart: NOW - (i + 1) * 86_400_000, deathsBest: 3 }));
  return {
    'conflict:ucdp-events:v1': JSON.stringify({ events }),
    'news:insights:v1': JSON.stringify({ topStories: [{ countryCode: 'UA', threatLevel: 'critical', primaryTitle: 'Strikes on Kyiv' }] }),
    'intelligence:military-cii:v1': JSON.stringify({ byCountry: { UA: { ownFlights: 4, foreignFlights: 2 } } }),
  };
}

const gdeltCountryEvents = () => JSON.stringify({
  byCountry: { UA: { week: { articles: 5000, conflict: 2500, protest: 50 } } },
  weekReady: true,
  updatedAt: NOW - 10 * MIN,
});

async function buildSeedMeta(stored: Record<string, string>): Promise<Record<string, any>> {
  stubRedis(stored);
  await getRiskScores({} as never, {} as never);
  const meta = writes.filter((write) => write.key === SEED_META_KEY).at(-1);
  assert.ok(meta, 'the fresh build stamps seed-meta');
  return JSON.parse(meta!.value);
}

/** The production path: classify the key, then compose input health against the sibling checks. */
function riskScoresHealth(meta: unknown, checks: Record<string, { status: string }> = {}) {
  const raw = JSON.stringify(meta);
  const ctx = {
    containmentEvidenceByName: new Map(),
    keyStrens: new Map([[BOOTSTRAP_KEYS.riskScores, 4096]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[SEED_META.riskScores.key, raw]]),
    keyMetaErrors: new Map(),
    now: NOW,
  };
  const entry = classifyKey('riskScores', BOOTSTRAP_KEYS.riskScores, { allowOnDemand: false }, ctx);
  return composeRiskScoresInputHealth(entry, raw, checks, NOW);
}

beforeEach(() => {
  __clearLocalUnavailableBackoffForTests();
  console.warn = () => {};
});
after(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalConsoleWarn;
  process.env = originalEnv;
});

describe('CII input health, producer to verdict', () => {
  it('ACLED unconfigured and the GDELT conflict feed missing is an operator-visible warning', async () => {
    const meta = await buildSeedMeta(liveFeedsWithoutRealtimeConflict());

    assert.equal(meta.inputs.acled.state, 'not_configured');
    assert.equal(meta.inputs.gdeltCountryEvents.state, 'missing');
    assert.equal(meta.inputs.ucdp.state, 'live');
    assert.equal(meta.recordCount, 2, 'UCDP and news satisfy the v14 signal-density count');

    const entry = riskScoresHealth(meta);
    assert.equal(entry.status, 'COVERAGE_DEGRADED');
    assert.equal(STATUS_COUNTS[entry.status], 'warn');
    assert.deepEqual(entry.ciiInputs.unfedFamilies, ['conflict']);
    assert.deepEqual(entry.ciiInputs.notConfigured, ['acled', 'iranEvents', 'strikePressure']);
    assert.ok(entry.ciiInputs.dead.some((input: { id: string; state: string }) => (
      input.id === 'gdeltCountryEvents' && input.state === 'missing'
    )));
  });

  it('ACLED unconfigured with GDELT standing in is visible but not an alarm', async () => {
    const meta = await buildSeedMeta({
      ...liveFeedsWithoutRealtimeConflict(),
      'gdelt:bulk:country-events:v1': gdeltCountryEvents(),
    });

    assert.equal(meta.inputs.gdeltCountryEvents.state, 'live');
    const entry = riskScoresHealth(meta);
    assert.deepEqual(entry.ciiInputs.notConfigured, ['acled', 'iranEvents', 'strikePressure']);
    assert.deepEqual(entry.ciiInputs.unfedFamilies, []);
    assert.ok(!entry.ciiInputs.dead.some((input: { id: string }) => input.id === 'acled'));
  });

  it('a present but stale GDELT summary is unusable, not quiet', async () => {
    const meta = await buildSeedMeta({
      ...liveFeedsWithoutRealtimeConflict(),
      'gdelt:bulk:country-events:v1': JSON.stringify({ ...JSON.parse(gdeltCountryEvents()), updatedAt: NOW - 7 * 60 * MIN }),
    });
    assert.equal(meta.inputs.gdeltCountryEvents.state, 'unusable');
    assert.equal(riskScoresHealth(meta).status, 'COVERAGE_DEGRADED');
  });

  it('reports a feed that is present but scores nothing as quiet, and carries its quiet clock forward', async () => {
    const quietNews = JSON.stringify({ topStories: [] });
    const first = await buildSeedMeta({ ...liveFeedsWithoutRealtimeConflict(), 'news:insights:v1': quietNews });
    assert.equal(first.inputs.newsInsights.state, 'quiet');
    assert.equal(typeof first.inputs.newsInsights.quietSince, 'number');

    const since = NOW - 90 * MIN;
    const previous = { ...first, inputs: { ...first.inputs, newsInsights: { state: 'quiet', quietSince: since } } };
    const second = await buildSeedMeta({
      ...liveFeedsWithoutRealtimeConflict(),
      'news:insights:v1': quietNews,
      [SEED_META_KEY]: JSON.stringify(previous),
    });
    assert.equal(second.inputs.newsInsights.quietSince, since, 'a still-quiet input keeps the clock it started');

    const live = await buildSeedMeta({ ...liveFeedsWithoutRealtimeConflict(), [SEED_META_KEY]: JSON.stringify(previous) });
    assert.equal(live.inputs.newsInsights.state, 'live');
    assert.equal(live.inputs.newsInsights.quietSince, undefined, 'a live input resets the clock');
  });

  it('reads the relay threat summary envelope: empty is quiet, populated is live, absent is missing', async () => {
    // The exact shape scripts/ais-relay.cjs seedClassify writes. A quiet cycle
    // publishes `byCountry: {}`; only a vanished key is a dead input.
    const envelope = (byCountry: Record<string, unknown>) => JSON.stringify({
      _seed: { fetchedAt: NOW, recordCount: Object.keys(byCountry).length, sourceVersion: 'news-threat-summary', schemaVersion: 1, state: Object.keys(byCountry).length ? 'OK' : 'OK_ZERO' },
      data: { byCountry, generatedAt: NOW },
    });
    const quiet = await buildSeedMeta({ ...liveFeedsWithoutRealtimeConflict(), 'news:threat:summary:v1': envelope({}) });
    assert.equal(quiet.inputs.threatSummary.state, 'quiet');
    const live = await buildSeedMeta({
      ...liveFeedsWithoutRealtimeConflict(),
      'news:threat:summary:v1': envelope({ UA: { critical: 3, high: 2, medium: 0, low: 0, info: 0 } }),
    });
    assert.equal(live.inputs.threatSummary.state, 'live');
    const missing = await buildSeedMeta(liveFeedsWithoutRealtimeConflict());
    assert.equal(missing.inputs.threatSummary.state, 'missing');
  });

  it('does not read or grade the cyber feed removed from CII v14', async () => {
    const meta = await buildSeedMeta(liveFeedsWithoutRealtimeConflict());
    assert.equal(reads.includes('cyber:threats-bootstrap:v2'), false);
    assert.equal(Object.hasOwn(meta.inputs, 'cyber'), false);
    assert.equal(Object.hasOwn(CII_INPUT_POLICY.inputs, 'cyber'), false);
    assert.equal(Object.hasOwn(CII_INPUT_POLICY.families, 'cyber'), false);
    const inputs = Object.fromEntries(CII_HEALTH_INPUT_IDS.map((id) => [id, { state: 'live' }]));
    const entry = riskScoresHealth({ fetchedAt: NOW, recordCount: 2, inputs });
    assert.equal(entry.status, 'OK');
    assert.deepEqual(entry.ciiInputs.dead, []);
    assert.deepEqual(entry.ciiInputs.unfedFamilies, []);
  });

  it('reports every input the policy grades, and nothing else', () => {
    assert.deepEqual([...CII_HEALTH_INPUT_IDS].sort(), Object.keys(CII_INPUT_POLICY.inputs).sort());
    for (const members of Object.values(CII_INPUT_POLICY.families)) {
      for (const id of members as string[]) assert.ok(CII_HEALTH_INPUT_IDS.includes(id as never), `${id} is a reported input`);
    }
  });
});

describe('assessCiiInputs', () => {
  const allLive = () => Object.fromEntries(CII_HEALTH_INPUT_IDS.map((id) => [id, { state: 'live' }]));

  it('quiet but fresh is not dead', () => {
    const inputs = { ...allLive(), newsInsights: { state: 'quiet', quietSince: NOW - 30 * MIN } };
    const result = assessCiiInputs({ inputs }, NOW);
    assert.equal(result.valid, true);
    assert.deepEqual(result.dead, []);
  });

  it('quiet past its budget is dead, and a family with nothing else is unfed', () => {
    const budget = CII_INPUT_POLICY.inputs.newsInsights.maxQuietMin;
    const inputs = { ...allLive(), newsInsights: { state: 'quiet', quietSince: NOW - (budget + 1) * MIN }, threatSummary: { state: 'missing' } };
    const result = assessCiiInputs({ inputs }, NOW);
    assert.deepEqual(result.dead, [{ id: 'newsInsights', state: 'quiet', quietMin: budget + 1 }, { id: 'threatSummary', state: 'missing' }]);
    assert.deepEqual(result.unfedFamilies, ['information']);
  });

  it('an input whose quiet is plausible indefinitely never goes dead', () => {
    assert.equal(CII_INPUT_POLICY.inputs.earthquakes.maxQuietMin, null);
    const inputs = { ...allLive(), earthquakes: { state: 'quiet', quietSince: NOW - 90 * 24 * 60 * MIN } };
    assert.deepEqual(assessCiiInputs({ inputs }, NOW).dead, []);
  });

  it('an absent OREF history is the quiet state, because the relay writes it only on change', () => {
    const inputs = { ...allLive(), oref: { state: 'missing' } };
    const result = assessCiiInputs({ inputs }, NOW);
    assert.deepEqual(result.dead, []);
    assert.equal(result.states.oref, 'missing', 'still shown as missing');
  });

  it('a quiet input without a usable clock fails closed', () => {
    const inputs = { ...allLive(), newsInsights: { state: 'quiet' } };
    assert.deepEqual(assessCiiInputs({ inputs }, NOW).dead.map((input: { id: string }) => input.id), ['newsInsights']);
    const farFuture = { ...allLive(), newsInsights: { state: 'quiet', quietSince: NOW + 60 * MIN } };
    assert.deepEqual(assessCiiInputs({ inputs: farFuture }, NOW).dead.map((input: { id: string }) => input.id), ['newsInsights']);
  });

  it('a quiet clock a little ahead of the reader is clock skew, not a fault', () => {
    // The producer stamps quietSince with its own clock; another instance reads it.
    const inputs = { ...allLive(), newsInsights: { state: 'quiet', quietSince: NOW + 2_000 } };
    assert.deepEqual(assessCiiInputs({ inputs }, NOW).dead, []);
  });

  it('missing, unusable and unreported inputs are dead; not_configured alone is not', () => {
    const inputs: Record<string, unknown> = { ...allLive(), ucdp: { state: 'missing' }, fires: { state: 'unusable' }, acled: { state: 'not_configured' } };
    delete inputs.oref; // unreported fails closed even where an absent key would be quiet
    const result = assessCiiInputs({ inputs }, NOW);
    assert.deepEqual(result.dead.map((input: { id: string; state: string }) => `${input.id}:${input.state}`).sort(), ['fires:unusable', 'oref:unreported', 'ucdp:missing']);
    assert.deepEqual(result.notConfigured, ['acled']);
    assert.deepEqual(result.unfedFamilies, []);
  });

  it('a source check past its own staleness budget makes the input stale', () => {
    const result = assessCiiInputs({ inputs: allLive() }, NOW, { gdeltCountryEvents: 'STALE_SEED', newsInsights: 'OK' });
    assert.deepEqual(result.dead, [{ id: 'gdeltCountryEvents', state: 'stale', sourceCheck: 'gdeltCountryEvents' }]);
  });

  it('the fires input is graded against the summary probe the build reads (#9509)', () => {
    const result = assessCiiInputs({ inputs: allLive() }, NOW, { fires: 'STALE_SEED' });
    assert.deepEqual(result.dead, [{ id: 'fires', state: 'stale', sourceCheck: 'wildfiresSummary' }]);
  });

  it('seed-meta without an inputs block cannot prove anything', () => {
    assert.equal(assessCiiInputs({ fetchedAt: NOW, recordCount: 3 }, NOW).valid, false);
    assert.equal(assessCiiInputs(null, NOW).valid, false);
    assert.equal(assessCiiInputs({ inputs: { ...allLive(), newsInsights: { state: 'bogus' } } }, NOW).dead[0].state, 'unreported');
  });
});

describe('composeRiskScoresInputHealth', () => {
  const allLive = () => Object.fromEntries(CII_HEALTH_INPUT_IDS.map((id) => [id, { state: 'live' }]));
  const meta = (inputs: unknown, over: Record<string, unknown> = {}) => ({ fetchedAt: NOW - MIN, recordCount: 2, inputs, ...over });

  it('all inputs live stays OK and still shows the per-input states', () => {
    const entry = riskScoresHealth(meta(allLive()));
    assert.equal(entry.status, 'OK');
    assert.equal(entry.ciiInputs.states.acled, 'live');
  });

  it('one dead input with its family still fed is COVERAGE_PARTIAL', () => {
    const entry = riskScoresHealth(meta({ ...allLive(), fires: { state: 'missing' } }));
    assert.equal(entry.status, 'COVERAGE_PARTIAL');
    assert.deepEqual(entry.ciiInputs.unfedFamilies, []);
  });

  it('a stale sibling check feeds the verdict', () => {
    const entry = riskScoresHealth(meta({ ...allLive(), acled: { state: 'not_configured' } }), {
      gdeltCountryEvents: { status: 'STALE_SEED' },
    });
    assert.equal(entry.status, 'COVERAGE_DEGRADED');
    assert.deepEqual(entry.ciiInputs.unfedFamilies, ['conflict']);
  });

  it('fails closed on seed-meta that predates input reporting', () => {
    const entry = riskScoresHealth(meta(undefined));
    assert.equal(entry.status, 'COVERAGE_DEGRADED');
    assert.equal(entry.ciiInputs.valid, false);
  });

  it('a dead input is never contained behind the served payload', () => {
    // Containment means "served, just old"; scores missing a signal are wrong, not old.
    for (const [inputs, recordCount] of [
      [{ ...allLive(), acled: { state: 'not_configured' }, gdeltCountryEvents: { state: 'missing' } }, 3],
      [{ ...allLive(), fires: { state: 'missing' } }, 2],
    ] as const) {
      const raw = JSON.stringify(meta(inputs, { recordCount }));
      const ctx = {
        containmentEvidenceByName: new Map(),
        keyStrens: new Map([[BOOTSTRAP_KEYS.riskScores, 4096]]),
        keyErrors: new Map(),
        keyMetaValues: new Map([[SEED_META.riskScores.key, raw]]),
        keyMetaErrors: new Map(),
        now: NOW,
      };
      const entry = composeRiskScoresInputHealth(
        classifyKey('riskScores', BOOTSTRAP_KEYS.riskScores, { allowOnDemand: false }, ctx),
        raw, {}, NOW, ctx.containmentEvidenceByName,
      );
      assert.equal(STATUS_COUNTS[entry.status], 'warn');
      assert.equal(isContainedHealthWarning(entry, ctx.containmentEvidenceByName.get('riskScores'), NOW), false);
    }
  });

  it('a signal-density shortfall with every input healthy stays containable, as before', () => {
    const raw = JSON.stringify(meta(allLive(), { recordCount: 1 }));
    const ctx = {
      containmentEvidenceByName: new Map(),
      keyStrens: new Map([[BOOTSTRAP_KEYS.riskScores, 4096]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[SEED_META.riskScores.key, raw]]),
      keyMetaErrors: new Map(),
      now: NOW,
    };
    const entry = composeRiskScoresInputHealth(
      classifyKey('riskScores', BOOTSTRAP_KEYS.riskScores, { allowOnDemand: false }, ctx),
      raw, {}, NOW, ctx.containmentEvidenceByName,
    );
    assert.equal(entry.status, 'COVERAGE_PARTIAL');
    assert.equal(isContainedHealthWarning(entry, ctx.containmentEvidenceByName.get('riskScores'), NOW), true);
  });

  it('never softens a stronger verdict the seed-meta already earned', () => {
    const entry = riskScoresHealth(meta({ ...allLive(), fires: { state: 'missing' } }, { fetchedAt: NOW - 120 * MIN }));
    assert.equal(entry.status, 'STALE_SEED');
    assert.deepEqual(entry.ciiInputs.dead.map((input: { id: string }) => input.id), ['fires']);
  });

  it('a stale report with an unfed family is not contained either', () => {
    // Otherwise the warning would turn into a contained HEALTHY once the seed-meta ages past 30 min.
    const raw = JSON.stringify(meta(
      { ...allLive(), acled: { state: 'not_configured' }, gdeltCountryEvents: { state: 'missing' } },
      { fetchedAt: NOW - 120 * MIN },
    ));
    const ctx = {
      containmentEvidenceByName: new Map(),
      keyStrens: new Map([[BOOTSTRAP_KEYS.riskScores, 4096]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[SEED_META.riskScores.key, raw]]),
      keyMetaErrors: new Map(),
      now: NOW,
    };
    const entry = composeRiskScoresInputHealth(
      classifyKey('riskScores', BOOTSTRAP_KEYS.riskScores, { allowOnDemand: false }, ctx),
      raw, {}, NOW, ctx.containmentEvidenceByName,
    );
    assert.equal(entry.status, 'STALE_SEED');
    assert.equal(isContainedHealthWarning(entry, ctx.containmentEvidenceByName.get('riskScores'), NOW), false);
  });

  it('keeps the per-input detail out of the anonymous compact body', () => {
    // Which sources a deployment has not configured, or has lost, is operator-only.
    const entry = riskScoresHealth(meta({ ...allLive(), acled: { state: 'not_configured' }, gdeltCountryEvents: { state: 'missing' } }));
    const snapshot = { status: 'WARNING', summary: {}, checkedAt: new Date(NOW).toISOString(), checks: { riskScores: entry } };
    const compact = healthResponseBody(snapshot, true);
    assert.equal(compact.problems.riskScores.status, 'COVERAGE_DEGRADED');
    assert.equal(compact.problems.riskScores.ciiInputs, undefined);
    assert.equal(
      healthResponseBody({ ...snapshot, checks: undefined, problems: { riskScores: entry } }, true).problems.riskScores.ciiInputs,
      undefined,
      'a compact snapshot cached before the rule is scrubbed too',
    );
    assert.deepEqual(healthResponseBody(snapshot, false).checks.riskScores.ciiInputs, entry.ciiInputs);
  });
});

describe('/api/seed-health intelligence:risk-scores', () => {
  async function seedHealthEntry(riskScoresMeta: unknown) {
    process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
    globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      const commands = JSON.parse(String(init.body ?? '[]')) as unknown[][];
      return Response.json(commands.map(([op, key]) => {
        if (op === 'EXISTS') return { result: 0 };
        if (key === SEED_META_KEY) return { result: JSON.stringify(riskScoresMeta) };
        return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 10_000 }) };
      }));
    }) as typeof fetch;
    const { default: seedHealth } = await import('../api/seed-health.js');
    const res = await seedHealth(new Request('https://api.worldmonitor.app/api/seed-health', {
      headers: { 'X-WorldMonitor-Key': 'test-key' },
    }));
    return (await res.json()).seeds['intelligence:risk-scores'];
  }

  it('grades the same producer report as /api/health', async () => {
    const meta = await buildSeedMeta(liveFeedsWithoutRealtimeConflict());
    const entry = await seedHealthEntry(meta);
    assert.equal(entry.status, 'coverage_partial');
    assert.equal(entry.coveragePartial, true);
    assert.deepEqual(entry.ciiInputs.unfedFamilies, ['conflict']);
    assert.deepEqual(entry.ciiInputs.notConfigured, ['acled', 'iranEvents', 'strikePressure']);
  });

  it('stays ok when every input is live', async () => {
    const inputs = Object.fromEntries(CII_HEALTH_INPUT_IDS.map((id) => [id, { state: 'live' }]));
    const entry = await seedHealthEntry({ fetchedAt: Date.now(), recordCount: 2, inputs });
    assert.equal(entry.status, 'ok');
    assert.deepEqual(entry.ciiInputs.dead, []);
  });

  it('fails closed on a report without inputs', async () => {
    const entry = await seedHealthEntry({ fetchedAt: Date.now(), recordCount: 3 });
    assert.equal(entry.status, 'coverage_partial');
    assert.equal(entry.ciiInputs.valid, false);
  });
});
