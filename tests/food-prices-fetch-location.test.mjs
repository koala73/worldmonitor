import assert from 'node:assert/strict';
import { test } from 'node:test';
import { links, utf8Header } from '../scripts/lib/food-prices-fetch.mjs';

test('redirect Location with raw UTF-8 bytes resolves to the publisher file, not mojibake', () => {
  // stat.gov.kz answers /api/iblock/element/<id>/file/en/ with a raw UTF-8 Cyrillic file name; fetch exposes it as Latin-1.
  const raw = Buffer.from('https://stat.gov.kz:443/upload/iblock/41c/x/Т-15-05-Н (28.10.2026) англ.xlsx', 'utf8').toString('latin1');
  assert.equal(new URL(utf8Header(raw)).pathname, '/upload/iblock/41c/x/%D0%A2-15-05-%D0%9D%20(28.10.2026)%20%D0%B0%D0%BD%D0%B3%D0%BB.xlsx');
  assert.equal(utf8Header('/ascii/path.pdf'), '/ascii/path.pdf');
  assert.equal(utf8Header('/caf\xe9.pdf'), '/caf\xe9.pdf');
  assert.equal(utf8Header(null), null);
});

test('link extraction resolves hrefs and stays linear when anchors never close', () => {
  assert.deepEqual(links('<a class="x" href="/r.pdf">Report &amp; <b>data</b></a> <a href="https://[bad">skip</a>', 'https://example.gov/a/'),
    [{ url: 'https://example.gov/r.pdf', text: 'Report & data' }]);
  for (const hostile of ['<a href="/x">'.repeat(60000), '<a href="/x'.repeat(60000)]) {
    const started = performance.now();
    links(hostile, 'https://example.gov/');
    assert.ok(performance.now() - started < 1000, `${hostile.slice(0, 12)} took ${Math.round(performance.now() - started)} ms`);
  }
});
