/**
 * PARITY: server/_shared/notify-fields.ts (Edge, consumed by api/notify.ts)
 * and scripts/shared/notify-fields.cjs (Railway relay, consumed by
 * scripts/notification-relay.cjs) must stay behaviour-equivalent.
 *
 * The relay runs under scripts/package.json with no TS loader and
 * Dockerfile.relay COPYs scripts/** explicitly, so a single shared module is
 * not deployable to both runtimes. This test runs one vector table against
 * BOTH modules and fails on any divergence, so a behaviour edit to one copy
 * without mirroring it in the other breaks CI instead of shipping a
 * validation gap between the edge boundary and the defence-in-depth sink.
 *
 * Run: node --test tests/notify-fields-parity.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cjs = require('../scripts/shared/notify-fields.cjs');
const ts = await import('../server/_shared/notify-fields.ts');

const FNS = [
  'stripNotificationControlChars',
  'sanitizeNotificationText',
  'isImpersonatingSource',
  'sanitizeNotificationTitle',
  'sanitizeNotificationSource',
  'classifyNotificationLink',
  'sanitizeNotificationLinkUrl',
  'renderNotificationLinkForText',
];

const CONSTANTS = [
  'NOTIFY_TITLE_MAX_LENGTH',
  'NOTIFY_SOURCE_MAX_LENGTH',
  'NOTIFY_DASHBOARD_URL',
  'NOTIFY_NEUTRAL_SOURCE',
];

// One table, both modules. Covers the #8397 PoC shapes plus the legitimate
// traffic the fix must not break (RSS punctuation/unicode, long-tail
// publisher domains, domain-producer title/source without links).
const VECTORS = {
  stripNotificationControlChars: [
    ['a\nb\rc\td'],
    ['line para sep'],
    ['clean headline — with unicode ✓'],
    [''],
  ],
  sanitizeNotificationText: [
    ['  spaced   out  ', 200],
    ['a\nb', 200],
    ['x'.repeat(500), 200],
    [123, 200],
    [null, 200],
    [undefined, 200],
  ],
  isImpersonatingSource: [
    ['WorldMonitor Security'],
    ['worldmonitor'],
    ['WORLDMONITOR ALERTS'],
    ['World Monitor Team'],
    ['WM Security'],
    ['Reuters'],
    ['Tzeva Adom / Pikud HaOref'],
    [''],
    [null],
    [123],
  ],
  sanitizeNotificationTitle: [
    ['Security notice: verify your WorldMonitor account immediately'],
    ['Markets rally — rate outlook ✓'],
    ['Title\nwith\r\nnewlines\tand tabs'],
    ['x'.repeat(500)],
    [null],
    [123],
  ],
  sanitizeNotificationSource: [
    ['WorldMonitor Security'],
    ['worldmonitor'],
    ['Reuters'],
    ['Equity Market'],
    ['Source\nwith newline'],
    ['x'.repeat(500)],
    [null],
  ],
  classifyNotificationLink: [
    ['https://example.com/wm-verify-account'],
    ['https://reuters.com/world/story'],
    ['https://worldmonitor.app/dashboard'],
    ['/dashboard'],
    ['not a url'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>1</script>'],
    ['http://example.com/'],
    ['https://worldmonitor.app@example.com/'],
    [''],
    [null],
    [undefined],
    [123],
    [{ toString: () => 'https://example.com' }],
  ],
  sanitizeNotificationLinkUrl: [
    ['https://example.com/wm-verify-account'],
    ['javascript:alert(1)'],
    ['http://example.com/'],
    ['https://worldmonitor.app@example.com/'],
    [''],
    [null],
  ],
  renderNotificationLinkForText: [
    ['https://example.com/wm-verify-account'],
    ['https://reuters.com/world/story'],
    ['javascript:alert(1)'],
    ['http://example.com/'],
    ['https://worldmonitor.app@example.com/'],
    [''],
    [null],
    [undefined],
  ],
};

describe('notify-fields TS/CJS parity', () => {
  for (const name of CONSTANTS) {
    it(`constant ${name} matches`, () => {
      assert.deepEqual(cjs[name], ts[name], `constant ${name} diverged`);
    });
  }

  it('exports the same function surface', () => {
    for (const name of FNS) {
      assert.equal(typeof cjs[name], 'function', `CJS missing ${name}`);
      assert.equal(typeof ts[name], 'function', `TS missing ${name}`);
    }
  });

  for (const name of FNS) {
    it(`${name} agrees on every vector`, () => {
      for (const args of VECTORS[name]) {
        assert.deepEqual(
          cjs[name](...args),
          ts[name](...args),
          `${name}(${JSON.stringify(args).slice(0, 160)}) diverged`,
        );
      }
    });
  }

  it('poisons the PoC link identically in both copies', () => {
    for (const mod of [cjs, ts]) {
      assert.equal(
        mod.renderNotificationLinkForText('https://example.com/wm-verify-account'),
        'https://example.com/wm-verify-account (source: example.com)',
      );
      assert.equal(
        mod.sanitizeNotificationSource('WorldMonitor Security'),
        mod.NOTIFY_NEUTRAL_SOURCE,
      );
    }
  });
});
