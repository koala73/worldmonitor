import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { isUtcIsoInstant, validateHealthProbeCutovers } from '../scripts/check-health-probe-cutovers.mts';

const TEST_WORKFLOW_URL = new URL('../.github/workflows/test.yml', import.meta.url);
const PRE_PUSH_HOOK_URL = new URL('../.husky/pre-push', import.meta.url);
const PR_TEMPLATE_URL = new URL('../.github/pull_request_template.md', import.meta.url);

describe('health-probe cutover enforcement', () => {
  const baseSeedMeta = {
    tariffTrendsUs: { key: 'seed-meta:economic:tariff-trends-us' },
    unchanged: { key: 'seed-meta:unchanged', maxStaleMin: 60 },
  };
  const wiring = {
    activationMarkers: { physicalPremiums: 'seed-activated:market:physical-premium' },
    onDemandKeys: new Set(['physicalPremiums']),
    standaloneKeys: { physicalPremiums: 'market:physical-premium:v1' },
  };

  it('fails a new or repointed probe without machine-readable cutover evidence', () => {
    assert.throws(
      () => validateHealthProbeCutovers({
          ...wiring,
        baseSeedMeta,
        headSeedMeta: { ...baseSeedMeta, tariffTrendsUs: { key: 'seed-meta:trade:tariffs' } },
      }),
      /tariffTrendsUs.*pre-seed.*activation marker/i,
    );
  });

  it('accepts pre-seed evidence bound to the exact key transition', () => {
    const cutover = {
      mode: 'preseed',
      fromKey: 'seed-meta:economic:tariff-trends-us',
      issue: 6377,
      verifiedAt: '2026-08-10T09:00:00.000Z',
      evidence: {
        platform: 'railway',
        service: 'seed-supply-chain-trade',
        probeKey: 'seed-meta:trade:tariffs',
        compactHealthStatus: 'OK',
        reference: 'https://github.com/koala73/worldmonitor/issues/6377#issuecomment-1',
      },
    };
    const headSeedMeta = { ...baseSeedMeta, tariffTrendsUs: { key: 'seed-meta:trade:tariffs', cutover } };
    const withCutover = (patch) => ({
      ...headSeedMeta,
      tariffTrendsUs: { ...headSeedMeta.tariffTrendsUs, cutover: { ...cutover, ...patch } },
    });

    assert.deepEqual(
      validateHealthProbeCutovers({ ...wiring, baseSeedMeta, headSeedMeta }),
      [{ name: 'tariffTrendsUs', fromKey: cutover.fromKey, toKey: 'seed-meta:trade:tariffs', mode: 'preseed' }],
    );
    assert.throws(
      () => validateHealthProbeCutovers({
          ...wiring,
        baseSeedMeta: { ...baseSeedMeta, tariffTrendsUs: { key: 'seed-meta:another-old-key' } },
        headSeedMeta,
      }),
      /fromKey.*seed-meta:another-old-key/i,
    );
    assert.throws(
      () => validateHealthProbeCutovers({ ...wiring, baseSeedMeta, headSeedMeta: withCutover({ verifiedAt: 'August 10, 2026' }) }),
      /verifiedAt/i,
    );
    assert.throws(
      () => validateHealthProbeCutovers({ ...wiring, baseSeedMeta, headSeedMeta: withCutover({ issue: 'n/a' }) }),
      /owner issue/i,
    );
    for (const evidence of [
      'unstructured',
      { ...cutover.evidence, platform: 'github' },
      { ...cutover.evidence, service: '' },
      { ...cutover.evidence, probeKey: 'seed-meta:wrong' },
      { ...cutover.evidence, compactHealthStatus: 'EMPTY' },
      { ...cutover.evidence, reference: 'http://example.com/evidence' },
    ]) {
      assert.throws(
        () => validateHealthProbeCutovers({ ...wiring, baseSeedMeta, headSeedMeta: withCutover({ evidence }) }),
        /Railway.*service.*probe.*compact health OK.*HTTPS/i,
      );
    }
  });

  it('accepts a durable activation marker bound to the new probe', () => {
    const activationKey = 'seed-activated:market:physical-premium';
    const headSeedMeta = {
      ...baseSeedMeta,
      physicalPremiums: {
        key: 'seed-meta:market:physical-premium',
        activationKey,
        cutover: { mode: 'activation-marker', fromKey: null, issue: 6436, activationKey },
      },
    };

    assert.doesNotThrow(() => validateHealthProbeCutovers({ ...wiring, baseSeedMeta, headSeedMeta }));
    for (const badActivationKey of ['', 'market:physical-premium', 'seed-activated:market:other']) {
      assert.throws(
        () => validateHealthProbeCutovers({
          ...wiring,
          baseSeedMeta,
          headSeedMeta: {
            ...headSeedMeta,
            physicalPremiums: {
              ...headSeedMeta.physicalPremiums,
              cutover: { ...headSeedMeta.physicalPremiums.cutover, activationKey: badActivationKey },
            },
          },
        }),
        /activation-marker.*config\.activationKey.*seed-activated/i,
      );
    }
    for (const [label, unwired] of [
      ['no marker registration', { ...wiring, activationMarkers: {} }],
      ['a different registered marker', { ...wiring, activationMarkers: { physicalPremiums: 'seed-activated:market:other' } }],
      ['not on-demand', { ...wiring, onDemandKeys: new Set() }],
      ['a bootstrap probe', { ...wiring, standaloneKeys: {} }],
      ['no wiring passed', { activationMarkers: undefined, onDemandKeys: undefined, standaloneKeys: undefined }],
    ]) {
      assert.throws(
        () => validateHealthProbeCutovers({ baseSeedMeta, headSeedMeta, ...unwired }),
        /ACTIVATION_MARKERS\.physicalPremiums.*ON_DEMAND_KEYS.*STANDALONE_KEYS/,
        label,
      );
    }
  });

  it('rejects the retired expiring-acknowledgement mode', () => {
    assert.throws(
      () => validateHealthProbeCutovers({
          ...wiring,
        baseSeedMeta,
        headSeedMeta: {
          ...baseSeedMeta,
          tariffTrendsUs: {
            key: 'seed-meta:trade:tariffs',
            cutover: { mode: 'expiring-ack', fromKey: 'seed-meta:economic:tariff-trends-us', issue: 6377, status: 'EMPTY' },
          },
        },
      }),
      /cutover mode must be preseed or activation-marker/,
    );
  });

  it('ignores probes whose key did not change', () => {
    assert.deepEqual(validateHealthProbeCutovers({ ...wiring, baseSeedMeta, headSeedMeta: baseSeedMeta }), []);
  });

  it('accepts only real ISO calendar instants with an explicit timezone', () => {
    for (const value of ['2026-08-10T09:00:00Z', '2026-08-10T09:00:00.123Z', '2024-02-29T00:00:00+05:30']) {
      assert.equal(isUtcIsoInstant(value), true, value);
    }
    for (const value of [
      '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-08-10T24:00:00Z',
      '2026-08-10T09:00:00', '2026-08-10', 'August 10, 2026', 1_786_000_000_000, null,
    ]) {
      assert.equal(isUtcIsoInstant(value), false, String(value));
    }
  });

  it('runs in the pull-request workflow and the pre-push hook, and the PR template names both proofs', () => {
    const workflow = readFileSync(TEST_WORKFLOW_URL, 'utf8');
    const hook = readFileSync(PRE_PUSH_HOOK_URL, 'utf8');
    const template = readFileSync(PR_TEMPLATE_URL, 'utf8');

    assert.match(workflow, /node --import tsx scripts\/check-health-probe-cutovers\.mts/);
    assert.match(hook, /changed '[^']*scripts\/check-health-probe-cutovers\\\.mts/);
    assert.match(template, /Railway-side pre-seed/i);
    assert.match(template, /durable activation marker/i);
    assert.doesNotMatch(template, /expiresAt/);
  });
});
