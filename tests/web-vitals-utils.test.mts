import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getWebVitalsFormFactor,
  sanitizeWebVitalUrl,
  shouldSampleWebVital,
  WEB_VITAL_SAMPLE_RATE,
} from '@/bootstrap/web-vitals-utils';
import { withWindow } from './web-vitals-report-test-helpers.mts';

test('getWebVitalsFormFactor defaults to desktop outside the browser', () => {
  assert.equal(getWebVitalsFormFactor(), 'desktop');
});

test('getWebVitalsFormFactor tags coarse pointer and tablet-width surfaces as mobile', () => {
  const formFactor = withWindow({
    innerWidth: 900,
    matchMedia: (query: string) => ({
      matches: query === '(pointer: coarse)' || query === '(hover: none)' || query === '(max-width: 1024px)',
    }),
    navigator: { userAgentData: { mobile: false } },
  }, () => getWebVitalsFormFactor());

  assert.equal(formFactor, 'mobile');
});

test('getWebVitalsFormFactor tags wide fine-pointer surfaces as desktop', () => {
  const formFactor = withWindow({
    innerWidth: 1440,
    matchMedia: () => ({ matches: false }),
    navigator: { userAgentData: { mobile: false } },
  }, () => getWebVitalsFormFactor());

  assert.equal(formFactor, 'desktop');
});

test('WEB_VITAL_SAMPLE_RATE keeps ~20% of the bad tail', () => {
  assert.equal(WEB_VITAL_SAMPLE_RATE, 0.2);
});

test('shouldSampleWebVital keeps when rng falls under the rate, drops otherwise', () => {
  assert.equal(shouldSampleWebVital(0.2, () => 0.1), true, 'rng 0.1 < 0.2 → keep');
  assert.equal(shouldSampleWebVital(0.2, () => 0.19), true, 'just under the rate → keep');
  assert.equal(shouldSampleWebVital(0.2, () => 0.2), false, 'at the rate → drop (strict <)');
  assert.equal(shouldSampleWebVital(0.2, () => 0.5), false, 'rng 0.5 ≥ 0.2 → drop');
});

test('shouldSampleWebVital keeps everything at rate >= 1 and drops everything at rate <= 0', () => {
  assert.equal(shouldSampleWebVital(1, () => 0.99), true, 'rate 1 keeps all');
  assert.equal(shouldSampleWebVital(1.5, () => 0.99), true, 'rate > 1 keeps all');
  assert.equal(shouldSampleWebVital(0, () => 0), false, 'rate 0 drops all');
  assert.equal(shouldSampleWebVital(-0.3, () => 0), false, 'negative rate drops all');
});

test('shouldSampleWebVital over-reports rather than losing data on a NaN rate', () => {
  assert.equal(shouldSampleWebVital(Number.NaN, () => 0.99), true, 'misconfigured NaN rate keeps all');
});

test('shouldSampleWebVital defaults to the configured rate and Math.random', () => {
  // Deterministic bounds check across many draws: keep-rate should land near 0.2.
  let kept = 0;
  const N = 4000;
  for (let i = 0; i < N; i += 1) if (shouldSampleWebVital()) kept += 1;
  const ratio = kept / N;
  assert.ok(ratio > 0.12 && ratio < 0.28, `default keep-rate ~0.2, got ${ratio}`);
});

test('sanitizeWebVitalUrl redacts query strings and caps malformed URLs', () => {
  assert.equal(
    sanitizeWebVitalUrl('https://api.worldmonitor.app/api/bootstrap?tier=fast&wms=secret#frag'),
    'https://api.worldmonitor.app/api/bootstrap?[redacted]',
  );
  assert.equal(sanitizeWebVitalUrl('https://worldmonitor.app/assets/main.js'), 'https://worldmonitor.app/assets/main.js');
  assert.equal(sanitizeWebVitalUrl(`http://[bad?${'x'.repeat(220)}`), 'http://[bad');
});
