import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// #5372: the service worker used to register at module evaluation, so the
// Workbox precache wave (74 requests / 882 KB on the DebugBear mobile profile)
// was issued during first paint. Registration must now be scheduled after
// load + idle. Source-text contract, in the style of tests/deploy-config: the
// boot module cannot be imported under node:test.
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

describe('service worker registration timing', () => {
  it('registers through scheduleAfterFirstPaint, not at module evaluation', () => {
    assert.match(mainSource, /import \{ scheduleAfterFirstPaint \} from '@\/utils\/after-paint';/);
    assert.match(mainSource, /const registerServiceWorker = \(\): void => \{[\s\S]*?navigator\.serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)/);
    assert.match(mainSource, /scheduleAfterFirstPaint\(registerServiceWorker\);/);
  });

  it('has exactly one register() call and it lives inside the deferred function', () => {
    const calls = [...mainSource.matchAll(/navigator\.serviceWorker\.register\(/g)];
    assert.equal(calls.length, 1, 'a second register() would reintroduce the boot-path wave');
    const fnStart = mainSource.indexOf('const registerServiceWorker = ');
    const schedule = mainSource.indexOf('scheduleAfterFirstPaint(registerServiceWorker);');
    assert.ok(fnStart !== -1 && schedule !== -1);
    assert.ok(calls[0].index > fnStart && calls[0].index < schedule, 'register() must sit between the function declaration and its scheduling');
  });

  it('keeps the update handler on the early path so it still sees lifecycle events', () => {
    const install = mainSource.indexOf('installSwUpdateHandler({ version: __APP_VERSION__, swContainer });');
    const fnStart = mainSource.indexOf('const registerServiceWorker = ');
    assert.ok(install !== -1 && install < fnStart, 'installSwUpdateHandler must run before the deferred registration is even defined');
  });

  it('scheduleAfterFirstPaint waits for load, then idle, with a setTimeout fallback', () => {
    const helper = readFileSync(new URL('../src/utils/after-paint.ts', import.meta.url), 'utf8');
    assert.match(helper, /window\.addEventListener\('load', afterPaint, \{ once: true \}\)/);
    assert.match(helper, /requestIdleCallback/);
    assert.match(helper, /setTimeout\(runOnce, 0\)/);
  });
});
