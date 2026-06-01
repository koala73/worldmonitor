import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  joinSafeHtml,
  safeHtml,
  safeHtmlToString,
  safeUrlAttr,
  unsafeRawHtml,
} from '../src/utils/sanitize.ts';

describe('safeHtml tagged template', () => {
  it('escapes interpolated values by default while preserving literal markup', () => {
    const html = safeHtml`<span data-name="${'<img src=x onerror=alert(1)>'}">${'R&D <tag>'}</span>`;

    assert.equal(
      safeHtmlToString(html),
      '<span data-name="&lt;img src=x onerror=alert(1)&gt;">R&amp;D &lt;tag&gt;</span>',
    );
  });

  it('preserves explicitly audited raw HTML fragments', () => {
    const icon = unsafeRawHtml('<svg aria-hidden="true"></svg>', 'static reviewed icon markup');
    const html = safeHtml`<button>${icon}${'Launch <script>'}</button>`;

    assert.equal(
      safeHtmlToString(html),
      '<button><svg aria-hidden="true"></svg>Launch &lt;script&gt;</button>',
    );
  });

  it('requires an audit reason for raw HTML bypasses', () => {
    assert.throws(
      () => unsafeRawHtml('<strong>raw</strong>', '  '),
      /requires an audit reason/,
    );
  });

  it('joins only already-safe fragments and escapes separators', () => {
    const html = joinSafeHtml(
      [safeHtml`<b>${'one'}</b>`, safeHtml`<i>${'two'}</i>`],
      '<br>',
    );

    assert.equal(
      safeHtmlToString(html),
      '<b>one</b>&lt;br&gt;<i>two</i>',
    );
  });

  it('allows sanitized URLs to be interpolated into attributes without double escaping', () => {
    const html = safeHtml`<a href="${safeUrlAttr('https://example.com/a?x=1&y=2')}">source</a>`;

    assert.equal(
      safeHtmlToString(html),
      '<a href="https://example.com/a?x=1&amp;y=2">source</a>',
    );
  });

  it('blocks unsafe URLs before attribute interpolation', () => {
    const html = safeHtml`<a href="${safeUrlAttr('javascript:alert(1)')}">source</a>`;

    assert.equal(safeHtmlToString(html), '<a href="">source</a>');
  });
});
