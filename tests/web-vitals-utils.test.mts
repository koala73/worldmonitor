import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getWebVitalsFormFactor, sanitizeWebVitalUrl } from '@/bootstrap/web-vitals-utils';
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

test('sanitizeWebVitalUrl redacts query strings and caps malformed URLs', () => {
  assert.equal(
    sanitizeWebVitalUrl('https://api.worldmonitor.app/api/bootstrap?tier=fast&wms=secret#frag'),
    'https://api.worldmonitor.app/api/bootstrap?[redacted]',
  );
  assert.equal(sanitizeWebVitalUrl('https://worldmonitor.app/assets/main.js'), 'https://worldmonitor.app/assets/main.js');
  assert.equal(sanitizeWebVitalUrl(`http://[bad?${'x'.repeat(220)}`), 'http://[bad');
});
