// seed-hormuz entity-decode regression (koala73/worldmonitor#5436).
//
// The seeder's private decoder ran `.replace(/&amp;/g, '&')` BEFORE the
// `&lt;`/`&gt;` replaces, so one call decoded TWO levels: text a publisher
// escaped twice (`&amp;lt;script&amp;gt;`) came back as live markup
// (`<script>`). The shared single-pass decoder in scripts/_html-entities.mjs
// decodes exactly one level per call. These tests exercise the decode path
// through the exported `stripTags` seam.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stripTags } from '../scripts/seed-hormuz.mjs';

describe('stripTags: tag stripping and whitespace collapsing are unchanged', () => {
  it('strips tags before decoding and collapses whitespace', () => {
    assert.equal(
      stripTags('<p>Hello   <b>world</b> &amp; all</p>'),
      'Hello world & all',
    );
  });

  it('keeps text that was escaped twice by the publisher', () => {
    // Double-decoding produced `<script>`, which the tag strip would have
    // deleted had the order been reversed — here the escaped form must
    // survive decoding intact.
    const html = '<p>Acme patched an XSS triggered by &amp;lt;script&amp;gt; tags in bios.</p>';
    const text = stripTags(html);
    assert.match(text, /&lt;script&gt;/);
    assert.match(text, /tags in bios\./);
  });
});
