import { it } from 'node:test';
import assert from 'node:assert/strict';
import { seedAviationNews } from '../scripts/seed-aviation.mjs';

it('publishes raw RSS text for request-time filtering without extra entity decoding', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<rss><channel><item><title>Flight news</title><link>https://example.org/news</link><description><![CDATA[<p>AT&amp;T &lt;flight&gt; &amp;lt;literal&amp;gt;</p>]]></description></item></channel></rss>');
  try {
    const result = await seedAviationNews();
    assert.equal(result.items.length, 9);
    assert.equal(result.items[0].description, '<p>AT&amp;T &lt;flight&gt; &amp;lt;literal&amp;gt;</p>');
    assert.equal(result.items[0].link, 'https://example.org/news');
    assert.equal(result.items[0].snippet, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
