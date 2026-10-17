import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARMS, armLabels, latinRows, scoreArms, verdict } from '../scripts/lib/jev-heldout.mjs';

const answer = (l, pAlert, worsening, violence, commentary) => ({ level: { l, levelConf: 0.9, pAlert }, noul: { worsening, violence, commentary } });
const row = (title, judge, borderline = false) => ({ title, judge, borderline });

const rows = [
  row('Troops foil attacks in Borno, kill four', 'high'),
  row('Ceasefire holds as talks resume', 'high'),
  row('Ebola outbreak passes its peak', 'medium'),
  row('The Guardian view on the war', 'info'),
  row('Удар по Киеву', 'high'),
  row('Strait of Hormuz closed', 'critical'),
  row('Border clashes flare again', 'high', true),
  row('Port blockade lifted', 'low'),
];
const jev = {
  'Troops foil attacks in Borno, kill four': answer('high', 0.9, 0.1, 0.8, 0),
  'Ceasefire holds as talks resume': answer('high', 0.9, 0.05, 0.1, 0),
  'Ebola outbreak passes its peak': answer('high', 0.9, 0.05, 0.1, 0),
  'The Guardian view on the war': answer('critical', 0.95, 0.9, 0.9, 0.8),
  'Strait of Hormuz closed': { level: null, noul: null },
  'Border clashes flare again': answer('high', 0.5, 0.9, 0.9, 0),
  'Port blockade lifted': { level: { l: 'high', levelConf: 0.9, pAlert: 0.9 }, noul: null },
};
const relay = {
  'Troops foil attacks in Borno, kill four': 'high',
  'Ceasefire holds as talks resume': 'high',
  'Ebola outbreak passes its peak': 'high',
  'The Guardian view on the war': 'info',
  'Удар по Киеву': 'high',
  'Strait of Hormuz closed': 'high',
  'Border clashes flare again': 'medium',
  'Port blockade lifted': 'high',
};
const relayRuns = { 'relay-after': relay, 'relay-after-rerun': relay };
const pick = ({ alertLevel, missed, falseAlerts, unlabelledAlerts }) => ({ alertLevel, missed, falseAlerts, unlabelledAlerts });
const arm = (name) => ARMS.find((a) => a.name === name);

describe('Jev held-out scoring', () => {
  it('drops non-Latin titles', () => {
    assert.deepEqual(rows.filter((r) => !latinRows(rows).includes(r)).map((r) => r.title), ['Удар по Киеву']);
  });

  it('labels each arm, giving an unanswered title the relay label', () => {
    const labels = armLabels(arm('jev-veto'), jev, relay);
    assert.equal(labels['Troops foil attacks in Borno, kill four'], 'high');
    assert.equal(labels['Ceasefire holds as talks resume'], 'info');
    assert.equal(labels['The Guardian view on the war'], 'info');
    assert.equal(labels['Strait of Hormuz closed'], 'high');
    assert.equal(armLabels(arm('jev-veto'), jev, {})['Strait of Hormuz closed'], null);
    assert.equal(armLabels(arm('jev-veto'), { t: null }, { t: 'medium' }).t, 'medium');
  });

  it('treats a missing Noul as unanswered for jev-veto only', () => {
    const title = 'Port blockade lifted';
    const fallback = { [title]: 'low' };
    assert.equal(armLabels(arm('jev-argmax'), jev, fallback)[title], 'high');
    assert.equal(armLabels(arm('jev-v1'), jev, fallback)[title], 'high');
    assert.equal(armLabels(arm('jev-veto'), jev, fallback)[title], 'low');
  });

  it('scores every arm on the Latin full and clear-cut slices', () => {
    const s = scoreArms(rows, { 'jev-1': jev }, relayRuns);
    assert.deepEqual(pick(s['jev-argmax']['jev-1'].full), { alertLevel: 4, missed: 0, falseAlerts: 3, unlabelledAlerts: 0 });
    assert.deepEqual(pick(s['jev-v1']['jev-1'].full), { alertLevel: 4, missed: 1, falseAlerts: 3, unlabelledAlerts: 0 });
    assert.deepEqual(pick(s['jev-veto']['jev-1'].full), { alertLevel: 4, missed: 2, falseAlerts: 1, unlabelledAlerts: 0 });
    assert.deepEqual(pick(s['jev-veto']['jev-1'].clearCut), { alertLevel: 3, missed: 1, falseAlerts: 1, unlabelledAlerts: 0 });
    assert.deepEqual(ARMS.map((a) => s[a.name]['jev-1'].unanswered), [1, 1, 2]);
    assert.deepEqual(pick(s.relay['relay-after'].full), { alertLevel: 4, missed: 1, falseAlerts: 2, unlabelledAlerts: 0 });
    assert.deepEqual(pick(s.relay['relay-after'].clearCut), { alertLevel: 3, missed: 0, falseAlerts: 2, unlabelledAlerts: 0 });
  });

  it('falls back to the relay run paired with each Jev run', () => {
    const rerun = { ...relay, 'Strait of Hormuz closed': 'medium' };
    const s = scoreArms(rows, { 'jev-1': jev, 'jev-2': jev }, { 'relay-after': relay, 'relay-after-rerun': rerun });
    assert.equal(s['jev-veto']['jev-1'].full.missed, 2);
    assert.equal(s['jev-veto']['jev-2'].full.missed, 3);
  });

  it('refuses a Jev run with no paired relay run', () => {
    assert.throws(() => scoreArms(rows, { a: jev }, relayRuns), /no paired relay run/);
    assert.throws(() => scoreArms(rows, { 'jev-2': jev }, { 'relay-after': relay }), /no paired relay run/);
  });

  it('feeds verdict end to end', () => {
    const v = verdict(scoreArms(rows, { 'jev-1': jev, 'jev-2': jev }, relayRuns));
    assert.equal(v.pass, false);
    assert.deepEqual(v.slices.full.reasons, ['worst jev-veto run missed 2, worst relay run 1']);
    assert.equal(v.slices.full.jevWorstPrecision, 2 / 3);
    assert.equal(v.slices.full.relayBestPrecision, 0.6);
  });
});
