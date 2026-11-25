import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, validateFn } from '../scripts/seed-energy-crisis-policies.mjs';

const NOW = new Date('2026-11-25T00:00:00Z');
const payload = buildPayload(undefined, NOW);
const find = (country, measure) => payload.policies.find((p) => p.country === country && p.measure.startsWith(measure));

const fixture = (policies) => ({
  source: 'IEA', sourceUrl: 'https://example.test', context: '', statusReviewedAt: '2026-11-18',
  policies: policies.map((p) => ({ country: 'Japan', countryCode: 'JP', category: 'consumer_support', sector: 'Taxation', measure: 'Cut fuel tax', status: 'active', dateAnnounced: '', ...p })),
});

test('seeded registry passes validation', () => {
  assert.ok(validateFn(payload));
});

test('measures the IEA tracker lists as phased out are published as ended', () => {
  assert.equal(find('Australia', 'Cut fuel excise duty').status, 'ended');
  assert.equal(find('Türkiye', 'Lower fuel tax on oil').status, 'ended');
});

test('no published measure advertises a time limit that has already lapsed', () => {
  assert.equal(find('Viet Nam', 'Cut fuel import tariffs').measure, 'Cut fuel import tariffs and suspend fuel tax');
  for (const p of payload.policies.filter((x) => x.status === 'active')) {
    assert.doesNotMatch(p.measure, /until (30 April|May)|for two months/, `${p.country}: ${p.measure}`);
  }
});

test('an active measure flips to ended once its end date passes', () => {
  const { policies } = buildPayload(fixture([{ endDate: '2026-10' }, { endDate: '2026-11-30' }, { endDate: '2027-01' }]), NOW);
  assert.deepEqual(policies.map((p) => p.status), ['ended', 'active', 'active']);
  assert.equal(buildPayload(fixture([{ endDate: '2026-11-30' }]), new Date('2026-12-01T00:00:00Z')).policies[0].status, 'ended');
});

test('a malformed end date fails the seed instead of publishing a guessed status', () => {
  assert.throws(() => buildPayload(fixture([{ endDate: '30 April' }]), NOW), /Invalid endDate/);
});

test('announcement dates are sourced or left unknown, never a shared placeholder', () => {
  assert.equal(find('Australia', 'Cut fuel excise duty').dateAnnounced, '2026-03-30');
  assert.equal(payload.policies.filter((p) => p.dateAnnounced === '2026-04-07').length, 0);
  assert.equal(validateFn(buildPayload(fixture(Array(10).fill({ dateAnnounced: 'April 7' })), NOW)), false);
});

test('tax incentives are classified under the Taxation sector', () => {
  assert.equal(find('Cambodia', 'Reductions in import taxes').sector, 'Taxation');
  assert.equal(find('Spain', 'Reduce personal income tax').sector, 'Taxation');
  assert.equal(find('Spain', 'Reduce personal income tax').category, 'conservation');
});

test('updatedAt reports when statuses were reviewed, not when the seed ran', () => {
  assert.equal(payload.updatedAt, '2026-11-18T00:00:00.000Z');
});
