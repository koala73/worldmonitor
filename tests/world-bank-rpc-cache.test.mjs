import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WORLD_BANK_DEFAULT_CACHE_COUNTRY,
  WORLD_BANK_LOOKBACKS,
  filterWorldBankRecords,
  worldBankRpcCacheCommands,
  worldBankRpcCacheKey,
} from '../shared/world-bank-rpc-cache.js';

const currentYear = 2026;
const indicator = 'NY.GDP.MKTP.CD';
const records = [
  {
    countryCode: 'USA',
    countryName: 'United States',
    indicatorCode: indicator,
    indicatorName: 'GDP',
    year: 2025,
    value: 1,
  },
  {
    countryCode: 'AFG',
    countryName: 'Afghanistan',
    indicatorCode: indicator,
    indicatorName: 'GDP',
    year: 2025,
    value: 2,
  },
];

describe('World Bank RPC cache identity', () => {
  it('filters the all snapshot to the curated default country set', () => {
    const filtered = filterWorldBankRecords(records, WORLD_BANK_DEFAULT_CACHE_COUNTRY, 5, currentYear);
    assert.deepEqual(filtered.map((row) => row.countryCode), ['USA']);
  });

  it('writes all and default keys for each lookback without empty snapshots', () => {
    const commands = worldBankRpcCacheCommands('', indicator, records, currentYear, 60);
    assert.equal(commands.length, WORLD_BANK_LOOKBACKS.length * 2);
    assert.deepEqual(
      commands.map((command) => command[1]),
      WORLD_BANK_LOOKBACKS.flatMap((years) => [
        worldBankRpcCacheKey(indicator, 'all', years, currentYear),
        worldBankRpcCacheKey(indicator, WORLD_BANK_DEFAULT_CACHE_COUNTRY, years, currentYear),
      ]),
    );
    const allPayload = JSON.parse(commands[0][2]);
    const defaultPayload = JSON.parse(commands[1][2]);
    assert.deepEqual(allPayload.data.map((row) => row.countryCode), ['USA', 'AFG']);
    assert.deepEqual(defaultPayload.data.map((row) => row.countryCode), ['USA']);
    assert.equal(commands[0][3], 'EX');
    assert.equal(commands[0][4], '60');
  });

  it('keeps the Railway mirror byte-identical', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const canonical = readFileSync(join(dir, '../shared/world-bank-rpc-cache.js'), 'utf8');
    const mirror = readFileSync(join(dir, '../scripts/shared/world-bank-rpc-cache.js'), 'utf8');
    assert.equal(mirror, canonical);
  });
});
