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

test('an active measure stays active through its end period and flips to ended after it', () => {
  const endDates = [{ endDate: '2026-10' }, { endDate: '2026-11-24' }, { endDate: '2026-11-25' }, { endDate: '2026-11' }, { endDate: '2027-01' }];
  assert.deepEqual(buildPayload(fixture(endDates), NOW).policies.map((p) => p.status), ['ended', 'ended', 'active', 'active', 'active']);
  const december = new Date('2026-12-01T00:00:00Z');
  assert.deepEqual(buildPayload(fixture([{ endDate: '2026-11' }, { endDate: '2026-11-30' }]), december).policies.map((p) => p.status), ['ended', 'ended']);
});

test('a malformed or impossible end date fails the seed instead of publishing a guessed status', () => {
  for (const endDate of ['30 April', '2026-00', '2026-13', '2026-02-30']) {
    assert.throws(() => buildPayload(fixture([{ endDate }]), NOW), /Invalid endDate/, endDate);
  }
});

test('announcement dates are sourced or left unknown, never a shared placeholder', () => {
  assert.equal(find('Australia', 'Cut fuel excise duty').dateAnnounced, '2026-03-30');
  assert.equal(payload.policies.filter((p) => p.dateAnnounced === '2026-04-07').length, 0);
  for (const dateAnnounced of ['April 7', '2026-02-30', '2026-99-99']) {
    assert.equal(validateFn(buildPayload(fixture(Array(10).fill({ dateAnnounced })), NOW)), false, dateAnnounced);
  }
  assert.equal(validateFn(buildPayload(fixture(Array(10).fill({ dateAnnounced: '2026-02-28' })), NOW)), true);
});

test('tax incentives are classified under the Taxation sector', () => {
  assert.equal(find('Cambodia', 'Reductions in import taxes').sector, 'Taxation');
  assert.equal(find('Spain', 'Reduce personal income tax').sector, 'Taxation');
  assert.equal(find('Spain', 'Reduce personal income tax').category, 'conservation');
});

test('updatedAt reports when statuses were reviewed, not when the seed ran', () => {
  assert.equal(payload.updatedAt, '2026-11-18T12:00:00.000Z');
});

test('the review date renders as the same calendar day across viewer time zones', () => {
  for (const timeZone of ['Pacific/Honolulu', 'America/Los_Angeles', 'UTC', 'Asia/Kolkata', 'Asia/Tokyo']) {
    assert.equal(new Date(payload.updatedAt).toLocaleDateString('en-CA', { timeZone }), '2026-11-18', timeZone);
  }
});
