import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__, decodeFeedBody } from '../server/worldmonitor/news/v1/list-feed-digest';

// Folha de S.Paulo's feed (feeds.folha.uol.com.br) is ISO-8859-1 with no
// charset on its Content-Type, and every item link goes through its
// redir.folha.com.br click counter with the article URL after a `*`.
const FOLHA_FEED = {
  name: 'Folha de S.Paulo',
  url: 'https://feeds.folha.uol.com.br/emcimadahora/rss091.xml',
  lang: 'pt',
};
const ARTICLE = 'https://www1.folha.uol.com.br/esporte/2026/10/vice-presidente-renuncia.shtml';
const folhaXml = (pubDate: string) => `<?xml version="1.0" encoding="ISO-8859-1" ?>
<rss version="0.91">
<channel>
<title>Folha de S.Paulo - Em cima da hora - Principal</title>
<item>
<title>Vice-presidente da Federação Japonesa renuncia após apoio da Ásia</title>
<link>https://redir.folha.com.br/redir/online/emcimadahora/rss091/*${ARTICLE}</link>
<description>Texto</description>
<pubDate>${pubDate}</pubDate>
</item>
</channel>
</rss>`;

function rfc822(ms: number): string {
  return new Date(ms).toUTCString().replace('GMT', '+0000');
}

describe('decodeFeedBody: decode a feed in the charset it declares', () => {
  it('decodes an ISO-8859-1 body declared in the XML prolog', () => {
    const bytes = new Uint8Array(Buffer.from(folhaXml(rfc822(Date.now())), 'latin1'));
    const text = decodeFeedBody(bytes, 'text/xml');
    assert.match(text, /Federação Japonesa renuncia após apoio da Ásia/);
  });

  it('prefers the Content-Type charset over the prolog', () => {
    const bytes = new Uint8Array(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><rss><item><title>Ásia</title></item></rss>', 'latin1'));
    assert.match(decodeFeedBody(bytes, 'application/rss+xml; charset=ISO-8859-1'), /Ásia/);
  });

  it('keeps UTF-8 bodies, and an unknown label falls back to UTF-8', () => {
    const bytes = new Uint8Array(Buffer.from('<?xml version="1.0" encoding="x-unknown-label"?><rss><item><title>Ásia</title></item></rss>', 'utf8'));
    assert.match(decodeFeedBody(bytes, 'text/xml'), /Ásia/);
    assert.match(decodeFeedBody(new Uint8Array(Buffer.from('<rss><title>Ásia</title></rss>', 'utf8')), null), /Ásia/);
  });

  it('detects UTF-16 from its byte-order mark in both byte orders', () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><rss><item><title>Ásia</title></item></rss>';
    const le = new Uint8Array([0xff, 0xfe, ...Buffer.from(xml, 'utf16le')]);
    const be = new Uint8Array([0xfe, 0xff, ...Buffer.from(xml, 'utf16le').swap16()]);
    for (const bytes of [le, be]) {
      const text = decodeFeedBody(bytes, 'text/xml');
      assert.ok(text.startsWith('<?xml'), 'the BOM is consumed and the prolog is readable');
      assert.match(text, /<title>Ásia<\/title>/);
    }
  });

  it('lets a byte-order mark override a wrong Content-Type charset', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('<rss><title>Ásia</title></rss>', 'utf8')]);
    assert.match(decodeFeedBody(bytes, 'text/xml; charset=ISO-8859-1'), /Ásia/);
  });
});

describe('parseRssXml: a publisher click-counter link resolves to the article', () => {
  it('unwraps the redirect after `*` and keeps the Folha article link', () => {
    const result = __testing__.parseRssXml(folhaXml(rfc822(Date.now() - 60_000)), FOLHA_FEED, 'full');
    assert.ok(result, 'parse must succeed');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].link, ARTICLE);
  });

  it('still blanks a wrapped link whose target leaves the publisher', () => {
    const xml = folhaXml(rfc822(Date.now() - 60_000))
      .replace(ARTICLE, 'https://evil.example/phish');
    const result = __testing__.parseRssXml(xml, FOLHA_FEED, 'full');
    assert.ok(result, 'parse must succeed');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, 'Vice-presidente da Federação Japonesa renuncia após apoio da Ásia');
    assert.equal(result.items[0].link, '');
  });
});
