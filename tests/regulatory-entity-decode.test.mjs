import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stripHtml } from '../scripts/seed-regulatory-actions.mjs';

describe('stripHtml: escaped markup survives the tag strip', () => {
  it('keeps text that was escaped twice by the publisher', () => {
    // Double-decoding produced `<script>`, which the `<[^>]+>` strip then
    // deleted along with the alert payload text boundary.
    const stripped = stripHtml('Enforcement action over &amp;lt;script&amp;gt; tags in filings.');
    assert.match(stripped, /&lt;script&gt;/);
    assert.match(stripped, /tags in filings\./);
  });

  it('still strips tags exposed by a single decode level (FINRA-style descriptions)', () => {
    assert.equal(
      stripHtml('&lt;h2&gt;Summary&lt;/h2&gt;&lt;p&gt;FINRA amends Rule 4210.&lt;/p&gt;'),
      'Summary FINRA amends Rule 4210.',
    );
  });
});
