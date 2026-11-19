import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractCableShipName,
  isCableRelatedNotice,
  isFreshNotice,
  NGA_CABLE_NOTICE_MAX_AGE_DAYS,
} from '../shared/nga-cable-notices.ts';
import { processNgaSignals } from '../server/worldmonitor/infrastructure/v1/get-cable-health.ts';

// Real NGA HYDROPAC 2939/23 text (Persian Gulf, Bahrain).
const BAHRAIN_MV = `PERSIAN GULF.
BAHRAIN.
DNC 10.
1. CABLE OPERATIONS IN PROGRESS UNTIL FURTHER NOTICE
   BY M/V HALL-1, M/V ABS, OCEAN-10 BARGE,
   M/V OCEAN CAT AND TUG OCEAN ALONG TRACKLINE JOINING
   25-46.59N 050-37.04E, 25-47.89N 050-34.07E,
   25-44.47N 050-37.68E, 25-42.04N 050-44.08E,
   25-41.95N 050-45.27E.
   500 METER BERTH REQUESTED.`;

// Real NGA HYDROLANT 827/24 text: a seismic streamer survey, not cable work.
const SEISMIC = `IRISH SEA.
ENGLAND.
DNC 20.
SURVEY OPERATIONS IN PROGRESS UNTIL
FURTHER NOTICE BY M/V SW AMUNDSEN
TOWING SEVEN 2200 METER LONG CABLES
IN AREA BOUND BY
54-04.00N 003-46.00W, 53-54.00N 003-23.00W.`;

const NOW = Date.UTC(2026, 9, 20, 4, 0);
const DAY = 86_400_000;

describe('NGA cable notices — ship matcher', () => {
  it('catches M/V vessels in cable-operations warnings', () => {
    assert.equal(isCableRelatedNotice(BAHRAIN_MV), true);
    assert.equal(extractCableShipName(BAHRAIN_MV), 'HALL-1');
  });

  it('still catches CABLESHIP / CABLE SHIP names', () => {
    assert.equal(extractCableShipName('CABLESHIP LEON THEVENIN ON STATION'), 'LEON THEVENIN');
    assert.equal(extractCableShipName('CABLE SHIP ILE DE BATZ REPAIRING SUBMARINE CABLE'), 'ILE DE BATZ');
  });

  it('recognizes fiber-optic repair vessels and emits repair activity', () => {
    const notice = BAHRAIN_MV.replace('CABLE OPERATIONS', 'FIBER OPTIC REPAIR');
    assert.equal(isCableRelatedNotice(notice), true);
    assert.equal(extractCableShipName(notice), 'HALL-1');
    assert.ok(processNgaSignals([{ text: notice, issueDate: '181200Z OCT 2026' }], NOW)
      .some(signal => signal.kind === 'repair_activity'));
  });

  it('stops generic vessel names before operational wording', () => {
    assert.equal(extractCableShipName('CABLE REPAIR BY M/V LEON THEVENIN ON STATION'), 'LEON THEVENIN');
  });

  for (const suffix of ['IN AREA BOUND BY', 'ALONG TRACKLINE JOINING']) {
    it(`stops generic vessel names before ${suffix}`, () => {
      assert.equal(extractCableShipName(`CABLE REPAIR BY M/V NEXUS ${suffix}`), 'NEXUS');
    });
  }

  it('ignores seismic survey vessels towing streamer cables', () => {
    assert.equal(isCableRelatedNotice(SEISMIC), false);
    assert.equal(extractCableShipName(SEISMIC), null);
  });

  it('does not treat M/V as a cable ship without cable-work wording', () => {
    assert.equal(extractCableShipName('M/V EVER GIVEN AGROUND NEAR CABLE AREA'), null);
  });

  it('rejects grounding notices whose only cable reference is a location', () => {
    assert.equal(isCableRelatedNotice('M/V EVER GIVEN AGROUND NEAR CABLE AREA'), false);
    assert.equal(isCableRelatedNotice('M/V EVER GIVEN DAMAGED WITHIN CABLE AREAS'), false);
  });

  it('does not emit an advisory for an incidental reference even when a cable name matches', () => {
    const signals = processNgaSignals([{
      text: 'M/V EVER GIVEN AGROUND NEAR CABLE AREA. MAREA.', issueDate: '181200Z OCT 2026',
    }], NOW);
    assert.deepEqual(signals, []);
  });

  it('keeps cable work and fault or damage subjects alongside location references', () => {
    for (const text of [
      'CABLE OPERATIONS IN CABLE AREA',
      'FAULT REPORTED ON SUBMARINE CABLE MAREA',
      'CABLE DAMAGE REPORTED IN CABLE AREA NEAR MAREA',
      'DAMAGE TO MAREA CABLE IN CABLE AREA',
    ]) assert.equal(isCableRelatedNotice(text), true, text);
    assert.ok(processNgaSignals([{
      text: 'FAULT REPORTED ON SUBMARINE CABLE MAREA', issueDate: '181200Z OCT 2026',
    }], NOW).some(signal => signal.kind === 'operator_fault'));
  });
});

describe('NGA cable notices — staleness', () => {
  it('rejects undated and old notices', () => {
    assert.equal(isFreshNotice(0, NOW), false);
    assert.equal(isFreshNotice(Number.NaN, NOW), false);
    assert.equal(isFreshNotice(NOW - (NGA_CABLE_NOTICE_MAX_AGE_DAYS + 1) * DAY, NOW), false);
    assert.equal(isFreshNotice(NOW - 2 * DAY, NOW), true);
  });

  it('allows five minutes of clock skew but rejects future-dated warnings', () => {
    assert.equal(isFreshNotice(NOW + 5 * 60_000, NOW), true);
    assert.equal(isFreshNotice(NOW + 6 * 60_000, NOW), false);
    assert.equal(isFreshNotice(NOW + DAY, NOW), false);
    assert.deepEqual(processNgaSignals([{ text: BAHRAIN_MV, issueDate: '200500Z OCT 2026' }], NOW), []);
  });

  it('processNgaSignals drops stale notices and keeps fresh M/V cable operations as repair activity', () => {
    const stale = processNgaSignals([{ text: BAHRAIN_MV, issueDate: '132159Z SEP 2023' }], NOW);
    assert.equal(stale.length, 0);

    const fresh = processNgaSignals([{ text: BAHRAIN_MV, issueDate: '181200Z OCT 2026' }], NOW);
    assert.ok(fresh.some(s => s.kind === 'repair_activity'), 'fresh M/V cable operations count as repair activity');

    const seismic = processNgaSignals([{ text: SEISMIC, issueDate: '181200Z OCT 2026' }], NOW);
    assert.equal(seismic.length, 0);
  });
});
