import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const RELAY_SOURCE = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = RELAY_SOURCE.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `could not find ${name} in ais-relay.cjs`);
  const bodyStart = RELAY_SOURCE.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < RELAY_SOURCE.length; i += 1) {
    if (RELAY_SOURCE[i] === '{') depth += 1;
    if (RELAY_SOURCE[i] === '}') depth -= 1;
    if (depth === 0) return RELAY_SOURCE.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name} in ais-relay.cjs`);
}

async function runSeedEtfFlows(volumes) {
  const https = {
    get(url, _opts, onResponse) {
      const ticker = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
      const resp = new EventEmitter();
      resp.statusCode = 200;
      onResponse(resp);
      resp.emit('data', JSON.stringify({ ticker, volume: volumes[ticker] }));
      resp.emit('end');
      return new EventEmitter();
    },
  };
  const parseEtfChart = (raw, ticker, issuer) => ({ ticker, issuer, volume: raw.volume, estFlow: 0, direction: 'neutral' });
  const writes = [];
  const envelopeWrite = async (key, payload) => { writes.push({ key, payload }); return true; };
  const seedEtfFlows = Function(
    'ETF_LIST', 'https', 'parseEtfChart', 'sleep', 'envelopeWrite', 'upstashSet', 'CHROME_UA', 'ETF_SEED_TTL', 'console',
    `${extractFunction('seedEtfFlows')}\nreturn seedEtfFlows;`,
  )(
    Object.keys(volumes).map((ticker) => ({ ticker, issuer: 'Test' })),
    https,
    parseEtfChart,
    async () => {},
    envelopeWrite,
    async () => true,
    'test-agent',
    3600,
    { log() {}, warn() {} },
  );
  await seedEtfFlows();
  return writes;
}

describe('relay ETF flow writer', () => {
  it('writes market:etf-flows:v1 rows in descending volume order (#11271)', async () => {
    const writes = await runSeedEtfFlows({ GBTC: 1_365_400, HODL: 2_530_100, BRRR: 47_900, EZBC: 156_100 });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].key, 'market:etf-flows:v1');
    assert.deepEqual(writes[0].payload.etfs.map((etf) => etf.ticker), ['HODL', 'GBTC', 'EZBC', 'BRRR']);
  });
});
