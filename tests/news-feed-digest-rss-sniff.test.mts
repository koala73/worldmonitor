import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeRssXml } from '../server/worldmonitor/news/v1/list-feed-digest';

describe('looksLikeRssXml: reject non-RSS bodies before they poison the cache', () => {
  it('accepts a standard RSS 2.0 body', () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>InfoQ</title>
<item><title>foo</title></item>
</channel>
</rss>`;
    assert.equal(looksLikeRssXml(body), true);
  });

  it('accepts an Atom 1.0 body', () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Example Feed</title>
<entry><title>x</title></entry>
</feed>`;
    assert.equal(looksLikeRssXml(body), true);
  });

  it('accepts an RSS body with no XML preamble (some feeds skip it)', () => {
    const body = `<rss version="2.0"><channel><item/></channel></rss>`;
    assert.equal(looksLikeRssXml(body), true);
  });

  it('REGRESSION: accepts RSS 1.0 / RDF feeds (Nature News, Asahi, Slashdot)', () => {
    // Real Nature News body shape — this feed is in the registry at
    // server/worldmonitor/news/v1/_feeds.ts:418 (`feeds.nature.com/nature/rss/current`).
    // Pre-fix-fix the sniff rejected this entire feed as non-RSS, even
    // though parseRssXml handles its <item> blocks correctly.
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"
         xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns="http://purl.org/rss/1.0/" xmlns:admin="http://webns.net/mvcb/">
    <channel rdf:about="http://feeds.nature.com/nature/rss/current">
        <title>Nature</title>
        <item><title>foo</title></item>
    </channel>
</rdf:RDF>`;
    assert.equal(looksLikeRssXml(body), true);
  });

  it('accepts RDF feeds even when the namespace prefix is uppercase (defensive)', () => {
    // Some feeds emit `<RDF:RDF>` — case-insensitive sniff handles both.
    const body = `<RDF:RDF xmlns:RDF="..."><channel><item/></channel></RDF:RDF>`;
    assert.equal(looksLikeRssXml(body), true);
  });

  it('REGRESSION: rejects a Cloudflare interstitial that comes back as HTTP 200', () => {
    // Real shape from the production CF challenge — the exact body the user
    // hit on tech.worldmonitor.app's cloud + IPO panels. Pre-sniff this
    // would slip through fetchRssText and land at parseRssXml, which finds
    // zero <item> tags and caches an empty ParseResult for 1h.
    const body = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<!--[if IE 7]>    <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->
<!--[if IE 8]>    <html class="no-js ie8 oldie" lang="en-US"> <![endif]-->
<head><title>Just a moment...</title></head>
<body><div>cf-error</div></body>
</html>`;
    assert.equal(looksLikeRssXml(body), false);
  });

  it('rejects a generic HTML page (login wall, captcha, etc.)', () => {
    const body = '<!DOCTYPE html><html><body>Sign in</body></html>';
    assert.equal(looksLikeRssXml(body), false);
  });

  it('rejects HTML even when the case is unusual', () => {
    const body = '<!DOCTYPE HTML><HTML><BODY>X</BODY></HTML>';
    assert.equal(looksLikeRssXml(body), false);
  });

  it('rejects a JSON body (e.g. some upstreams misroute to a JSON API endpoint)', () => {
    const body = '{"error":"not found"}';
    assert.equal(looksLikeRssXml(body), false);
  });

  it('rejects an empty body', () => {
    assert.equal(looksLikeRssXml(''), false);
  });

  it('rejects whitespace-only body', () => {
    assert.equal(looksLikeRssXml('   \n\n   '), false);
  });

  it('only inspects the first 2KB to keep large bodies cheap', () => {
    // RSS signature pushed beyond 2KB by leading garbage. Should reject
    // because we don't scan the whole body — large feeds are common and
    // we don't want O(N) sniff cost per fetch.
    const garbage = ' '.repeat(3000);
    const body = garbage + '<rss version="2.0"><channel/></rss>';
    assert.equal(looksLikeRssXml(body), false);
  });

  it('handles RSS body with a leading byte order mark or comment', () => {
    // Some feeds emit a leading <?xml?> with attributes, comments, or BOM.
    // The signature must still be findable in first 2KB.
    const body = '<?xml version="1.0"?>\n<!-- generated 2026-05-02 -->\n<rss>...</rss>';
    assert.equal(looksLikeRssXml(body), true);
  });
});
