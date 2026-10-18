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

// DERIVED from the modules, never hand-listed. A hand-written name list is a
// third copy that drifts from the two it is meant to pin: add a sanitizer to
// both modules, implement the CJS side slightly differently, forget the list
// entry, and the suite passes with zero coverage of the new function — the
// exact "mirror that cannot fail" shape this file exists to prevent (#8414
// review finding). Deriving the surface also makes a function present in one
// module and absent from the other fail on its own.
const exportNames = (mod) => Object.keys(mod).filter((k) => k !== 'default' && k !== '__esModule');
const FNS = exportNames(cjs).filter((k) => typeof cjs[k] === 'function').sort();
const CONSTANTS = exportNames(cjs).filter((k) => typeof cjs[k] !== 'function').sort();

// One table, both modules. Covers the #8397 PoC shapes plus the legitimate
// traffic the fix must not break (RSS punctuation/unicode, long-tail
// publisher domains, domain-producer title/source without links).
const VECTORS = {
  stripNotificationControlChars: [
    ['a\nb\rc\td'],
    ['line\u2028para\u2029sep'],
    ['World\u200bMonitor'],
    ['World\u2060Monitor'],
    ['World\u2066Monitor\u2069'],
    ['ＷｏｒｌｄＭｏｎｉｔｏｒ'],
    ['a\u202db\u202cc'],
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
    // Exact-boundary and astral-boundary shapes (review findings): a slice at
    // an odd offset through a surrogate pair must not leave a lone high half.
    ['x'.repeat(200), 200],
    ['x'.repeat(201), 200],
    [`A${'\u{1F600}'.repeat(150)}`, 200],
    ['\u{1F600}'.repeat(150), 200],
  ],
  redactNotificationUrlTokens: [
    ['Verify at https://wm-verify.example/login'],
    ['see www.evil.test/go now'],
    ['go to evil.test/login'],
    ['Reuters reports via reuters.com'],
    ['no links here at all'],
    ['mailto:x@y.test and ftp://h.test/f'],
    [''],
  ],
  sanitizeUserNotificationDescription: [
    ['click https://evil.test/x'],
    ['plain snippet with unicode ✓'],
    ['x'.repeat(500)],
    [null],
    [undefined],
  ],
  isImpersonatingSource: [
    ['WorldMonitor Security'],
    ['worldmonitor'],
    ['WORLDMONITOR ALERTS'],
    ['World Monitor Team'],
    ['WM Security'],
    // Invisible-format bypass shapes (review finding): zero-width, bidi,
    // LRM/RLM, soft hyphen — all must still match the markers.
    ['World\u200bMonitor Security'],
    ['World\u200cMonitor Security'],
    ['World\u200eMonitor Security'],
    ['World\u00adMonitor Security'],
    ['World\u2060Monitor Security'],
    ['World-Monitor Security'],
    ['World.Monitor Security'],
    ['ＷｏｒｌｄＭｏｎｉｔｏｒ Security'],
    // Nonspacing-mark and cross-script-confusable bypasses (review finding):
    // NFKC folds compatibility forms but not these, and \p{Cf} misses \p{Mn}.
    ['World\u034fMonitor Security'],
    ['World\ufe0fMonitor Security'],
    ['Wоrldmonitor Security'],
    ['WorldМonitor Security'],
    ['Wοrldmonitor Security'],
    ['W0rldMonitor Security'],
    ['World+Monitor Security'],
    ['WоrldПonitor Security'],
    ['Reuters'],
    ['Tzeva Adom / Pikud HaOref'],
    ['Commodity Market'],
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
  sanitizeCommunityNotificationTitle: [
    ['Security notice'],
    ['Community alert: Existing prefix'],
    ['Hi\r\nBcc: evil@x.com'],
    [null],
  ],
  sanitizeNotificationDescription: [
    ['x'.repeat(350)],
    ['x'.repeat(500)],
    ['line\nwith control'],
    [null],
  ],
  sanitizeNotificationSource: [
    ['WorldMonitor Security'],
    ['World\u200bMonitor Security'],
    ['worldmonitor'],
    ['Reuters'],
    ['Equity Market'],
    ['Source\nwith newline'],
    ['x'.repeat(500)],
    [null],
  ],
  sanitizeUserNotificationSource: [
    ['WorldMonitor Security'],
    ['Reuters'],
    [''],
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
  isFirstPartyNotificationHost: [
    ['worldmonitor.app'],
    ['www.worldmonitor.app'],
    ['tech.worldmonitor.app'],
    ['evilworldmonitor.app'],
    ['worldmonitor.app.evil.test'],
  ],
  sanitizeUserNotificationLinkUrl: [
    ['https://worldmonitor.app/world/story'],
    ['https://tech.worldmonitor.app/'],
    ['https://example.com/wm-verify-account'],
    ['javascript:alert(1)'],
    [''],
    [null],
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

  it('exports the same surface in both copies', () => {
    const tsNames = exportNames(ts).filter((k) => typeof ts[k] !== 'undefined').sort();
    const cjsNames = exportNames(cjs).sort();
    assert.deepEqual(cjsNames, tsNames, 'TS and CJS export surfaces diverged');
  });

  it('every exported function has at least one parity vector', () => {
    const missing = FNS.filter((name) => !VECTORS[name]?.length);
    assert.deepEqual(
      missing,
      [],
      `these exported functions run zero parity vectors: ${missing.join(', ')}. ` +
      'Add a VECTORS entry so a TS/CJS divergence in them can fail this suite.',
    );
  });

  for (const name of FNS) {
    it(`${name} agrees on every vector`, () => {
      for (const args of VECTORS[name] ?? []) {
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

  it('enforces expected unsafe-link outcomes, not only mirror agreement', () => {
    for (const mod of [cjs, ts]) {
      assert.deepEqual(mod.classifyNotificationLink('javascript:alert(1)'), { kind: 'dashboard' });
      assert.deepEqual(mod.classifyNotificationLink('http://example.com/'), { kind: 'dashboard' });
      assert.deepEqual(mod.classifyNotificationLink('https://worldmonitor.app@example.com/'), { kind: 'dashboard' });
      assert.equal(mod.sanitizeNotificationLinkUrl('javascript:alert(1)'), mod.NOTIFY_DASHBOARD_URL);
      assert.equal(mod.renderNotificationLinkForText('javascript:alert(1)'), mod.NOTIFY_DASHBOARD_URL);
      assert.equal(
        mod.sanitizeUserNotificationLinkUrl('https://example.com/wm-verify-account'),
        mod.NOTIFY_DASHBOARD_URL,
      );
      assert.equal(
        mod.sanitizeUserNotificationLinkUrl('https://worldmonitor.app/world/story'),
        'https://worldmonitor.app/world/story',
      );
    }
  });
});
