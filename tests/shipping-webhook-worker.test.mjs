import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { THREAT_LEVEL, aisComponent, warningComponent } from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';

import { fakeRedis } from './_lib/fake-webhook-redis.mjs';
import {
  BACKFILL_CURSOR_KEY,
  CHOKEPOINT_STATUS_KEY,
  CHOKEPOINT_STATUS_RPC_URL,
  LOCK_KEY,
  LOCK_RENEW_SCRIPT,
  RECORD_CAS_SCRIPT,
  RISK_SCORES_KEY,
  RISK_SCORES_STALE_KEY,
  RISK_SURGE_RULE,
  SCORE_SOURCE_MAX_POINTS,
  THREAT_POINTS_BY_TIER,
  WORKER_ACTIVATION_KEY,
  WORKER_META_KEY,
  WORKER_STATUS_KEY,
  countryStateField,
  liveSignal,
  nextChokepointState,
  nextCountryState,
  planTick,
  reasonFor,
  runTick,
  stateKey,
} from '../scripts/shipping-webhook-worker.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

function chokepoint(id, disruptionScore, extra = {}) {
  return {
    id,
    name: `${id} name`,
    disruptionScore,
    status: 'yellow',
    activeWarnings: 0,
    aisDisruptions: 0,
    congestionLevel: 'normal',
    warRiskTier: 'WAR_RISK_TIER_NORMAL',
    navigationalWarningsAvailable: true,
    aisSnapshotAvailable: true,
    transitSummary: { todayCountsAvailable: true, wowChangePct: -3, dataAvailable: true },
    ...extra,
  };
}

function record(overrides = {}) {
  return {
    subscriberId: 'wh_aaaaaaaaaaaaaaaaaaaaaaaa',
    ownerTag: 'owner',
    callbackUrl: 'https://hooks.example.com/wm',
    chokepointIds: ['suez'],
    alertThreshold: 60,
    createdAt: '2026-10-01T00:00:00.000Z',
    active: true,
    secret: 'a'.repeat(64),
    ...overrides,
  };
}

const SUB_ID = record().subscriberId;

function plan(score, state, overrides = {}) {
  const rec = record(overrides);
  return planTick({
    chokepoints: [chokepoint('suez', score), chokepoint('hormuz_strait', 90)],
    records: [rec],
    states: new Map(state ? [[rec.subscriberId, { suez: state }]] : []),
    now: NOW,
    scoresFetchedAt: '2026-10-17T11:58:00.000Z',
    makeId: () => 'whd_fixed',
  });
}

describe('planTick state machine', () => {
  it('fires once for a subscriber first seen above threshold', () => {
    const { deliveries, nextStates } = plan(75);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].deliveryId, 'whd_fixed');
    assert.deepEqual(nextStates.get(record().subscriberId), {
      suez: { armed: true, lastScore: 75, pending: { deliveryId: 'whd_fixed', triggeredAt: '2026-10-17T12:00:00.000Z' } },
    });
  });

  it('does not fire again while the score stays above threshold after a delivery', () => {
    const { deliveries, nextStates } = plan(80, { armed: false, lastScore: 75, lastDeliveredAt: '2026-10-17T11:55:00.000Z' });
    assert.equal(deliveries.length, 0);
    assert.deepEqual(nextStates.get(record().subscriberId).suez, {
      armed: false, lastScore: 80, lastDeliveredAt: '2026-10-17T11:55:00.000Z',
    });
  });

  it('re-arms when the score drops below threshold, then fires on the next rise', () => {
    const dropped = plan(40, { armed: false, lastScore: 80 });
    assert.equal(dropped.deliveries.length, 0);
    assert.equal(dropped.nextStates.get(record().subscriberId).suez.armed, true);
    const risen = plan(70, dropped.nextStates.get(record().subscriberId).suez);
    assert.equal(risen.deliveries.length, 1);
    assert.equal(risen.deliveries[0].payload.details.previousScore, 40);
  });

  it('stays quiet below threshold on first sight and records the armed state', () => {
    const { deliveries, nextStates } = plan(59);
    assert.equal(deliveries.length, 0);
    assert.deepEqual(nextStates.get(record().subscriberId).suez, { armed: true, lastScore: 59 });
  });

  it('fires when the score equals the threshold', () => {
    assert.equal(plan(60).deliveries.length, 1);
  });

  it('retries a still-armed crossing whose last delivery failed', () => {
    assert.equal(plan(75, { armed: true, lastScore: 75 }).deliveries.length, 1);
  });

  it('sends one delivery for a chokepoint listed twice', () => {
    assert.equal(plan(75, null, { chokepointIds: ['suez', 'suez'] }).deliveries.length, 1);
  });

  it('does not re-arm when the missing source could account for the drop', () => {
    const delivered = { armed: false, lastScore: 75, sources: { navigationalWarnings: true, ais: true, transit: true } };
    const dark = planTick({
      chokepoints: [chokepoint('suez', 50, { navigationalWarningsAvailable: false })],
      records: [record()],
      states: new Map([[SUB_ID, { suez: delivered }]]),
      now: NOW,
    });
    assert.deepEqual(dark.nextStates.get(SUB_ID).suez, { ...delivered, lastScore: 50 });
    const recovered = plan(75, dark.nextStates.get(SUB_ID).suez);
    assert.equal(recovered.deliveries.length, 0, 'the same disruption does not fire again');
    const ended = plan(40, recovered.nextStates.get(SUB_ID).suez);
    assert.equal(ended.nextStates.get(SUB_ID).suez.armed, true, 'a real drop with every source present re-arms');
  });

  it('re-arms when the score is below threshold even with every missing source at its maximum', () => {
    const delivered = { armed: false, lastScore: 60, sources: { navigationalWarnings: true, ais: true, transit: true } };
    const ended = planTick({
      chokepoints: [chokepoint('suez', 30, { transitSummary: { dataAvailable: false } })],
      records: [record({ alertThreshold: 50 })],
      states: new Map([[SUB_ID, { suez: delivered }]]),
      now: NOW,
    });
    assert.equal(ended.nextStates.get(SUB_ID).suez.armed, true, '30 + at most 10 from transit cannot reach 50');
    const again = planTick({
      chokepoints: [chokepoint('suez', 60, { transitSummary: { dataAvailable: false } })],
      records: [record({ alertThreshold: 50 })],
      states: new Map([[SUB_ID, { suez: ended.nextStates.get(SUB_ID).suez }]]),
      now: NOW,
    });
    assert.equal(again.deliveries.length, 1);
  });

  it('caps each score source at the points the scoring code gives it', () => {
    assert.equal(SCORE_SOURCE_MAX_POINTS.navigationalWarnings, warningComponent(1000));
    assert.equal(SCORE_SOURCE_MAX_POINTS.ais, aisComponent(3));
    const status = readFileSync(new URL('../server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts', import.meta.url), 'utf8');
    assert.match(status, new RegExp(`anomaly\\.signal \\? ${SCORE_SOURCE_MAX_POINTS.transit} : 0`));
  });

  it('re-arms despite a source that was already missing at delivery', () => {
    const delivered = { armed: false, lastScore: 75, sources: { navigationalWarnings: true, ais: true, transit: false } };
    const { nextStates } = planTick({
      chokepoints: [chokepoint('suez', 40, { transitSummary: { dataAvailable: false } })],
      records: [record()],
      states: new Map([[SUB_ID, { suez: delivered }]]),
      now: NOW,
    });
    assert.equal(nextStates.get(SUB_ID).suez.armed, true);
  });

  it('evaluates only the chokepoints the subscriber chose', () => {
    const { deliveries } = plan(10);
    assert.equal(deliveries.length, 0, 'hormuz_strait at 90 is not subscribed');
    assert.equal(plan(10, null, { chokepointIds: ['suez', 'hormuz_strait'] }).deliveries[0].payload.chokepointId, 'hormuz_strait');
  });

  it('builds the documented payload and details', () => {
    const [delivery] = plan(75, { armed: true, lastScore: 55 }).deliveries;
    assert.deepEqual(delivery.payload, {
      subscriberId: record().subscriberId,
      chokepointId: 'suez',
      score: 75,
      alertThreshold: 60,
      triggeredAt: '2026-10-17T12:00:00.000Z',
      reason: 'score_threshold',
      details: {
        name: 'suez name',
        status: 'yellow',
        activeWarnings: 0,
        aisDisruptions: 0,
        congestionLevel: 'normal',
        warRiskTier: 'WAR_RISK_TIER_NORMAL',
        wowChangePct: -3,
        previousScore: 55,
        scoresFetchedAt: '2026-10-17T11:58:00.000Z',
      },
    });
  });
});

describe('live-signal floor (minLiveSignal)', () => {
  it('pins the standing threat points to _scoring.mjs THREAT_LEVEL', () => {
    assert.deepEqual(THREAT_POINTS_BY_TIER, {
      WAR_RISK_TIER_WAR_ZONE: THREAT_LEVEL.war_zone,
      WAR_RISK_TIER_CRITICAL: THREAT_LEVEL.critical,
      WAR_RISK_TIER_HIGH: THREAT_LEVEL.high,
      WAR_RISK_TIER_ELEVATED: THREAT_LEVEL.elevated,
      WAR_RISK_TIER_NORMAL: THREAT_LEVEL.normal,
    });
    assert.equal(liveSignal(chokepoint('hormuz_strait', 85, { warRiskTier: 'WAR_RISK_TIER_WAR_ZONE' })), 15);
    assert.equal(liveSignal(chokepoint('hormuz_strait', 70, { warRiskTier: 'WAR_RISK_TIER_WAR_ZONE' })), 0);
    assert.equal(liveSignal(chokepoint('x', 12, { warRiskTier: 'WAR_RISK_TIER_UNKNOWN' })), 12);
  });

  const hormuz = (score) => chokepoint('hormuz_strait', score, { warRiskTier: 'WAR_RISK_TIER_WAR_ZONE', status: 'red' });
  const planHormuz = (score, state, minLiveSignal) => planTick({
    chokepoints: [hormuz(score)],
    records: [record({ chokepointIds: ['hormuz_strait'], alertThreshold: 50, minLiveSignal })],
    states: new Map(state ? [[SUB_ID, { hormuz_strait: state }]] : []),
    now: NOW,
    scoresFetchedAt: 'x',
    makeId: () => 'whd_fixed',
  });

  it('a war zone standing at 70 does not fire a threshold-50 subscription with a 15-point live floor', () => {
    const { deliveries, nextStates } = planHormuz(70, undefined, 15);
    assert.equal(deliveries.length, 0);
    assert.deepEqual(nextStates.get(SUB_ID).hormuz_strait, { armed: true, lastScore: 70, lastLive: 0 });
  });

  it('fires once live signals reach the floor and re-arms only when they have clearly subsided', () => {
    const fired = planHormuz(85, undefined, 15);
    assert.equal(fired.deliveries.length, 1);
    assert.equal(fired.deliveries[0].event, 'chokepoint.disruption');
    assert.equal(fired.deliveries[0].stateField, 'hormuz_strait');
    const delivered = { armed: false, lastScore: 85, lastLive: 15, lastDeliveredAt: new Date(NOW - 13 * 3_600_000).toISOString(), sources: { navigationalWarnings: true, ais: true, transit: true } };
    assert.equal(planHormuz(80, delivered, 15).nextStates.get(SUB_ID).hormuz_strait.armed, false, 'live 10 is a wobble, not a subsidence');
    assert.equal(planHormuz(74, delivered, 15).nextStates.get(SUB_ID).hormuz_strait.armed, true, 'live 4 < 5 re-arms');
    assert.equal(planHormuz(85, { ...delivered, armed: true }, 15).deliveries.length, 1, 'armed again, live 15, past the cooldown: fires');
  });

  it('a live signal wobbling around the floor fires once', () => {
    let state;
    let fired = 0;
    for (const [i, score] of [85, 80, 85, 80, 85, 80, 85].entries()) {
      const { deliveries, nextStates } = planHormuz(score, state, 15);
      state = nextStates.get(SUB_ID).hormuz_strait;
      if (deliveries.length) {
        fired += 1;
        state = { ...state, armed: false, lastDeliveredAt: new Date(NOW - (6 - i) * 60_000).toISOString(), sources: { navigationalWarnings: true, ais: true, transit: true } };
      }
    }
    assert.equal(fired, 1);
  });

  it('a re-armed live floor waits out the refire cooldown', () => {
    const rearmed = { armed: true, lastScore: 70, lastLive: 0, lastDeliveredAt: new Date(NOW - 6 * 3_600_000).toISOString() };
    assert.equal(planHormuz(85, rearmed, 15).deliveries.length, 0, '6 h after the last delivery: quiet');
    assert.equal(planHormuz(85, rearmed, 15).nextStates.get(SUB_ID).hormuz_strait.armed, true, 'stays armed through the cooldown');
    const later = { ...rearmed, lastDeliveredAt: new Date(NOW - 12 * 3_600_000).toISOString() };
    assert.equal(planHormuz(85, later, 15).deliveries.length, 1, '12 h after: fires');
  });

  it('with a live floor the score re-arms 10 points under the threshold', () => {
    const delivered = { armed: false, lastScore: 52, lastLive: 22, sources: { navigationalWarnings: true, ais: true, transit: true } };
    const all = { navigationalWarnings: true, ais: true, transit: true };
    assert.equal(nextChokepointState(delivered, 45, 50, all, { live: 15, minLive: 15, nowMs: NOW }).state.armed, false, 'score 45 is within the gap');
    assert.equal(nextChokepointState(delivered, 39, 50, all, { live: 15, minLive: 15, nowMs: NOW }).state.armed, true, 'score 39 < 40 re-arms');
  });

  it('a missing source that could carry the live points keeps the pair disarmed', () => {
    const delivered = { armed: false, lastScore: 85, lastLive: 15, sources: { navigationalWarnings: true, ais: true, transit: true } };
    const { state } = nextChokepointState(delivered, 70, 50, { navigationalWarnings: false, ais: true, transit: true }, { live: 0, minLive: 15, nowMs: NOW });
    assert.equal(state.armed, false, 'warnings feed missing: 15 points could return, do not re-arm');
    const { state: rearmed } = nextChokepointState(delivered, 70, 50, { navigationalWarnings: true, ais: true, transit: true }, { live: 0, minLive: 15, nowMs: NOW });
    assert.equal(rearmed.armed, true);
  });

  it('minLiveSignal 0 keeps the legacy score-only behaviour', () => {
    const { deliveries, nextStates } = planHormuz(70, undefined, 0);
    assert.equal(deliveries.length, 1);
    assert.equal('lastLive' in nextStates.get(SUB_ID).hormuz_strait, false);
    assert.equal(planHormuz(70, undefined, undefined).deliveries.length, 1, 'records without the field behave as before');
  });
});

describe('country.risk_surge state machine', () => {
  const cii = (region, combinedScore, dynamicScore, extra = {}) => ({
    region, combinedScore, dynamicScore, staticBaseline: 50, trend: 'TREND_DIRECTION_RISING',
    components: { newsActivity: 20, ciiContribution: 0, geoConvergence: 0, militaryActivity: 40 },
    computedAt: NOW - 60_000, methodologyVersion: 'v8', advisoryLevel: 'do-not-travel', ...extra,
  });

  it('reads its thresholds from the event registry', () => {
    assert.deepEqual(RISK_SURGE_RULE, { rise: 15, floor: 70, rearmBelow: 5, cooldownMs: 86_400_000 });
  });

  it('fires on a 24h rise at or above the threshold while in the high band', () => {
    assert.equal(nextCountryState(undefined, cii('IR', 84, 24), NOW).fire, true);
    assert.equal(nextCountryState(undefined, cii('IR', 70, 15), NOW).fire, true, 'equal to both bounds fires');
    assert.equal(nextCountryState(undefined, cii('IQ', 65, 15), NOW).fire, false, 'a rise that stays under the high band is not a surge');
    assert.equal(nextCountryState(undefined, cii('DE', 36, 17), NOW).fire, false, 'below the floor is a news blip');
    assert.equal(nextCountryState(undefined, cii('RU', 90, 10), NOW).fire, false, 'below the rise threshold');
    assert.equal(nextCountryState(undefined, cii('RU', 90, 1), NOW).fire, false, 'a flat 90 is standing risk, not a surge');
  });

  it('treats a changed static baseline as an edit, not a surge, and remembers the baseline', () => {
    const first = nextCountryState(undefined, cii('BR', 50, 0), NOW);
    assert.equal(first.state.lastBaseline, 50);
    // Brazil re-levelled 50 -> 70 in one tick in the backtest: the combined
    // score and its 24 h movement both jump, the static baseline moves with it.
    const edited = nextCountryState(first.state, cii('BR', 70, 20, { staticBaseline: 70 }), NOW);
    assert.equal(edited.fire, false);
    assert.equal(edited.state.armed, false, 'disarmed until the movement settles');
    assert.equal(edited.state.lastBaseline, 70);
    const settled = nextCountryState(edited.state, cii('BR', 70, 2, { staticBaseline: 70 }), NOW);
    assert.equal(settled.state.armed, true);
    const realSurge = nextCountryState(settled.state, cii('BR', 88, 18, { staticBaseline: 70 }), NOW);
    assert.equal(realSurge.fire, true, 'a later rise on the new baseline fires');
    assert.equal(nextCountryState(undefined, cii('IR', 84, 24, { staticBaseline: undefined }), NOW).fire, true, 'a feed without a baseline cannot be guarded and keeps firing');
  });

  it('once disarmed it stays quiet until the 24h movement falls under the re-arm level', () => {
    const disarmed = { armed: false, lastScore: 84, lastDelta: 24, lastDeliveredAt: new Date(NOW - 3_600_000).toISOString() };
    const stillUp = nextCountryState(disarmed, cii('IR', 86, 20), NOW);
    assert.equal(stillUp.fire, false);
    assert.equal(stillUp.state.armed, false);
    const settled = nextCountryState(disarmed, cii('IR', 80, 4), NOW);
    assert.equal(settled.state.armed, true);
    assert.equal(settled.fire, false);
    assert.equal(settled.state.lastDeliveredAt, disarmed.lastDeliveredAt);
  });

  it('enforces the 24h cooldown from the last delivery even when armed', () => {
    const recent = { armed: true, lastDeliveredAt: new Date(NOW - 23 * 3_600_000).toISOString() };
    assert.equal(nextCountryState(recent, cii('IR', 84, 24), NOW).fire, false);
    const old = { armed: true, lastDeliveredAt: new Date(NOW - 25 * 3_600_000).toISOString() };
    assert.equal(nextCountryState(old, cii('IR', 84, 24), NOW).fire, true);
  });

  it('keeps a pending delivery id across retries and ignores unreadable scores', () => {
    const pending = { armed: true, pending: { deliveryId: 'whd_keep', triggeredAt: 't' } };
    assert.equal(nextCountryState(pending, cii('IR', 84, 24), NOW).state.pending.deliveryId, 'whd_keep');
    const { fire, state } = nextCountryState({ armed: false }, { region: 'IR' }, NOW);
    assert.equal(fire, false);
    assert.deepEqual(state, { armed: false });
  });

  const riskScores = { ciiScores: [cii('IR', 84, 24), cii('UA', 99, 27), cii('DE', 36, 17), cii('RU', 90, 1)] };
  const planRisk = ({ overrides = {}, state, scores = riskScores } = {}) => {
    const rec = record({ eventType: 'country.risk_surge', countries: [], ...overrides });
    return planTick({
      chokepoints: [chokepoint('suez', 75)],
      riskScores: scores,
      records: [rec],
      states: new Map(state ? [[rec.subscriberId, state]] : []),
      now: NOW,
      scoresFetchedAt: 'cp-time',
      riskFetchedAt: '2026-10-17T11:59:00.000Z',
      makeId: () => 'whd_fixed',
    });
  };

  it('plans one delivery per surging country in scope with the documented payload', () => {
    const { deliveries, nextStates } = planRisk();
    assert.deepEqual(deliveries.map((d) => d.payload.countryCode).sort(), ['IR', 'UA']);
    const ir = deliveries.find((d) => d.payload.countryCode === 'IR');
    assert.equal(ir.event, 'country.risk_surge');
    assert.equal(ir.stateField, countryStateField('IR'));
    assert.deepEqual(ir.payload, {
      subscriberId: SUB_ID,
      countryCode: 'IR',
      countryName: 'Iran',
      score: 84,
      previousScore: 60,
      delta24h: 24,
      trend: 'TREND_DIRECTION_RISING',
      advisoryLevel: 'do-not-travel',
      triggeredAt: '2026-10-17T12:00:00.000Z',
      reason: 'risk_surge',
      details: {
        riseThreshold: 15,
        floor: 70,
        staticBaseline: 50,
        components: { newsActivity: 20, ciiContribution: 0, geoConvergence: 0, militaryActivity: 40 },
        methodologyVersion: 'v8',
        computedAt: NOW - 60_000,
        scoresFetchedAt: '2026-10-17T11:59:00.000Z',
      },
    });
    const states = nextStates.get(SUB_ID);
    assert.deepEqual(Object.keys(states).sort(), ['cii:DE', 'cii:IR', 'cii:RU', 'cii:UA'], 'every country in scope records state, not only the firing ones');
    assert.equal(states['cii:DE'].armed, true);
    assert.equal('suez' in states, false, 'a risk-surge record never evaluates chokepoints');
  });

  it('narrows to the subscribed countries and reports the index 24h earlier, not the previous tick', () => {
    const { deliveries } = planRisk({ overrides: { countries: ['UA'] }, state: { 'cii:UA': { armed: true, lastScore: 98 } } });
    assert.deepEqual(deliveries.map((d) => d.payload.countryCode), ['UA']);
    assert.equal(deliveries[0].payload.previousScore, 99 - 27, 'score minus delta24h; the 5-minute-old lastScore would read as a 1-point move');
  });

  it('leaves the state untouched when the feed has no usable 24h movement', () => {
    // deriveCiiTrendDelta reports 0 / UNSPECIFIED with no prior snapshot.
    const delivered = { armed: false, lastScore: 84, lastDelta: 24, lastDeliveredAt: new Date(NOW - 3_600_000).toISOString() };
    const unknown = nextCountryState(delivered, cii('IR', 85, 0, { trend: 'TREND_DIRECTION_UNSPECIFIED' }), NOW);
    assert.equal(unknown.fire, false);
    assert.deepEqual(unknown.state, delivered, 'a placeholder zero must not re-arm a delivered surge');
    assert.equal(nextCountryState(undefined, cii('IR', 85, 0, { trend: 'TREND_DIRECTION_UNSPECIFIED' }), NOW).state.armed, true);
    // A genuine zero movement with a known trend does settle the surge.
    assert.equal(nextCountryState(delivered, cii('IR', 85, 0, { trend: 'TREND_DIRECTION_STABLE' }), NOW).state.armed, true);
  });

  it('leaves chokepoint records untouched when the chokepoint feed is unreadable, while risk-surge records proceed', () => {
    const risk = record({ eventType: 'country.risk_surge', countries: [] });
    const cp = record({ subscriberId: 'wh_bbbbbbbbbbbbbbbbbbbbbbbb' });
    const { deliveries, nextStates } = planTick({
      chokepoints: null,
      riskScores,
      records: [risk, cp],
      states: new Map(),
      now: NOW,
      scoresFetchedAt: null,
      riskFetchedAt: 'r',
      makeId: () => 'whd_fixed',
    });
    assert.deepEqual(deliveries.map((d) => d.event), ['country.risk_surge', 'country.risk_surge']);
    assert.equal(nextStates.has(cp.subscriberId), false);
  });

  it('leaves risk-surge records untouched when the risk feed is unreadable, while chokepoint records proceed', () => {
    const risk = record({ eventType: 'country.risk_surge', countries: [] });
    const cp = record({ subscriberId: 'wh_bbbbbbbbbbbbbbbbbbbbbbbb' });
    const { deliveries, nextStates } = planTick({
      chokepoints: [chokepoint('suez', 75)],
      riskScores: null,
      records: [risk, cp],
      states: new Map(),
      now: NOW,
      scoresFetchedAt: 'x',
      makeId: () => 'whd_fixed',
    });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].record.subscriberId, cp.subscriberId);
    assert.equal(nextStates.has(risk.subscriberId), false, 'no state write for a feed we did not read');
  });

  it('ignores a record with an event type the registry does not know', () => {
    const { deliveries, nextStates } = planRisk({ overrides: { eventType: 'country.coup' } });
    assert.equal(deliveries.length, 0);
    assert.equal(nextStates.size, 0);
  });
});

describe('reason precedence', () => {
  const cases = [
    [{ aisDisruptions: 2, activeWarnings: 3, transitSummary: { todayCountsAvailable: true, wowChangePct: -40 } }, 'ais_congestion_spike'],
    [{ activeWarnings: 3, transitSummary: { todayCountsAvailable: true, wowChangePct: -40 } }, 'navigational_warning'],
    [{ transitSummary: { todayCountsAvailable: true, wowChangePct: -25 } }, 'transit_drop'],
    [{ transitSummary: { todayCountsAvailable: false, wowChangePct: -60 } }, 'score_threshold'],
    [{ transitSummary: { todayCountsAvailable: true, wowChangePct: -24.9 } }, 'score_threshold'],
  ];
  for (const [extra, reason] of cases) {
    it(`${JSON.stringify(extra)} -> ${reason}`, () => {
      assert.equal(reasonFor(chokepoint('suez', 70, extra)), reason);
    });
  }
});

// The in-memory pipeline lives in tests/_lib/fake-webhook-redis.mjs so the
// occurrence-event suite (tests/shipping-webhook-worker-occurrences.test.mjs)
// drives the same fenced scripts.

const TOKEN = 'run-1';

function lockStub(acquired = true, store = null) {
  const calls = { acquire: 0, release: 0 };
  return {
    calls,
    lock: {
      acquire: async () => {
        calls.acquire += 1;
        if (acquired) store?.set(LOCK_KEY, TOKEN);
        return acquired;
      },
      fence: () => ({ key: LOCK_KEY, token: TOKEN }),
      release: async () => { calls.release += 1; },
    },
  };
}

const SUB = record().subscriberId;
const RECORD_KEY = `webhook:sub:${SUB}:v1`;

function twoCrossings() {
  const fake = seeded({ rec: record({ chokepointIds: ['suez', 'hormuz_strait'] }) });
  fake.store.set(CHOKEPOINT_STATUS_KEY, JSON.stringify({
    chokepoints: [chokepoint('suez', 75), chokepoint('hormuz_strait', 90)],
    fetchedAt: 'x',
  }));
  return fake;
}

function seeded({ score = 75, rec = record(), backfilled = true, state } = {}) {
  const initial = {
    [CHOKEPOINT_STATUS_KEY]: JSON.stringify({
      chokepoints: [chokepoint('suez', score)],
      fetchedAt: '2026-10-17T11:58:00.000Z',
      upstreamUnavailable: false,
    }),
    [RECORD_KEY]: JSON.stringify(rec),
    'webhook:all:v1': new Set([SUB]),
  };
  if (backfilled) initial[BACKFILL_CURSOR_KEY] = 'done';
  if (state) initial[stateKey(SUB)] = { suez: JSON.stringify(state) };
  return fakeRedis(initial);
}

function deliverStub(outcomes) {
  const sent = [];
  const deliver = async (rec, payload, deliveryId) => {
    sent.push({ rec, payload, deliveryId });
    return outcomes.shift() ?? { ok: true, status: 200 };
  };
  return { sent, deliver };
}

const tick = (fake, deliver, extra = {}) => runTick({
  redis: fake.redis,
  lock: lockStub(true, fake.store).lock,
  deliver,
  env: {},
  fetchImpl: async () => { throw new Error('unexpected fetch'); },
  now: () => NOW,
  ...extra,
});

describe('runTick', () => {
  it('delivers, disarms the chokepoint, and records the outcome on the subscriber', async () => {
    const fake = seeded();
    const { sent, deliver } = deliverStub([{ ok: true, status: 202 }]);
    const summary = await tick(fake, deliver);
    assert.equal(sent.length, 1);
    assert.equal(summary.deliveries, 1);
    assert.deepEqual(JSON.parse(fake.store.get(stateKey(SUB)).suez), {
      armed: false,
      lastScore: 75,
      lastDeliveredAt: '2026-10-17T12:00:00.000Z',
      sources: { navigationalWarnings: true, ais: true, transit: true },
    });
    assert.equal(fake.ttl.get(stateKey(SUB)), 30 * 86400);
    assert.deepEqual(JSON.parse(fake.store.get(RECORD_KEY)), {
      ...record(), failureCount: 0, lastDeliveryAt: '2026-10-17T12:00:00.000Z', lastDeliveryStatus: 202,
    });

    const again = await tick(fake, deliver);
    assert.equal(again.deliveries, 0, 'one delivery per upward crossing');
  });

  it('keeps the crossing armed on failure and deactivates at the 5th consecutive failure without refreshing the TTL', async () => {
    const fake = seeded({ rec: record({ failureCount: 4 }) });
    const { deliver } = deliverStub([{ ok: false, status: 500, error: 'http_500' }]);
    const summary = await tick(fake, deliver);
    assert.equal(summary.failures, 1);
    assert.equal(summary.deactivated, 1);
    const stored = JSON.parse(fake.store.get(RECORD_KEY));
    assert.equal(stored.active, false);
    assert.equal(stored.failureCount, 5);
    assert.equal(stored.lastDeliveryStatus, 500);
    assert.equal(stored.lastDeliveryError, 'http_500');
    assert.equal(stored.deactivatedAt, '2026-10-17T12:00:00.000Z');
    assert.equal(JSON.parse(fake.store.get(stateKey(SUB)).suez).armed, true);
    const write = fake.log.find((command) => command[0] === 'EVAL' && command[1] === RECORD_CAS_SCRIPT);
    assert.match(write[1], /'KEEPTTL'/);
    assert.equal(fake.log.some((command) => command[0] === 'SET' && command[1] === RECORD_KEY), false);

    const { sent, deliver: next } = deliverStub([]);
    await tick(fake, next);
    assert.equal(sent.length, 0, 'an inactive subscriber receives nothing');
  });

  it('counts a refused callback as a failure with no HTTP status', async () => {
    const fake = seeded({ rec: record({ failureCount: 1 }) });
    const { deliver } = deliverStub([{ ok: false, status: 0, error: 'ssrf' }]);
    await tick(fake, deliver);
    const stored = JSON.parse(fake.store.get(RECORD_KEY));
    assert.equal(stored.failureCount, 2);
    assert.equal(stored.lastDeliveryStatus, null);
    assert.equal(stored.active, true);
  });

  it('resets failureCount after a success', async () => {
    const fake = seeded({ rec: record({ failureCount: 3, lastDeliveryError: 'timeout' }) });
    const { deliver } = deliverStub([{ ok: true, status: 200 }]);
    await tick(fake, deliver);
    const stored = JSON.parse(fake.store.get(RECORD_KEY));
    assert.equal(stored.failureCount, 0);
    assert.equal('lastDeliveryError' in stored, false);
  });

  it('leaves a record that changed mid-tick alone', async () => {
    const fake = seeded();
    const rotated = JSON.stringify({ ...record(), secret: 'b'.repeat(64) });
    const deliver = async () => {
      fake.store.set(RECORD_KEY, rotated);
      return { ok: true, status: 200 };
    };
    await tick(fake, deliver);
    assert.equal(fake.store.get(RECORD_KEY), rotated, 'a rotated secret must survive the counter write');
  });

  it('backfills the index from records written before it existed, once', async () => {
    const fake = seeded({ backfilled: false });
    fake.store.delete('webhook:all:v1');
    const { sent, deliver } = deliverStub([]);
    const summary = await tick(fake, deliver);
    assert.equal(summary.backfilled, 1);
    assert.equal(sent.length, 1);
    assert.deepEqual([...fake.store.get('webhook:all:v1')], [SUB]);
    assert.equal(fake.store.get(BACKFILL_CURSOR_KEY), 'done');

    fake.log.length = 0;
    await tick(fake, deliver);
    assert.equal(fake.log.some((command) => command[0] === 'SCAN'), false);
  });

  it('backfills even when the API already created the index', async () => {
    const fake = seeded({ backfilled: false });
    fake.store.set('webhook:all:v1', new Set(['wh_new']));
    fake.store.set('webhook:sub:wh_new:v1', JSON.stringify(record({ subscriberId: 'wh_new' })));
    const { sent, deliver } = deliverStub([]);
    await tick(fake, deliver);
    assert.deepEqual(sent.map(({ rec }) => rec.subscriberId).sort(), [SUB, 'wh_new'].sort());
  });

  it('prunes ids whose record expired', async () => {
    const fake = seeded();
    fake.store.get('webhook:all:v1').add('wh_gone');
    fake.store.set(stateKey('wh_gone'), { suez: JSON.stringify({ armed: false, lastScore: 70 }) });
    const { deliver } = deliverStub([]);
    const summary = await tick(fake, deliver);
    assert.equal(summary.pruned, 1);
    assert.equal(fake.store.get('webhook:all:v1').has('wh_gone'), false);
    assert.equal(fake.store.has(stateKey('wh_gone')), false);
  });

  it('retries a failed crossing with the same delivery id and triggeredAt', async () => {
    const fake = seeded();
    const { sent, deliver } = deliverStub([{ ok: false, status: 0, error: 'timeout' }, { ok: true, status: 200 }]);
    await tick(fake, deliver);
    await tick(fake, deliver, { now: () => NOW + 5 * 60_000 });
    assert.equal(sent.length, 2);
    assert.match(sent[0].deliveryId, /^whd_[0-9a-f]{32}$/);
    assert.equal(sent[1].deliveryId, sent[0].deliveryId);
    assert.equal(sent[1].payload.triggeredAt, sent[0].payload.triggeredAt);
    const state = JSON.parse(fake.store.get(stateKey(SUB)).suez);
    assert.equal(state.armed, false);
    assert.equal(state.pending, undefined);
  });

  it('gives a new crossing a new delivery id after re-arming', async () => {
    const fake = seeded({ state: { armed: true, lastScore: 70, pending: { deliveryId: 'whd_old', triggeredAt: '2026-10-17T11:00:00.000Z' } } });
    fake.store.set(CHOKEPOINT_STATUS_KEY, JSON.stringify({ chokepoints: [chokepoint('suez', 40)], fetchedAt: 'x' }));
    const { sent, deliver } = deliverStub([]);
    await tick(fake, deliver);
    assert.equal(sent.length, 0);
    assert.equal(JSON.parse(fake.store.get(stateKey(SUB)).suez).pending, undefined);
    fake.store.set(CHOKEPOINT_STATUS_KEY, JSON.stringify({ chokepoints: [chokepoint('suez', 80)], fetchedAt: 'y' }));
    await tick(fake, deliver);
    assert.equal(sent.length, 1);
    assert.notEqual(sent[0].deliveryId, 'whd_old');
  });

  it('keeps an index entry whose record was renewed after the read', async () => {
    const fake = seeded();
    fake.store.get('webhook:all:v1').add('wh_renewed');
    const renewed = JSON.stringify(record({ subscriberId: 'wh_renewed', chokepointIds: ['hormuz_strait'] }));
    const redis = async (commands) => {
      const rows = await fake.redis(commands);
      if (commands.some(([verb, key]) => verb === 'GET' && key === 'webhook:sub:wh_renewed:v1')) {
        fake.store.set('webhook:sub:wh_renewed:v1', renewed);
      }
      return rows;
    };
    const { deliver } = deliverStub([]);
    const summary = await tick({ ...fake, redis }, deliver);
    assert.equal(summary.pruned, 0);
    assert.equal(fake.store.get('webhook:all:v1').has('wh_renewed'), true);
  });

  it('stops sending and leaves only pending ids once the lock is lost', async () => {
    const fake = twoCrossings();
    const before = fake.store.get(RECORD_KEY);
    const { calls, lock } = lockStub(true, fake.store);
    const { sent, deliver: send } = deliverStub([]);
    const deliver = async (...args) => {
      fake.store.set(LOCK_KEY, 'run-2');
      return send(...args);
    };
    await assert.rejects(tick(fake, deliver, { lock }), /lock lost/);
    assert.equal(sent.length, 1);
    assert.equal(fake.store.get(RECORD_KEY), before);
    const state = fake.store.get(stateKey(SUB));
    assert.equal(JSON.parse(state.suez).pending.deliveryId, sent[0].deliveryId);
    assert.equal(JSON.parse(state.hormuz_strait).armed, true);
    assert.equal(fake.store.has(WORKER_META_KEY), false);
    assert.equal(calls.release, 1);
  });

  it('a worker whose lock was taken mid-delivery overwrites neither state nor record', async () => {
    const fake = seeded();
    const before = fake.store.get(RECORD_KEY);
    const { sent, deliver: send } = deliverStub([{ ok: true, status: 200 }]);
    const deliver = async (...args) => {
      fake.store.set(LOCK_KEY, 'run-2');
      return send(...args);
    };
    await assert.rejects(tick(fake, deliver), /lock lost/);
    assert.equal(sent.length, 1);
    const suez = JSON.parse(fake.store.get(stateKey(SUB)).suez);
    assert.equal(suez.armed, true, 'the new owner, not this worker, decides the disarm');
    assert.equal(suez.pending.deliveryId, sent[0].deliveryId);
    assert.equal(fake.store.get(RECORD_KEY), before);
  });

  it('does not recreate state for a subscriber pruned during the tick', async () => {
    const fake = seeded();
    const { deliver: send } = deliverStub([{ ok: true, status: 200 }]);
    const deliver = async (...args) => {
      fake.store.delete(RECORD_KEY);
      fake.store.delete(stateKey(SUB));
      return send(...args);
    };
    await tick(fake, deliver);
    assert.equal(fake.store.has(stateKey(SUB)), false);
  });

  it('stops a subscriber at its first failure in a tick so one outage counts once', async () => {
    const fake = twoCrossings();
    const { sent, deliver } = deliverStub([{ ok: false, status: 0, error: 'timeout' }]);
    const summary = await tick(fake, deliver);
    assert.equal(sent.length, 1);
    assert.equal(summary.failures, 1);
    assert.equal(JSON.parse(fake.store.get(RECORD_KEY)).failureCount, 1);
    const state = fake.store.get(stateKey(SUB));
    assert.ok(JSON.parse(state.hormuz_strait).pending, 'the unsent crossing waits for the next tick');
  });

  it('stops sending once the record changes mid-tick, so no send uses a rotated secret', async () => {
    const fake = twoCrossings();
    const rotated = JSON.stringify({ ...record({ chokepointIds: ['suez', 'hormuz_strait'] }), secret: 'b'.repeat(64) });
    const { sent, deliver: send } = deliverStub([]);
    const deliver = async (...args) => {
      fake.store.set(RECORD_KEY, rotated);
      return send(...args);
    };
    await tick(fake, deliver);
    assert.equal(sent.length, 1);
    assert.equal(fake.store.get(RECORD_KEY), rotated);
  });

  it('a worker whose lock was taken does not overwrite the health result', async () => {
    const fake = seeded({ rec: record({ active: false }) });
    fake.store.set(WORKER_META_KEY, 'successor');
    let stolen = false;
    const redis = async (commands) => {
      if (!stolen) { stolen = true; fake.store.set(LOCK_KEY, 'run-2'); }
      return fake.redis(commands);
    };
    await assert.rejects(tick({ ...fake, redis }, deliverStub([]).deliver), /lock lost/);
    assert.equal(fake.store.get(WORKER_META_KEY), 'successor');
  });

  it('retries a lock renewal that failed in transport', async () => {
    const fake = seeded();
    let failed = false;
    const redis = async (commands) => {
      if (!failed && commands.some((command) => command[1] === LOCK_RENEW_SCRIPT)) {
        failed = true;
        throw new Error('fetch failed');
      }
      return fake.redis(commands);
    };
    const { sent, deliver } = deliverStub([]);
    const summary = await tick({ ...fake, redis }, deliver);
    assert.equal(sent.length, 1);
    assert.equal(summary.deliveries, 1);
  });

  it('writes health status, meta, and the activation marker', async () => {
    const fake = seeded();
    const { deliver } = deliverStub([]);
    await tick(fake, deliver);
    assert.deepEqual(JSON.parse(fake.store.get(WORKER_META_KEY)), {
      fetchedAt: NOW,
      recordCount: 1,
      sourceState: 'ok',
      riskSourceState: 'error',
      fanoutState: 'ok',
      hazardSourceState: 'error',
      deliveries: 1,
      failures: 0,
      deactivated: 0,
      pruned: 0,
      occurrences: { drained: 0, unreadable: 0, duplicates: 0, matched: 0, suppressed: 0, deferred: 0, expired: 0, pruned: 0 },
      hazards: { feedIds: 0, new: 0, bootstrapped: 0, stale: 0, closed: 0, crossSource: 0 },
      scoresFetchedAt: '2026-10-17T11:58:00.000Z',
      riskFetchedAt: null,
    });
    assert.equal(fake.ttl.get(WORKER_META_KEY), 7 * 86400);
    assert.equal(JSON.parse(fake.store.get(WORKER_STATUS_KEY)).subscribers, 1);
    assert.equal(fake.ttl.get(WORKER_STATUS_KEY), 3600);
    assert.equal(fake.store.get(WORKER_ACTIVATION_KEY), '1');
    assert.equal(fake.ttl.has(WORKER_ACTIVATION_KEY), false);
  });

  it('delivers a country.risk_surge subscription with its own event header and state field', async () => {
    const rec = record({ eventType: 'country.risk_surge', countries: ['IR'] });
    const fake = seeded({ rec });
    const riskFeed = {
      ciiScores: [
        { region: 'IR', combinedScore: 84, dynamicScore: 24, staticBaseline: 50, trend: 'TREND_DIRECTION_RISING', components: {}, computedAt: NOW - 60_000, methodologyVersion: 'v8', advisoryLevel: 'do-not-travel' },
        { region: 'UA', combinedScore: 99, dynamicScore: 27, computedAt: NOW - 60_000 },
      ],
    };
    fake.store.set(RISK_SCORES_STALE_KEY, JSON.stringify(riskFeed));
    const sent = [];
    const deliver = async (_r, payload, deliveryId, event) => {
      sent.push({ payload, deliveryId, event });
      return { ok: true, status: 200 };
    };
    const summary = await tick(fake, deliver);
    assert.equal(summary.riskSourceState, 'ok');
    assert.equal(summary.riskSource, 'redis-stale', 'the live key was absent, the stale copy served');
    assert.equal(summary.riskFetchedAt, new Date(NOW - 60_000).toISOString());
    assert.equal(sent.length, 1, 'UA is out of scope, the chokepoint feed is not evaluated for this record');
    assert.equal(sent[0].event, 'country.risk_surge');
    assert.equal(sent[0].payload.countryCode, 'IR');
    assert.match(sent[0].deliveryId, /^whd_[0-9a-f]{32}$/);
    const state = fake.store.get(stateKey(SUB));
    assert.deepEqual(Object.keys(state), ['cii:IR']);
    const ir = JSON.parse(state['cii:IR']);
    assert.equal(ir.armed, false);
    assert.equal(ir.lastDeliveredAt, new Date(NOW).toISOString());
    assert.equal('pending' in ir, false);
    // The surge persists: no second delivery, the pair stays disarmed.
    await tick(fake, deliver);
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(fake.store.get(stateKey(SUB))['cii:IR']).armed, false);
  });

  it('still delivers country.risk_surge when the chokepoint feed is down for the tick', async () => {
    const rec = record({ eventType: 'country.risk_surge', countries: ['IR'] });
    const fake = seeded({ rec });
    fake.store.delete(CHOKEPOINT_STATUS_KEY);
    fake.store.set(RISK_SCORES_KEY, JSON.stringify({ ciiScores: [{ region: 'IR', combinedScore: 84, dynamicScore: 24, computedAt: NOW }] }));
    const { sent, deliver } = deliverStub([]);
    const summary = await tick(fake, deliver);
    assert.equal(summary.sourceState, 'error');
    assert.equal(summary.riskSourceState, 'ok');
    assert.equal(sent.length, 1, 'a chokepoint outage must not hold a surge that may settle before the feed returns');
    assert.equal(summary.subscribers, 1);
  });

  it('prefers the live risk key and falls back to the RPC when both Redis copies are gone', async () => {
    const rec = record({ eventType: 'country.risk_surge', countries: [] });
    const fake = seeded({ rec });
    fake.store.set(RISK_SCORES_KEY, JSON.stringify({ ciiScores: [{ region: 'IR', combinedScore: 84, dynamicScore: 24, computedAt: NOW }] }));
    fake.store.set(RISK_SCORES_STALE_KEY, JSON.stringify({ ciiScores: [{ region: 'IR', combinedScore: 10, dynamicScore: 0, computedAt: 1 }] }));
    const { sent, deliver } = deliverStub([]);
    assert.equal((await tick(fake, deliver)).riskSource, 'redis');
    assert.equal(sent.length, 1);

    const fresh = seeded({ rec });
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push(url);
      assert.equal(init.headers['X-WorldMonitor-Key'], 'relay-key');
      return new Response(JSON.stringify({ ciiScores: [{ region: 'IR', combinedScore: 84, dynamicScore: 24, computedAt: NOW }] }));
    };
    const summary = await tick(fresh, deliverStub([]).deliver, { env: { WORLDMONITOR_RELAY_KEY: 'relay-key' }, fetchImpl });
    assert.equal(summary.riskSource, 'rpc');
    assert.deepEqual(requests, ['https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores']);
  });

  it('reports an unreadable score feed and delivers nothing', async () => {
    for (const blob of [undefined, '__WM_NEG__', JSON.stringify({ chokepoints: [], upstreamUnavailable: true })]) {
      const fake = seeded();
      if (blob === undefined) fake.store.delete(CHOKEPOINT_STATUS_KEY);
      else fake.store.set(CHOKEPOINT_STATUS_KEY, blob);
      const { sent, deliver } = deliverStub([]);
      const summary = await tick(fake, deliver);
      assert.equal(sent.length, 0);
      assert.equal(summary.sourceState, 'error');
      assert.equal(JSON.parse(fake.store.get(WORKER_META_KEY)).sourceState, 'error');
      assert.equal(fake.store.has(WORKER_ACTIVATION_KEY), false);
    }
  });

  it('falls back to the status RPC when the 5-minute cache has expired', async () => {
    const fake = seeded();
    fake.store.delete(CHOKEPOINT_STATUS_KEY);
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        chokepoints: [chokepoint('suez', 75)], fetchedAt: '2026-10-17T11:59:00.000Z', upstreamUnavailable: false,
      }));
    };
    const { sent, deliver } = deliverStub([]);
    const summary = await tick(fake, deliver, { env: { WORLDMONITOR_RELAY_KEY: 'relay-key' }, fetchImpl });
    assert.equal(summary.source, 'rpc');
    assert.equal(sent.length, 1);
    assert.equal(requests[0].url, CHOKEPOINT_STATUS_RPC_URL);
    assert.equal(requests[0].init.headers['X-WorldMonitor-Key'], 'relay-key');
  });

  it('does no Redis I/O when another instance holds the lock', async () => {
    const fake = seeded();
    const { calls, lock } = lockStub(false);
    const { sent, deliver } = deliverStub([]);
    const result = await runTick({ redis: fake.redis, lock, deliver, env: {}, now: () => NOW });
    assert.deepEqual(result, { skipped: true });
    assert.equal(fake.log.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(calls.release, 0);
  });

  it('releases the lock when the tick throws', async () => {
    const { calls, lock } = lockStub(true);
    const redis = async () => { throw new Error('redis down'); };
    await assert.rejects(runTick({ redis, lock, env: {}, now: () => NOW }), /redis down/);
    assert.equal(calls.release, 1);
  });
});
