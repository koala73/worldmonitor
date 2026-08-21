import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SOURCE_PROPAGANDA_RISK,
  SOURCE_TYPES,
} from '../shared/source-provenance.ts';
import { SOURCE_TIERS } from '../server/_shared/source-tiers.ts';
import { X_ACCOUNT_SOURCE_TIERS, X_ACCOUNT_TRUST } from '../shared/x-account-trust.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const xNews = require('../scripts/lib/x-news-accounts.cjs');
const registry = JSON.parse(readFileSync(join(__dirname, '../data/x-accounts.json'), 'utf8'));
const rssSourceTiers = JSON.parse(readFileSync(join(__dirname, '../shared/source-tiers.json'), 'utf8'));
const healthSrc = readFileSync(join(__dirname, '../api/health.js'), 'utf8');
const relaySrc = readFileSync(join(__dirname, '../scripts/ais-relay.cjs'), 'utf8');

function enabledSourceNames() {
  return [...new Set(
    [...registry.channels.full, ...registry.channels.tech, ...registry.channels.finance]
      .filter((account) => account.enabled)
      .map((account) => account.sourceName),
  )].sort();
}

describe('X news-account public trust registries (#6654)', () => {
  it('registers every enabled X sourceName in the public trust registries', () => {
    const missing = [];
    for (const name of enabledSourceNames()) {
      if (!Object.prototype.hasOwnProperty.call(SOURCE_TYPES, name)) missing.push(`type:${name}`);
      if (!Object.prototype.hasOwnProperty.call(SOURCE_PROPAGANDA_RISK, name)) missing.push(`risk:${name}`);
      if (!Object.prototype.hasOwnProperty.call(SOURCE_TIERS, name)) missing.push(`tier:${name}`);
    }
    assert.deepEqual(missing, [], `X accounts missing from public trust registries:\n${missing.join('\n')}`);
  });

  it('does not place enabled X accounts in the explicit tier-4 set the relay drops', () => {
    const explicitTier4 = new Set(
      Object.entries(SOURCE_TIERS).filter(([, tier]) => tier === 4).map(([name]) => name),
    );
    const dropped = enabledSourceNames().filter((name) => explicitTier4.has(name) || SOURCE_TIERS[name] === 4);
    assert.deepEqual(dropped, [], `enabled X accounts would be dropped by RELAY_TIER4_SOURCES: ${dropped.join(', ')}`);
    for (const name of Object.keys(X_ACCOUNT_SOURCE_TIERS)) {
      assert.notEqual(X_ACCOUNT_SOURCE_TIERS[name], 4, `${name} overlay must not be tier 4`);
    }
  });

  it('keeps additive X tiers out of the canonical RSS tier JSON', () => {
    const additiveEntries = X_ACCOUNT_TRUST.filter((entry) => !entry.reuseTier);
    assert.deepEqual(
      Object.keys(X_ACCOUNT_SOURCE_TIERS).sort(),
      additiveEntries.map((entry) => entry.sourceName).sort(),
    );
    for (const entry of additiveEntries) {
      assert.equal(rssSourceTiers[entry.sourceName], undefined, `${entry.sourceName} must come from the X overlay`);
      assert.equal(X_ACCOUNT_SOURCE_TIERS[entry.sourceName], entry.tier);
    }
  });

  it('lets live X items reach the classify/alert injection path', () => {
    const now = Date.parse('2026-08-18T12:05:00.000Z');
    const items = enabledSourceNames().map((sourceName, index) => xNews.normalizeXPost({
      id: String(1000 + index),
      text: `SECRET BODY ${sourceName} must not enter alerts`,
      created_at: '2026-08-18T12:00:00.000Z',
    }, {
      handle: 'Example',
      accountId: String(index + 1),
      label: sourceName,
      sourceName,
      topic: 'breaking',
    }));
    const candidates = xNews.collectXAlertCandidates(items, SOURCE_TIERS, now);
    assert.equal(candidates.length, enabledSourceNames().length);
    const candidateSources = new Set(candidates.map((item) => item.source));
    for (const name of enabledSourceNames()) {
      assert.equal(xNews.alertSourcePassesTierGate(name, SOURCE_TIERS), true, `${name} must pass the alert tier gate`);
      assert.ok(candidateSources.has(name), `${name} missing from collectXAlertCandidates`);
    }
    assert.doesNotMatch(JSON.stringify(candidates), /SECRET BODY/);
  });

  it('still drops explicit tier-4 and deleted X items from the alert path', () => {
    const account = { handle: 'Reuters', accountId: '1652541', label: 'Reuters', sourceName: 'Reuters', topic: 'breaking' };
    const live = xNews.normalizeXPost({
      id: '1',
      text: 'keep',
      created_at: '2026-08-18T12:00:00.000Z',
    }, account);
    const deleted = xNews.tombstonePosts([
      xNews.normalizeXPost({
        id: '2',
        text: 'gone',
        created_at: '2026-08-18T12:00:00.000Z',
      }, account),
    ], ['2'], Date.parse('2026-08-18T12:01:00.000Z'))[0];
    const aggregator = xNews.normalizeXPost({
      id: '3',
      text: 'tier4',
      created_at: '2026-08-18T12:00:00.000Z',
    }, { ...account, sourceName: 'Synthetic Aggregator' });
    const candidates = xNews.collectXAlertCandidates(
      [live, deleted, aggregator],
      { ...SOURCE_TIERS, 'Synthetic Aggregator': 4 },
      Date.parse('2026-08-18T12:05:00.000Z'),
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].source, 'Reuters');
  });

  it('registers the ais-relay health probe and seed-meta key', () => {
    assert.match(healthSrc, /xFeed:\s+'intelligence:x-feed:v1'/);
    assert.match(healthSrc, /key: 'seed-meta:intelligence:x-feed:v1'/);
    assert.match(relaySrc, /intelligence:x-feed:v1/);
    assert.match(relaySrc, /seed-meta:intelligence:x-feed:v1/);
    // The probe's `cutover` declaration is retired along with the baseline ack
    // below: the two are halves of one statement ("this key is allowed to be
    // absent while the producer is brought up"), and leaving the health.js half
    // behind left the config asserting a deploy window that had closed, under a
    // comment claiming X_BEARER_TOKEN was still unprovisioned. It is on
    // ais-relay and the key is served, so both halves go.
    assert.doesNotMatch(
      healthSrc,
      /xFeed:[^\n]*cutover/,
      'the xFeed cutover is complete — a lingering declaration re-opens a closed deploy window',
    );
    // The EMPTY acknowledgement was scoped to the deploy window before the
    // first ais-relay poll. That poll has happened — production has served
    // seed-meta:intelligence:x-feed:v1 since generation 1 — so the entry is
    // spent and is removed rather than left to lapse. An ack only suppresses
    // an exact name:status match, so it never covered the SEED_ERROR the
    // unpollable accounts were actually producing; keeping it past its window
    // would have added an expired entry that reds the scheduled monitor while
    // still passing the PR gate.
    const baseline = JSON.parse(readFileSync(join(__dirname, '../scripts/seed-freshness-baseline.json'), 'utf8'));
    assert.equal(
      baseline.acknowledged.find((row) => row.name === 'xFeed'),
      undefined,
      'the xFeed cutover ack is spent — the producer is live, so EMPTY is now a real fault',
    );
  });
});
