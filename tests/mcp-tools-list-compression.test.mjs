import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

const originalEnv = { ...process.env };

const VALID_KEY = 'wm_test_key_123';

async function freshMod() {
  return import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
}

describe('api/mcp.ts — tools/list description compression (v1.5.0)', () => {
  let mod;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    mod = await freshMod();
  });

  afterEach(() => {
    Object.keys(process.env).forEach(k => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  // ============================================================
  // U1: compressDescription helper + cap constant
  // ============================================================
  describe('compressDescription helper', () => {
    it('TOOL_DESCRIPTION_MAX_BYTES === 120', () => {
      assert.equal(mod.TOOL_DESCRIPTION_MAX_BYTES, 120);
    });

    it('short text (≤cap) returns unchanged (identity, same reference)', () => {
      const t = 'Short description.';
      const r = mod.compressDescription(t, mod.TOOL_DESCRIPTION_MAX_BYTES);
      assert.equal(r, t);
    });

    it('long text with sentence boundary returns first-sentence trimmed', () => {
      const t = 'First sentence is short. Second sentence is much longer and would otherwise blow past the cap by including a great deal of additional prose that nobody reads.';
      const r = mod.compressDescription(t, 80);
      assert.equal(r, 'First sentence is short.');
      assert.ok(mod.utf8ByteLength(r) <= 80);
    });

    it('long text without sentence boundary returns truncated-to-cap raw text', () => {
      const t = 'a'.repeat(200); // no `.`, `!`, or `?`
      const r = mod.compressDescription(t, 50);
      assert.equal(mod.utf8ByteLength(r), 50);
      assert.equal(r, 'a'.repeat(50));
    });

    it('text exactly at cap returns unchanged', () => {
      const t = 'x'.repeat(50);
      const r = mod.compressDescription(t, 50);
      assert.equal(r, t);
    });

    it('UTF-8 emoji at the cap boundary: never splits a 4-byte codepoint mid-cut', () => {
      // 30 emoji = 120 UTF-8 bytes (each emoji is 4 bytes); cap=100.
      // The byte-truncate path should stop AT a codepoint boundary,
      // not produce a malformed UTF-8 string. 25 emoji = 100 bytes.
      const t = '🚀'.repeat(30);
      assert.equal(mod.utf8ByteLength(t), 120);
      const r = mod.compressDescription(t, 100);
      assert.equal(mod.utf8ByteLength(r), 100, `expected exactly 100 bytes, got ${mod.utf8ByteLength(r)}`);
      // Round-trip through encode/decode to confirm no broken codepoint
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(r));
      assert.equal(decoded, r);
      assert.equal(r, '🚀'.repeat(25));
    });

    it('CJK content compresses correctly (utf8 byte accounting, not .length)', () => {
      // Each Chinese char is 3 UTF-8 bytes. 50 chars = 150 bytes, .length=50.
      const t = '中'.repeat(50);
      assert.equal(mod.utf8ByteLength(t), 150);
      assert.equal(t.length, 50);
      const r = mod.compressDescription(t, 60);
      // Should fit ~20 chars (60 bytes) — first-sentence regex doesn't match, falls through to byte-truncate
      assert.ok(mod.utf8ByteLength(r) <= 60);
      assert.equal(mod.utf8ByteLength(r), 60); // exactly 20 chars
    });

    it('empty string returns empty string', () => {
      assert.equal(mod.compressDescription('', 120), '');
    });

    it('idempotent: compressDescription(compressDescription(t, cap), cap) === compressDescription(t, cap)', () => {
      const t = 'a long description that exceeds the cap. With multiple sentences. Each one different.';
      const once = mod.compressDescription(t, 30);
      const twice = mod.compressDescription(once, 30);
      assert.equal(twice, once);
    });

    it('never grows: output bytes ≤ max(input, cap)', () => {
      const inputs = [
        'short',
        'medium length sentence here.',
        'a'.repeat(300),
        '🚀'.repeat(50),
      ];
      for (const t of inputs) {
        const r = mod.compressDescription(t, 50);
        assert.ok(mod.utf8ByteLength(r) <= Math.max(mod.utf8ByteLength(t), 50),
          `growth detected for input ${JSON.stringify(t.slice(0, 40))}: in=${mod.utf8ByteLength(t)} out=${mod.utf8ByteLength(r)}`);
      }
    });
  });
});
