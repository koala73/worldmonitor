import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { escapeHtml, sanitizeUrl, validateUrl } from '../src/utils/sanitize.ts';

describe('sanitize utility contracts', () => {
  it('escapeHtml escapes every HTML delimiter while preserving safe text', () => {
    assert.deepEqual(
      [escapeHtml(`<>&"'`), escapeHtml('World Monitor 123')],
      ['&lt;&gt;&amp;&quot;&#39;', 'World Monitor 123'],
    );
  });

  it('sanitizeUrl rejects executable, data, non-HTTP, and bare relative URLs', () => {
    assert.deepEqual(
      [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'ftp://example.com/file',
        'relative/path',
      ].map(sanitizeUrl),
      ['', '', '', ''],
    );
  });

  it('sanitizeUrl preserves supported relative references as attribute-safe values', () => {
    assert.deepEqual(
      ['/local/path', './local/path', '../local/path', '?q=1&b=2', '#section'].map(sanitizeUrl),
      ['/local/path', './local/path', '../local/path', '?q=1&amp;b=2', '#section'],
    );
  });

  it('sanitizeUrl normalizes HTTP URLs and attribute-escapes query delimiters', () => {
    assert.deepEqual(
      [sanitizeUrl('https://example.com'), sanitizeUrl('http://example.com/a?x=1&y=2')],
      ['https://example.com/', 'http://example.com/a?x=1&amp;y=2'],
    );
  });
});

it('validates DOM URLs without encoding query parameters', () => {
  assert.equal(validateUrl('https://example.com/a?x=1&y=2'), 'https://example.com/a?x=1&y=2');
  assert.equal(validateUrl('?x=1&y=2'), '?x=1&y=2');
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'ftp://example.com']) {
    assert.equal(validateUrl(url), '');
  }
});
