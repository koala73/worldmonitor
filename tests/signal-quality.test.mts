import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeISQ, normalizeThreatLevel, type SignalQualityInput } from '../src/utils/signal-quality.ts';

const noFocal = () => null;
const focalAvailable = false;
const noFocalFn = () => null;
const noFocalReady = () => false;
const focalReady = () => true;

function isq(input: SignalQualityInput, focalFn = noFocalFn, ciiFn: (c: string) => number | null = () => null, ready = noFocalReady) {
  return computeISQ(input, focalFn, ciiFn, ready);
}

describe('normalizeThreatLevel', () => {
  it('maps critical to 1.0', () => assert.equal(normalizeThreatLevel('critical'), 1.0));
  it('maps high to 0.75', () => assert.equal(normalizeThreatLevel('high'), 0.75));
  it('maps elevated to 0.55', () => assert.equal(normalizeThreatLevel('elevated'), 0.55));
  it('maps moderate to 0.4', () => assert.equal(normalizeThreatLevel('moderate'), 0.4));
  it('maps medium to 0.4', () => assert.equal(normalizeThreatLevel('medium'), 0.4));
  it('maps low to 0.2', () => assert.equal(normalizeThreatLevel('low'), 0.2));
  it('maps info to 0.1', () => assert.equal(normalizeThreatLevel('info'), 0.1));
  it('maps unknown to 0.3', () => assert.equal(normalizeThreatLevel('unknown'), 0.3));
  it('maps undefined to 0.3', () => assert.equal(normalizeThreatLevel(undefined), 0.3));
  it('is case-insensitive', () => assert.equal(normalizeThreatLevel('CRITICAL'), 1.0));
});

describe('computeISQ — composite bounds', () => {
  it('composite is always in [0, 1]', () => {
    const inputs: SignalQualityInput[] = [
      { sourceCount: 0, isAlert: false },
      { sourceCount: 5, isAlert: true, threatLevel: 'critical', velocity: { sourcesPerHour: 10, level: 'spike', trend: 'rising' } },
      { sourceCount: 1, isAlert: false, threatLevel: 'info', countryCode: 'US' },
    ];
    for (const input of inputs) {
      const result = isq(input);
      assert.ok(result.composite >= 0 && result.composite <= 1, `composite out of range: ${result.composite}`);
    }
  });
});

describe('computeISQ — no-country gap', () => {
  it('gap is 0.5 when no countryCode', () => {
    const result = isq({ sourceCount: 1, isAlert: false });
    assert.equal(result.expectationGap, 0.5);
  });

  it('gap is 0.5 when null countryCode', () => {
    const result = isq({ sourceCount: 1, isAlert: false, countryCode: null });
    assert.equal(result.expectationGap, 0.5);
  });
});

describe('computeISQ — expectation gap tri-state', () => {
  it('gap is 0.4 when country is a signal-backed focal point (present)', () => {
    const focalFn = () => ({ focalScore: 60, urgency: 'elevated' });
    const result = isq({ sourceCount: 2, isAlert: false, countryCode: 'IR' }, focalFn);
    assert.equal(result.expectationGap, 0.4);
  });

  it('gap is 0.8 when focal data available but country absent (novel)', () => {
    const result = isq({ sourceCount: 2, isAlert: false, countryCode: 'DE' }, noFocalFn, () => null, focalReady);
    assert.equal(result.expectationGap, 0.8);
  });

  it('gap is 0.5 when focal data unavailable (neutral)', () => {
    const result = isq({ sourceCount: 2, isAlert: false, countryCode: 'DE' }, noFocalFn, () => null, noFocalReady);
    assert.equal(result.expectationGap, 0.5);
  });
});

describe('computeISQ — CII not warmed up', () => {
  it('intensity falls back to threatLevel only when ciiScoreFn returns null', () => {
    const result = isq({ sourceCount: 1, isAlert: false, threatLevel: 'high', countryCode: 'IR' }, noFocalFn, () => null);
    assert.equal(result.intensity, 0.75);
  });
});

describe('computeISQ — tiers', () => {
  it('strong tier for high-confidence + high-intensity story', () => {
    const focalFn = () => ({ focalScore: 90, urgency: 'critical' });
    const result = isq(
      { sourceCount: 3, isAlert: true, threatLevel: 'critical', velocity: { sourcesPerHour: 5, level: 'spike', trend: 'rising' }, countryCode: 'IR' },
      focalFn,
      () => 85,
    );
    assert.equal(result.tier, 'strong');
  });

  it('weak tier for low-signal story (single source, info threat)', () => {
    const result = isq({ sourceCount: 1, isAlert: false, threatLevel: 'info' });
    assert.ok(result.tier === 'weak' || result.tier === 'noise', `expected weak/noise, got ${result.tier}`);
    assert.ok(result.composite < 0.5);
  });
});

describe('computeISQ — weight profiles sum to 1', () => {
  const WEIGHTS: Record<string, [number, number, number, number]> = {
    default:   [0.35, 0.30, 0.20, 0.15],
    risk:      [0.45, 0.25, 0.20, 0.10],
    macro:     [0.25, 0.40, 0.20, 0.15],
    shortTerm: [0.30, 0.25, 0.20, 0.25],
  };
  for (const [name, w] of Object.entries(WEIGHTS)) {
    it(`${name} weights sum to 1.0`, () => {
      const sum = w.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1.0) < 1e-10, `${name} weights sum to ${sum}`);
    });
  }
});
