import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeCIIScores } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';

function emptyAux() {
  return {
    ucdpEvents: [] as any[],
    outages: [] as any[],
    climate: [] as any[],
    cyber: [] as any[],
    fires: [] as any[],
    gpsHexes: [] as any[],
    iranEvents: [] as any[],
    orefData: null as { activeAlertCount: number; historyCount24h: number } | null,
  };
}

function acledEvent(country: string, type: string, fatalities = 0) {
  return { country, event_type: type, fatalities };
}

function scoreFor(scores: ReturnType<typeof computeCIIScores>, code: string) {
  return scores.find((s) => s.region === code);
}

describe('CII scoring', () => {
  it('returns scores for all 31 tier-1 countries including MX, BR, AE, LB, IQ, AF', () => {
    const scores = computeCIIScores([], emptyAux());
    assert.equal(scores.length, 31);
    assert.ok(scoreFor(scores, 'MX'), 'MX missing');
    assert.ok(scoreFor(scores, 'BR'), 'BR missing');
    assert.ok(scoreFor(scores, 'AE'), 'AE missing');
    assert.ok(scoreFor(scores, 'LB'), 'LB missing');
    assert.ok(scoreFor(scores, 'IQ'), 'IQ missing');
    assert.ok(scoreFor(scores, 'AF'), 'AF missing');
    assert.ok(scoreFor(scores, 'KR'), 'KR missing');
    assert.ok(scoreFor(scores, 'EG'), 'EG missing');
    assert.ok(scoreFor(scores, 'JP'), 'JP missing');
    assert.ok(scoreFor(scores, 'QA'), 'QA missing');
  });

  it('UCDP war floor: composite >= 70', () => {
    const aux = emptyAux();
    aux.ucdpEvents = [{ country: 'Ukraine', intensity_level: '2' }];
    const scores = computeCIIScores([], aux);
    const ua = scoreFor(scores, 'UA')!;
    assert.ok(ua.combinedScore >= 70, `UA score ${ua.combinedScore} should be >= 70 with UCDP war`);
  });

  it('UCDP minor conflict floor: composite >= 50', () => {
    const aux = emptyAux();
    aux.ucdpEvents = [{ country: 'Pakistan', intensity_level: '1' }];
    const scores = computeCIIScores([], aux);
    const pk = scoreFor(scores, 'PK')!;
    assert.ok(pk.combinedScore >= 50, `PK score ${pk.combinedScore} should be >= 50 with UCDP minor`);
  });

  it('advisory do-not-travel floor: composite >= 60', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const code of ['UA', 'SY', 'YE', 'MM']) {
      const s = scoreFor(scores, code)!;
      assert.ok(s.combinedScore >= 60, `${code} score ${s.combinedScore} should be >= 60 (do-not-travel)`);
    }
  });

  it('advisory reconsider floor: composite >= 50', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const code of ['MX', 'IR', 'PK', 'VE', 'CU']) {
      const s = scoreFor(scores, code)!;
      assert.ok(s.combinedScore >= 50, `${code} score ${s.combinedScore} should be >= 50 (reconsider)`);
    }
  });

  it('OREF active alerts boost IL conflict score', () => {
    const aux = emptyAux();
    aux.orefData = { activeAlertCount: 5, historyCount24h: 12 };
    const withOref = scoreFor(computeCIIScores([], aux), 'IL')!;
    const withoutOref = scoreFor(computeCIIScores([], emptyAux()), 'IL')!;
    assert.ok(withOref.combinedScore > withoutOref.combinedScore,
      `IL with OREF (${withOref.combinedScore}) should be > without (${withoutOref.combinedScore})`);
  });

  it('outage TOTAL severity gives higher unrest component than PARTIAL', () => {
    const auxTotal = emptyAux();
    auxTotal.outages = [{ countryCode: 'DE', severity: 'OUTAGE_SEVERITY_TOTAL' }];
    const auxPartial = emptyAux();
    auxPartial.outages = [{ countryCode: 'DE', severity: 'OUTAGE_SEVERITY_PARTIAL' }];
    const total = scoreFor(computeCIIScores([], auxTotal), 'DE')!;
    const partial = scoreFor(computeCIIScores([], auxPartial), 'DE')!;
    assert.ok(total.components!.ciiContribution > partial.components!.ciiContribution,
      `TOTAL unrest (${total.components!.ciiContribution}) should be > PARTIAL (${partial.components!.ciiContribution})`);
  });

  it('GPS high level gives higher weight than medium', () => {
    const auxHigh = emptyAux();
    auxHigh.gpsHexes = Array.from({ length: 5 }, () => ({ lat: 33.0, lon: 35.0, level: 'high' }));
    const auxMed = emptyAux();
    auxMed.gpsHexes = Array.from({ length: 5 }, () => ({ lat: 33.0, lon: 35.0, level: 'medium' }));
    const high = scoreFor(computeCIIScores([], auxHigh), 'IL')!;
    const med = scoreFor(computeCIIScores([], auxMed), 'IL')!;
    assert.ok(high.components!.militaryActivity >= med.components!.militaryActivity,
      `GPS high (${high.components!.militaryActivity}) should be >= medium (${med.components!.militaryActivity})`);
  });

  it('conflict fatalities use sqrt scaling', () => {
    const acled100 = [acledEvent('Ukraine', 'Battles', 100)];
    const acled400 = [acledEvent('Ukraine', 'Battles', 400)];
    const s100 = scoreFor(computeCIIScores(acled100, emptyAux()), 'UA')!;
    const s400 = scoreFor(computeCIIScores(acled400, emptyAux()), 'UA')!;
    const diff = s400.combinedScore - s100.combinedScore;
    assert.ok(diff < (s400.combinedScore - s100.staticBaseline) * 0.5,
      'sqrt scaling should produce diminishing returns for 4x fatalities');
  });

  it('log2 scaling dampens high-volume low-multiplier countries vs linear', () => {
    const manyProtests = Array.from({ length: 100 }, () => acledEvent('United States', 'Protests'));
    const fewProtests = Array.from({ length: 10 }, () => acledEvent('United States', 'Protests'));
    const many = scoreFor(computeCIIScores(manyProtests, emptyAux()), 'US')!;
    const few = scoreFor(computeCIIScores(fewProtests, emptyAux()), 'US')!;
    const ratio = many.components!.ciiContribution / Math.max(1, few.components!.ciiContribution);
    assert.ok(ratio < 5, `10x events should produce < 5x unrest ratio (got ${ratio.toFixed(2)}), log2 dampens`);
  });

  it('iran high severity strikes boost conflict', () => {
    const aux1 = emptyAux();
    aux1.iranEvents = [{ lat: 33.0, lon: 35.0, severity: 'high' }];
    const aux2 = emptyAux();
    aux2.iranEvents = [{ lat: 33.0, lon: 35.0, severity: 'low' }];
    const highSev = scoreFor(computeCIIScores([], aux1), 'IL')!;
    const lowSev = scoreFor(computeCIIScores([], aux2), 'IL')!;
    assert.ok(highSev.combinedScore >= lowSev.combinedScore,
      `High severity strike (${highSev.combinedScore}) should be >= low (${lowSev.combinedScore})`);
  });

  it('IL scores higher than MX with active conflict signals', () => {
    const acled = [
      acledEvent('Israel', 'Battles', 10),
      acledEvent('Israel', 'Explosions/Remote violence', 5),
      acledEvent('Mexico', 'Riots', 3),
    ];
    const aux = emptyAux();
    aux.ucdpEvents = [{ country: 'Israel', intensity_level: '1' }];
    aux.orefData = { activeAlertCount: 3, historyCount24h: 8 };
    const scores = computeCIIScores(acled, aux);
    const il = scoreFor(scores, 'IL')!;
    const mx = scoreFor(scores, 'MX')!;
    assert.ok(il.combinedScore > mx.combinedScore,
      `IL (${il.combinedScore}) should be > MX (${mx.combinedScore})`);
  });

  it('scores capped at 100', () => {
    const acled = Array.from({ length: 200 }, () => acledEvent('Syria', 'Battles', 50));
    const aux = emptyAux();
    aux.ucdpEvents = [{ country: 'Syria', intensity_level: '2' }];
    aux.iranEvents = Array.from({ length: 50 }, () => ({ lat: 35.0, lon: 38.0, severity: 'critical' }));
    const scores = computeCIIScores(acled, aux);
    for (const s of scores) {
      assert.ok(s.combinedScore <= 100, `${s.region} score ${s.combinedScore} should be <= 100`);
    }
  });

  it('UAE geo events attributed to AE not SA despite bbox overlap', () => {
    const aux = emptyAux();
    aux.gpsHexes = [{ lat: 25.2, lon: 55.3, level: 'high' }];
    const scores = computeCIIScores([], aux);
    const ae = scoreFor(scores, 'AE')!;
    const sa = scoreFor(scores, 'SA')!;
    assert.ok(ae.components!.militaryActivity > 0, 'AE should get the Dubai GPS hex');
    assert.equal(sa.components!.militaryActivity, 0, 'SA should not get the Dubai GPS hex');
  });

  it('empty data returns baseline-derived scores with floors', () => {
    const scores = computeCIIScores([], emptyAux());
    const us = scoreFor(scores, 'US')!;
    assert.ok(us.combinedScore >= 2 && us.combinedScore <= 10, `US baseline score ${us.combinedScore} should be ~2-10`);
  });
});
