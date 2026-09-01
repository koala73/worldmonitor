import assert from 'node:assert/strict';
import test from 'node:test';
import { XMLValidator } from 'fast-xml-parser';

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

function installStub() {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://redis.example.test/get/')) {
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    if (url === 'https://redis.example.test/pipeline') {
      return new Response(JSON.stringify([{ result: 'OK' }, { result: 'OK' }]), { status: 200 });
    }
    if (url.startsWith('https://www.fwdstart.me/')) {
      return new Response(ARCHIVE_HTML, { status: 200 });
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
