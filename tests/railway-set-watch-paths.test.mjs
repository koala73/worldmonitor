import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExpectedServiceConfig,
  sameMembers,
} from '../scripts/railway-set-watch-paths.mjs';

describe('railway seed service config', () => {
  it('adds the resilience static service override with cron and country source files', () => {
    const config = buildExpectedServiceConfig('seed-resilience-static');

    assert.equal(config.startCommand, 'node seed-resilience-static.mjs');
    assert.equal(config.cronSchedule, '0 */4 1-3 10 *');
    assert.equal(
      sameMembers(config.watchPatterns, [
        'scripts/seed-resilience-static.mjs',
        'scripts/_seed-utils.mjs',
        'scripts/_country-resolver.mjs',
        'scripts/package.json',
        'shared/**',
        'scripts/shared/**',
        'public/data/countries.geojson',
      ]),
      true,
    );
  });

  it('keeps shared-config seed services on shared watch patterns', () => {
    const config = buildExpectedServiceConfig('seed-market-quotes');
    assert.equal(config.startCommand, 'node seed-market-quotes.mjs');
    assert.equal(sameMembers(config.watchPatterns, [
      'scripts/seed-market-quotes.mjs',
      'scripts/_seed-utils.mjs',
      'scripts/package.json',
      'scripts/shared/**',
      'shared/**',
    ]), true);
  });

  it('adds the regulatory actions service override with 2h cron', () => {
    const config = buildExpectedServiceConfig('seed-regulatory-actions');

    assert.equal(config.startCommand, 'node seed-regulatory-actions.mjs');
    assert.equal(config.cronSchedule, '0 */2 * * *');
    assert.equal(
      sameMembers(config.watchPatterns, [
        'scripts/seed-regulatory-actions.mjs',
        'scripts/_seed-utils.mjs',
        'scripts/package.json',
      ]),
      true,
    );
  });

  it('compares watch patterns as sets instead of mutating caller arrays', () => {
    const left = ['b', 'a'];
    const right = ['a', 'b'];
    assert.equal(sameMembers(left, right), true);
    assert.deepEqual(left, ['b', 'a']);
    assert.deepEqual(right, ['a', 'b']);
  });
});
