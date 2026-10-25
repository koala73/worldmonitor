import assert from 'node:assert/strict';
import test from 'node:test';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

// #7206: scraped title/description are interpolated into CDATA without escaping
// the terminator. A `]]>` in upstream text must not break the feed XML.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};

function restoreEnvironment() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ENV.url == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.url;
  if (ORIGINAL_ENV.token == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.token;
}

/** Concatenate every CDATA section inside an element body. */
function cdataText(elementXml) {
  const parts = [];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let match;
  while ((match = re.exec(elementXml)) !== null) parts.push(match[1]);
  return parts.join('');
}

function titleFromRss(rss) {
  const item = rss.match(/<item>[\s\S]*?<\/item>/);
  assert.ok(item, 'feed must contain an <item>');
  const title = item[0].match(/<title>([\s\S]*?)<\/title>/);
  assert.ok(title, 'item must contain a <title>');
  return cdataText(title[1]);
}

function descriptionFromRss(rss) {
  const item = rss.match(/<item>[\s\S]*?<\/item>/);
  assert.ok(item, 'feed must contain an <item>');
  const description = item[0].match(/<description>([\s\S]*?)<\/description>/);
  assert.ok(description, 'item must contain a <description>');
  return cdataText(description[1]);
}

const DANGEROUS_TITLE = 'Before ]]> After title here';
const DANGEROUS_DESCRIPTION = 'Description with ]]> terminator sequence and padding';

const ARCHIVE_HTML = `
<div class="embla__slide">
  <a href="/p/cdata-break"></a>
  <img alt="${DANGEROUS_TITLE}" />
  <span>Jan 12, 2026</span>
  <div class="line-clamp-3"><span>${DANGEROUS_DESCRIPTION}</span></div>
</div>
`;

function installStub({ html = ARCHIVE_HTML, cached = null } = {}) {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://redis.example.test/get/')) {
      return new Response(JSON.stringify({ result: cached === null ? null : JSON.stringify(cached) }), { status: 200 });
    }
    if (url === 'https://redis.example.test/pipeline') {
      return new Response(JSON.stringify([{ result: 'OK' }, { result: 'OK' }]), { status: 200 });
    }
    if (url.startsWith('https://www.fwdstart.me/')) {
      return new Response(html, { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };
}

const request = () => new Request('https://worldmonitor.app/api/fwdstart');

test('title containing ]]> still yields well-formed RSS with the literal preserved', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  installStub();

  const { default: handler } = await import('../api/fwdstart.js');
  const res = await handler(request(), undefined);
  assert.equal(res.status, 200);
  const rss = await res.text();

  const validation = XMLValidator.validate(rss);
  assert.equal(validation, true, `feed must be well-formed XML; got ${JSON.stringify(validation)}`);
  assert.equal(titleFromRss(rss), DANGEROUS_TITLE);
  assert.equal(descriptionFromRss(rss), DANGEROUS_DESCRIPTION);
});

test('cdata() splits the terminator and strips illegal control characters', async () => {
  const { cdata } = await import('../api/fwdstart.js');
  assert.equal(cdata('a]]>b'), '<![CDATA[a]]]]><![CDATA[>b]]>');
  assert.equal(cdata('safe'), '<![CDATA[safe]]>');
  assert.equal(cdata('x\x00y\x08z'), '<![CDATA[xyz]]>');
});

const INJECTED_HREF = "/p/</link><script xmlns='http://www.w3.org/1999/xhtml' nonce='wm-static-bootstrap'>alert(1)</script><link>";
const INVALID_PATHS = [
  INJECTED_HREF,
  '/p/</link></item><item><title>Forged item</title></item><item><link>',
  '/p/bad&entity;', '/p/bad\'quote', '/p/bad]]>slug', '/p/bad<slug',
  '/p/bad%3Cslug', '/p/nested/slug', '/p/', '/p/bad slug',
];

test('scraped links cannot add XML nodes and valid post URLs survive', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const html = INVALID_PATHS.map((href) => `<div class="embla__slide">
    <a href="${href}"></a><img alt="Rejected post title" />
  </div>`).join('') + ARCHIVE_HTML + `<div class="embla__slide">
    <a href="/p/Post_123-slug?x=1&amp;y=2#section"></a><img alt="Valid query post" />
  </div>`;
  installStub({ html });
  const { default: handler } = await import('../api/fwdstart.js');
  const response = await handler(request());
  assert.equal(response.status, 200);
  const rss = await response.text();
  assert.equal(XMLValidator.validate(rss), true);
  const items = new XMLParser().parse(rss).rss.channel.item;
  assert.deepEqual(items.map(({ link }) => link), [
    'https://www.fwdstart.me/p/cdata-break',
    'https://www.fwdstart.me/p/Post_123-slug',
  ]);
  for (const item of items) assert.equal(item.guid, item.link);
  assert.doesNotMatch(rss, /<script|Forged item|Rejected post title/);
  assert.match(rss, /<link><!\[CDATA\[https:\/\/www\.fwdstart\.me\/p\/cdata-break\]\]><\/link>/);
  assert.match(rss, /<guid><!\[CDATA\[https:\/\/www\.fwdstart\.me\/p\/cdata-break\]\]><\/guid>/);
});

test('cached links are validated before serialization without re-scraping valid items', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const invalidLinks = [
    ...INVALID_PATHS.map((path) => `https://www.fwdstart.me${path}`),
    'https://evil.example/p/post', 'https://www.fwdstart.me.evil.example/p/post',
    'http://www.fwdstart.me/p/post', 'https://user:pass@www.fwdstart.me/p/post',
    'https://www.fwdstart.me:8443/p/post', 'javascript:alert(1)', 'http://[', null,
  ];
  const item = (link) => ({ title: 'Cached post title', link, date: '2026-01-12T00:00:00.000Z', description: '' });
  installStub({
    html: '<div>must not scrape on a valid cache hit</div>',
    cached: [...invalidLinks.map(item), null, item('https://www.fwdstart.me/p/Cached_123?x=1&y=2#section')],
  });
  const { default: handler } = await import('../api/fwdstart.js');
  const response = await handler(request());
  assert.equal(response.status, 200);
  const rss = await response.text();
  assert.equal(XMLValidator.validate(rss), true);
  const parsed = new XMLParser().parse(rss).rss.channel.item;
  assert.equal(parsed.title, 'Cached post title');
  assert.equal(parsed.link, 'https://www.fwdstart.me/p/Cached_123');
  assert.equal(parsed.guid, parsed.link);
  assert.doesNotMatch(rss, /<script|Forged item/);
});

test('a cache containing only rejected links falls back to the live archive', async (t) => {
  t.after(restoreEnvironment);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  installStub({ cached: [{ title: 'Poisoned post', link: `https://www.fwdstart.me${INJECTED_HREF}` }] });
  const { default: handler } = await import('../api/fwdstart.js');
  const response = await handler(request());
  assert.equal(response.status, 200);
  const rss = await response.text();
  assert.equal(XMLValidator.validate(rss), true);
  assert.equal(titleFromRss(rss), DANGEROUS_TITLE);
  assert.doesNotMatch(rss, /Poisoned post|<script/);
});
