// Tests for the regional-snapshot writer-side sanitizer.
//
// The sanitizer is defense-in-depth for strings sourced from third-party
// upstream Redis feeds before they are interpolated into snapshot
// description/summary fields and persisted. The render layer already
// HTML-escapes these strings — see
// tests/regional-snapshot-render-escape-guard.test.mjs for that side.
//
// Run via: npm run test:data

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeEvidenceString } from '../scripts/regional-snapshot/_sanitize.mjs';

describe('sanitizeEvidenceString', () => {
  it('returns plain text unchanged', () => {
    assert.equal(sanitizeEvidenceString('hello world'), 'hello world');
    assert.equal(sanitizeEvidenceString('Strait of Hormuz: elevated'), 'Strait of Hormuz: elevated');
  });

  it('strips angle brackets from script tag payloads', () => {
    assert.equal(
      sanitizeEvidenceString('<script>alert(1)</script>'),
      'scriptalert(1)/script',
    );
  });

  it('strips angle brackets from img onerror payloads', () => {
    assert.equal(
      sanitizeEvidenceString('<img src=x onerror=alert(1)>'),
      'img src=x onerror=alert(1)',
    );
  });

  it('removes NUL bytes', () => {
    assert.equal(sanitizeEvidenceString('foo\x00bar'), 'foobar');
  });

  it('removes zero-width characters (ZWSP, ZWNJ, ZWJ, BOM)', () => {
    // U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM
    const input = 'a\u200Bb\u200Cc\u200Dd\uFEFFe';
    assert.equal(sanitizeEvidenceString(input), 'abcde');
  });

  it('collapses newlines, tabs, and runs of spaces to a single space', () => {
    assert.equal(sanitizeEvidenceString('a\nb\tc\r\nd  e'), 'a b c d e');
  });

  it('trims leading and trailing whitespace', () => {
    assert.equal(sanitizeEvidenceString('   padded   '), 'padded');
    assert.equal(sanitizeEvidenceString('\n\tindented\n'), 'indented');
  });

  it('honors the default 500-character cap', () => {
    const input = 'x'.repeat(600);
    const out = sanitizeEvidenceString(input);
    assert.equal(out.length, 500);
    assert.ok(/^x+$/.test(out));
  });

  it('honors a custom maxLen', () => {
    assert.equal(sanitizeEvidenceString('hello world', { maxLen: 5 }), 'hello');
    assert.equal(sanitizeEvidenceString('hello world', { maxLen: 11 }), 'hello world');
  });

  it('returns an empty string for null without throwing', () => {
    assert.equal(sanitizeEvidenceString(null), '');
  });

  it('returns an empty string for undefined without throwing', () => {
    assert.equal(sanitizeEvidenceString(undefined), '');
  });

  it('coerces non-string values (numbers, booleans, objects) to string', () => {
    assert.equal(sanitizeEvidenceString(42), '42');
    assert.equal(sanitizeEvidenceString(true), 'true');
    assert.equal(sanitizeEvidenceString({ toString: () => 'obj' }), 'obj');
  });

  it('output never contains angle brackets after sanitization', () => {
    const hostile = [
      '<svg/onload=alert(1)>',
      '<iframe src=javascript:alert(1)>',
      'before<>after',
      '<<<>>>',
    ];
    for (const inp of hostile) {
      const out = sanitizeEvidenceString(inp);
      assert.ok(!out.includes('<'), `expected no "<" in ${JSON.stringify(out)}`);
      assert.ok(!out.includes('>'), `expected no ">" in ${JSON.stringify(out)}`);
    }
  });
});
