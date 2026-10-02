import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { load } from 'js-yaml';

import handler from '../api/md-twin.ts';
import {
  MAX_TWIN_BYTES,
  MD_TWIN_LOOP_HEADER,
  buildMarkdownTwinResponse,
  htmlToMarkdown,
  isMarkdownTwinPath,
  resolveMarkdownTwinPath,
  siblingPathFromMarkdown,
} from '../api/_md-url-twin.ts';

it('preserves escaped text while decoding one entity layer in Markdown', () => {
  const markdown = htmlToMarkdown(
    '<main><h1>Literal &lt;name&gt;</h1><p>Nested &amp;lt;name&amp;gt;</p><ul><li>Keep &lt;value&gt;</li></ul></main>',
    'Fallback',
  );
  assert.equal(markdown, '# Literal <name>\n\n Nested &lt;name&gt;\n\n- Keep <value>');
});

it('does not decode entities produced by numeric ampersands', () => {
  assert.equal(htmlToMarkdown('<main><p>&#38;amp; &amp;#38; &#38;lt;</p></main>', 'Title'),
    '# Title\n\n&amp; &#38; &lt;');
});

it('decodes hexadecimal and apostrophe entities once with the numeric safety bounds', () => {
  assert.equal(htmlToMarkdown('<main><h1>It&#x27;s &apos;ready&apos;</h1><p>&#X1F600; &#x26;lt; a&#x7;b&#xD800;&#x110000;</p></main>', 'Title'),
    "# It's 'ready'\n\n 😀 &lt; ab");
});

it('keeps definition labels and values together across adjacent stat cells', () => {
  const markdown = htmlToMarkdown('<main><dl><div><dt>Providers</dt><dd><a href="/sources/?utm_source=hero">748</a></dd></div><div><dt>Alert origins</dt><dd>5</dd></div></dl></main>', 'Title');
  assert.equal(markdown, '# Title\n\n- Providers: [748](/sources/)\n\n- Alert origins: 5');
});

it('removes only tracking query parameters and separates block links from following values', () => {
  const markdown = htmlToMarkdown('<main><a href="/sources/?utm_source=hero&amp;country=US&amp;utm_content=proof#catalog"><div>748</div><div>Providers</div></a><div>5</div><a href="https://example.com/?q=two%20words&amp;utm_medium=ref">External</a><a href="#depth">Depth</a></main>', 'Title');
  assert.match(markdown, /\[748 Providers\]\(\/sources\/\?country=US#catalog\)\n/);
  assert.match(markdown, /https:\/\/example.com\/\?q=two%20words/);
  assert.match(markdown, /\[Depth\]\(#depth\)/);
  assert.doesNotMatch(markdown, /utm_/);
});

it('preserves functional queries and fragments encoded as numeric HTML entities', () => {
  for (const separator of ['&#38;', '&#x26;', '&#X26;', '&amp;']) {
    for (const query of [`q=1${separator}utm_source=a${separator}page=2`, `utm_source=a${separator}q=1${separator}page=2`]) {
      assert.equal(htmlToMarkdown(`<a href="/x?${query}&#35;results">Results</a>`, 'Title'),
        '# Title\n\n[Results](/x?q=1&page=2#results)');
    }
  }
  assert.equal(htmlToMarkdown('<a href="/x?q=&amp;lt;value&amp;gt;&amp;utm_source=a">Results</a>', 'Title'),
    '# Title\n\n[Results](/x?q=&lt;value&gt;)');
});

// stripTags no longer decodes, so the <title> path carries its own
// decodeHtmlEntities() call. Dropping that wrapper is an easy refactor mistake
// and every other <title> fixture in this file is plain text, so pin it here.
it('decodes one entity layer in the <title> fallback heading', () => {
  assert.equal(htmlToMarkdown('<html><title>News &amp; Views</title><main><p>Body.</p></main></html>', 'Fallback'),
    '# News & Views\n\nBody.');
});

// The numeric branch's rejection arm. `&#7;` is below the 0x20 floor and must
// vanish rather than land a control character in the emitted Markdown.
it('drops numeric entities below the control-character floor', () => {
  assert.equal(htmlToMarkdown('<main><p>a&#7;b</p></main>', 'Title'), '# Title\n\nab');
});

// `String.fromCharCode` coerces with ToUint16, so a code point above 0xFFFF
// wraps back under the `>= 32` guard: `&#65596;` (60 + 0x10000) used to yield a
// literal `<`. fromCodePoint with an explicit range check closes that and stops
// truncating astral characters.
it('does not let astral numeric entities wrap past the control-character guard', () => {
  assert.equal(htmlToMarkdown('<main><p>&#65596;script&#65598;</p></main>', 'Title'),
    '# Title\n\n\u{1003C}script\u{1003E}');
  assert.equal(htmlToMarkdown('<main><p>&#128512;</p></main>', 'Title'), '# Title\n\n\u{1F600}');
  assert.equal(htmlToMarkdown('<main><p>a&#999999999999999999999;b</p></main>', 'Title'), '# Title\n\nab');
});

/**
 * Sequences sibling responses across a redirect chain. Each entry answers one
 * hop, so a test can assert what the twin does with the LAST hop rather than
 * with the 308 that every trailing-slash URL on this site emits first.
 */
function siblingChain(...responses) {
  const seen = [];
  const fetchImpl = async (input, init) => {
    seen.push({ url: new URL(String(input)), init });
    const next = responses[seen.length - 1];
    if (!next) throw new Error(`unexpected sibling fetch #${seen.length}: ${String(input)}`);
    return next;
  };
  return { fetchImpl, seen };
}

describe('markdown URL-fallback helpers', () => {
  it('accepts /{page}.md paths and maps them to the sibling', () => {
    assert.equal(isMarkdownTwinPath('/dashboard.md'), true);
    assert.equal(isMarkdownTwinPath('/stocks/AAPL.md'), true);
    assert.equal(isMarkdownTwinPath('/api/health.md'), true);
    assert.equal(isMarkdownTwinPath('/dashboard'), false);
    assert.equal(isMarkdownTwinPath('/../etc.md'), false);
    assert.equal(siblingPathFromMarkdown('/dashboard.md'), '/dashboard');
    assert.equal(siblingPathFromMarkdown('/api/health.md'), '/api/health');
  });

  it('resolves /api/md-twin?path= to a sanitized .md path', () => {
    const req = new Request('https://www.worldmonitor.app/api/md-twin?path=dashboard');
    assert.equal(resolveMarkdownTwinPath(req), '/dashboard.md');
    const evil = new Request('https://www.worldmonitor.app/api/md-twin?path=https://evil.example/x');
    assert.equal(resolveMarkdownTwinPath(evil), null);
  });

  it('converts HTML to heading-led markdown', () => {
    const md = htmlToMarkdown(
      '<html><head><title>Dashboard</title></head><body><h1>Live map</h1><p>Ships and jets.</p></body></html>',
      'fallback',
    );
    assert.match(md, /^# /m);
    assert.match(md, /Live map/);
    assert.match(md, /Ships and jets/);
    assert.doesNotMatch(md, /<html/i);
  });
});

describe('api/md-twin.ts vary coverage (#7616 U4)', () => {
  it('declares the loop-guard header in Vary so cached twins never replay across variants', async () => {
    const plain = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md'),
      '/dashboard.md',
      async () => new Response('<html><title>T</title><h1>H</h1></html>', { status: 200 }),
    );
    assert.match(plain.headers.get('vary') ?? '', new RegExp(MD_TWIN_LOOP_HEADER, 'i'));

    const looped = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md', {
        headers: { [MD_TWIN_LOOP_HEADER]: '1' },
      }),
      '/dashboard.md',
    );
    assert.equal(looped.status, 404);
    assert.match(looped.headers.get('vary') ?? '', new RegExp(MD_TWIN_LOOP_HEADER, 'i'));
  });
});

describe('api/md-twin.ts', () => {
  // #7860: every content URL on this site 308s from `/x` to `/x/`, so with
  // `redirect: 'manual'` the twin answered EVERY path with a ~250-byte "this
  // resource redirects to" stub — a self-canonical, CDN-cached, indexable 200
  // over an unbounded `.md` space. The twin must follow the hop and serve the
  // document, and must inherit the target's status when there is no document.
  it('follows a same-origin redirect and serves the target document', async () => {
    const { fetchImpl, seen } = siblingChain(
      new Response(null, { status: 308, headers: { location: '/countries/' } }),
      new Response('---\ntitle: Countries\n---\n\n# Countries\n\nEvery country page.\n', {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      }),
    );

    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/countries.md'),
      '/countries.md',
      fetchImpl,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seen.map((hop) => hop.url.pathname), ['/countries', '/countries/']);
    for (const hop of seen) {
      assert.equal(
        new Headers(hop.init?.headers).get(MD_TWIN_LOOP_HEADER),
        '1',
        'the loop guard must survive every hop, or a .md redirect target recurses',
      );
    }
    assert.equal(
      response.headers.get('x-robots-tag'),
      null,
      'a twin that serves the real document stays indexable and defers to its canonical',
    );
    const document = await response.text();
    assert.doesNotMatch(document, /redirects to/i, 'the redirect stub must be gone');
    assert.match(document, /Every country page\./);
    const block = document.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(block, 'the twin must carry front-matter');
    assert.deepEqual(load(block[1]), {
      title: 'Countries',
      canonical: 'https://www.worldmonitor.app/countries/',
    });
    assert.match(
      response.headers.get('link') ?? '',
      /<https:\/\/www\.worldmonitor\.app\/countries\/>; rel="canonical"/,
      'the canonical must name the HTML page, never the .md twin itself',
    );
  });

  it('inherits a 404 from the redirect target instead of inventing a 200', async () => {
    const { fetchImpl } = siblingChain(
      new Response(null, { status: 308, headers: { location: '/countries/does-not-exist-xyz/' } }),
      new Response('<html><head><meta name="robots" content="noindex"><title>Page not found</title></head></html>', {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/countries/does-not-exist-xyz.md'),
      '/countries/does-not-exist-xyz.md',
      fetchImpl,
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
    assert.doesNotMatch(
      response.headers.get('link') ?? '',
      /rel="canonical"/,
      'a soft-404 must never declare itself canonical',
    );
  });

  it('asks the sibling for markdown before HTML', async () => {
    const { fetchImpl, seen } = siblingChain(
      new Response('# Iran\n\nThe real document.\n', {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      }),
    );

    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/countries/iran.md'),
      '/countries/iran.md',
      fetchImpl,
    );

    const accept = new Headers(seen[0].init?.headers).get('accept') ?? '';
    assert.match(accept, /^text\/markdown\b/, `the sibling Accept must lead with markdown, got: ${accept}`);
    assert.match(await response.text(), /The real document\./);
  });

  it('does not leak the rewrite params into the sibling request', async () => {
    const originalFetch = globalThis.fetch;
    const { fetchImpl, seen } = siblingChain(
      new Response('# AAPL\n', { status: 200, headers: { 'content-type': 'text/markdown' } }),
    );
    globalThis.fetch = fetchImpl;
    try {
      await handler(
        new Request('https://www.worldmonitor.app/api/md-twin?path=stocks%2FAAPL&mdPath=stocks%2FAAPL&range=1y'),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(seen[0].url.pathname, '/stocks/AAPL');
    assert.equal(seen[0].url.searchParams.get('path'), null);
    assert.equal(seen[0].url.searchParams.get('mdPath'), null);
    assert.equal(seen[0].url.searchParams.get('range'), '1y', 'caller query params still reach the sibling');
  });

  it('stops following after the redirect hop limit', async () => {
    const { fetchImpl, seen } = siblingChain(
      ...Array.from({ length: 8 }, (_, hop) =>
        new Response(null, { status: 308, headers: { location: `/loop-${hop + 1}/` } }),
      ),
    );

    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/loop-0.md'),
      '/loop-0.md',
      fetchImpl,
    );

    // Pin the count, not just the eventual 404: asserting the status alone
    // passes for any budget, so a change to MAX_SIBLING_REDIRECTS would slip
    // through and multiply the worst-case latency unnoticed.
    assert.deepEqual(
      seen.map((hop) => hop.url.pathname),
      ['/loop-0', '/loop-1/', '/loop-2/', '/loop-3/'],
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  });

  it('spends one deadline across the whole redirect chain', async () => {
    const signals = [];
    const { fetchImpl } = siblingChain(
      new Response(null, { status: 308, headers: { location: '/countries/' } }),
      new Response('# Countries\n', { status: 200, headers: { 'content-type': 'text/markdown' } }),
    );

    await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/countries.md'),
      '/countries.md',
      async (input, init) => {
        signals.push(init?.signal);
        return fetchImpl(input, init);
      },
    );

    // A fresh AbortSignal.timeout per hop multiplies the budget by the hop
    // count, and four hops at 8s each overruns the edge execution ceiling.
    assert.equal(signals.length, 2);
    assert.ok(signals[0], 'every hop must carry a deadline');
    assert.equal(signals[0], signals[1], 'all hops must share one deadline');
  });

  it('serves a document larger than the retired 80 KB cap', async () => {
    const huge = `# Sources\n\n${'source entry. '.repeat(10_000)}`;
    assert.ok(huge.length > 80_000, 'fixture must exceed the cap that used to 502 /sources.md');
    const { fetchImpl } = siblingChain(
      new Response(null, { status: 308, headers: { location: '/sources/' } }),
      new Response(huge, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } }),
    );

    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/sources.md'),
      '/sources.md',
      fetchImpl,
    );

    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 80_000);
  });

  it('adds escaped title and canonical metadata to generated documents', async () => {
    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/example.md'),
      '/example.md',
      async () => new Response('<h1>Title: &quot;quoted&quot;</h1><p>Content.</p>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const document = await response.text();
    const block = document.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(block);
    assert.deepEqual(load(block[1]), {
      title: 'Title: "quoted"',
      canonical: 'https://www.worldmonitor.app/example',
    });
    assert.match(document, /Content\./);
  });

  it('merges the canonical into front-matter the sibling already emitted', async () => {
    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/example.md'),
      '/example.md',
      async () =>
        new Response('---\ntitle: Upstream title\ndescription: Upstream description\n---\n\n# Heading\n', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
    );

    const block = (await response.text()).match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(block);
    assert.deepEqual(load(block[1]), {
      title: 'Upstream title',
      description: 'Upstream description',
      canonical: 'https://www.worldmonitor.app/example',
    });
  });

  it('keeps the canonical query-less, the way the sibling page canonicalises itself', async () => {
    const originalFetch = globalThis.fetch;
    const { fetchImpl } = siblingChain(
      new Response('# AAPL\n', { status: 200, headers: { 'content-type': 'text/markdown' } }),
    );
    globalThis.fetch = fetchImpl;
    let response;
    try {
      response = await handler(
        new Request('https://www.worldmonitor.app/api/md-twin?path=stocks%2FAAPL&range=1y'),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // /stocks/AAPL?range=1y emits <link rel="canonical" href=".../dashboard">,
    // so a query-bearing twin canonical would chain, and every param value
    // would mint another indexable twin URL.
    assert.match(
      response.headers.get('link') ?? '',
      /<https:\/\/www\.worldmonitor\.app\/stocks\/AAPL>; rel="canonical"/,
    );
    assert.doesNotMatch(response.headers.get('link') ?? '', /range=1y/);
    assert.doesNotMatch(await response.text(), /range=1y/);
  });

  it('keeps front-matter intact when the sibling document has no H1', async () => {
    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/example.md'),
      '/example.md',
      async () =>
        new Response('---\ntitle: Upstream title\n---\n\nBody with no heading.\n', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
    );

    const document = await response.text();
    assert.ok(document.startsWith('---\n'), `front-matter must stay first, got: ${document.slice(0, 40)}`);
    const block = document.match(/^---\n([\s\S]*?)\n---\n/);
    assert.deepEqual(load(block[1]), {
      title: 'Upstream title',
      canonical: 'https://www.worldmonitor.app/example',
    });
    assert.match(document, /^# example$/m, 'the twin stays heading-led below the front-matter');
    assert.match(document, /Body with no heading\./);
  });

  it('re-quotes pass-through front-matter so the canonical stays parseable', async () => {
    // Live 2026-09-08, /dashboard and /chokepoints/strait-of-hormuz/ both emit
    // `description: <text>: <more text>` unquoted. A plain YAML scalar cannot
    // contain ": ", so copying the block byte-for-byte and appending our
    // canonical produces a block no consumer can parse -- which defeats the
    // point of appending the canonical at all.
    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md'),
      '/dashboard.md',
      async () =>
        new Response(
          '---\ntitle: World Monitor - Real-Time Global Intelligence Dashboard\ndescription: Real-time global intelligence: conflicts, markets, military.\nimage: https://www.worldmonitor.app/favico/og-image.png\n---\n\n# Dashboard\n',
          { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } },
        ),
    );

    const block = (await response.text()).match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(block);
    const parsed = load(block[1]);
    assert.equal(parsed.canonical, 'https://www.worldmonitor.app/dashboard');
    assert.equal(parsed.description, 'Real-time global intelligence: conflicts, markets, military.');
    assert.equal(parsed.image, 'https://www.worldmonitor.app/favico/og-image.png');
  });

  it('replaces a canonical the sibling front-matter already declared', async () => {
    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/example.md'),
      '/example.md',
      async () =>
        new Response('---\ntitle: Upstream\ncanonical: https://elsewhere.example/wrong\n---\n\n# Heading\n', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
    );

    const block = (await response.text()).match(/^---\n([\s\S]*?)\n---\n/);
    assert.deepEqual(load(block[1]), {
      title: 'Upstream',
      canonical: 'https://www.worldmonitor.app/example',
    });
  });

  it('does not mistake a leading thematic break for front-matter', async () => {
    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/example.md'),
      '/example.md',
      async () =>
        new Response('---\n\nAn essay that opens with a horizontal rule.\n\n---\n\nAnd continues.\n', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
    );

    const document = await response.text();
    const block = document.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(block);
    assert.deepEqual(load(block[1]), {
      title: 'example',
      canonical: 'https://www.worldmonitor.app/example',
    });
    assert.match(document, /An essay that opens with a horizontal rule\./);
    assert.match(document, /And continues\./);
  });

  it('omits the canonical for an API sibling, which is not a canonical web page', async () => {
    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/api/symbol-search.md?q=AAPL'),
      '/api/symbol-search.md',
      async () => new Response('{"results":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    assert.equal(response.status, 200);
    // A query-less canonical would name a different, degenerate resource: the
    // bare endpoint returns nothing without its required q. Claim no canonical
    // rather than the wrong one.
    assert.doesNotMatch(response.headers.get('link') ?? '', /rel="canonical"/);
    assert.doesNotMatch(await response.text(), /^canonical:/m);
  });

  it('refuses a redirect that targets another .md twin', async () => {
    const { fetchImpl, seen } = siblingChain(
      new Response(null, { status: 308, headers: { location: '/countries/iran.md' } }),
    );

    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/countries.md'),
      '/countries.md',
      fetchImpl,
    );

    assert.equal(seen.length, 1, 'the .md target must not be fetched');
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  });

  for (const location of ['//evil.example/x', 'https://user:pw@evil.example/x', 'http://www.worldmonitor.app/x']) {
    it(`treats ${location} as off-origin and never fetches it`, async () => {
      const { fetchImpl, seen } = siblingChain(new Response(null, { status: 302, headers: { location } }));

      const response = await buildMarkdownTwinResponse(
        new Request('https://www.worldmonitor.app/example.md'),
        '/example.md',
        fetchImpl,
      );

      assert.equal(seen.length, 1, 'an off-origin target must not be fetched');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex');
      assert.doesNotMatch(response.headers.get('link') ?? '', /rel="canonical"/);
    });
  }

  it('carries the status and canonical across a redirect on HEAD', async () => {
    const { fetchImpl, seen } = siblingChain(
      new Response(null, { status: 308, headers: { location: '/countries/' } }),
      new Response(null, { status: 200, headers: { 'content-type': 'text/markdown' } }),
    );

    const response = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/countries.md', { method: 'HEAD' }),
      '/countries.md',
      fetchImpl,
    );

    assert.deepEqual(seen.map((hop) => hop.init?.method), ['HEAD', 'HEAD']);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    assert.match(
      response.headers.get('link') ?? '',
      /<https:\/\/www\.worldmonitor\.app\/countries\/>; rel="canonical"/,
    );
  });

  it('returns the deprecation policy Link on OPTIONS preflights', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md', { method: 'OPTIONS' }),
      '/dashboard.md',
    );

    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('link') ?? '', /rel="deprecation"/);
    assert.match(res.headers.get('link') ?? '', /https:\/\/www\.worldmonitor\.app\/api-versioning\.md/);
  });

  it('returns heading-led markdown for a 200 HTML sibling', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/dashboard');
      assert.equal(init?.headers instanceof Headers ? init.headers.get(MD_TWIN_LOOP_HEADER) : null, '1');
      return new Response('<html><title>World Monitor</title><h1>Dashboard</h1><p>Live globe.</p></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    try {
      const res = await handler(new Request('https://www.worldmonitor.app/api/md-twin?path=dashboard'));
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.match(res.headers.get('link') ?? '', /rel="canonical"/);
      assert.match(res.headers.get('link') ?? '', /rel="deprecation"/);
      const body = await res.text();
      assert.match(body, /^# /m);
      assert.match(body, /Dashboard|World Monitor/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('documents an off-origin redirect without making it indexable', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/api/download.md'),
      '/api/download.md',
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/koala73/worldmonitor/releases/latest' },
        }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('location'), null);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    // The off-origin hop is not ours to follow, so the document stays a stub —
    // but a stub never advertises itself as canonical or indexable (#7860).
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.doesNotMatch(res.headers.get('link') ?? '', /rel="canonical"/);
    const body = await res.text();
    assert.match(body, /^# /m);
    assert.match(body, /github\.com\/koala73\/worldmonitor\/releases\/latest/);
    assert.doesNotMatch(body, /^canonical:/m);
  });

  it('preserves a bodyless 304 sibling', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md'),
      '/dashboard.md',
      async () => new Response(null, { status: 304, headers: { etag: 'dashboard-v1' } }),
    );

    assert.equal(res.status, 304);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), '');
  });

  it('uses an anonymous internal identity for the sibling request', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/api/latest-brief.md', {
        headers: {
          authorization: 'Bearer secret',
          cookie: 'wm_session=secret',
          'user-agent': 'Googlebot/2.1',
          'x-api-key': 'api-secret',
          'x-worldmonitor-key': 'wm-secret',
        },
      }),
      '/api/latest-brief.md',
      async (_input, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('user-agent'), 'WorldMonitor-MarkdownTwin/1.0');
        assert.equal(headers.get(MD_TWIN_LOOP_HEADER), '1');
        assert.equal(headers.get('authorization'), null);
        assert.equal(headers.get('cookie'), null);
        assert.equal(headers.get('x-api-key'), null);
        assert.equal(headers.get('x-worldmonitor-key'), null);
        return new Response('# Public brief\n');
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  });

  for (const { status, headers = {}, expectedHeader, expectedValue } of [
    {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="worldmonitor"' },
      expectedHeader: 'www-authenticate',
      expectedValue: 'Bearer realm="worldmonitor"',
    },
    { status: 403 },
    {
      status: 429,
      headers: { 'retry-after': '17' },
      expectedHeader: 'retry-after',
      expectedValue: '17',
    },
    { status: 500 },
  ]) {
    it(`preserves a ${status} sibling as a non-cacheable response`, async () => {
      const res = await buildMarkdownTwinResponse(
        new Request('https://www.worldmonitor.app/api/health.md'),
        '/api/health.md',
        async () => new Response('upstream failure', { status, headers }),
      );

      assert.equal(res.status, status);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-robots-tag'), 'noindex');
      assert.doesNotMatch(res.headers.get('link') ?? '', /rel="canonical"/);
      if (expectedHeader) assert.equal(res.headers.get(expectedHeader), expectedValue);
      assert.match(await res.text(), /^# health/m);
    });
  }

  it('rejects an oversized declared sibling body without reading it', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md'),
      '/dashboard.md',
      async () => new Response('small', { headers: { 'content-length': String(MAX_TWIN_BYTES + 1) } }),
    );

    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /could not be read/);
  });

  it('cancels a streamed sibling body that exceeds the byte cap', async () => {
    let canceled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_TWIN_BYTES + 1));
      },
      cancel() {
        canceled = true;
      },
    });

    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md'),
      '/dashboard.md',
      async () => new Response(body),
    );

    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(canceled, true);
  });

  it('maps sibling body-stream failures to a non-cacheable 502', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('body failed'));
      },
    });

    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md'),
      '/dashboard.md',
      async () => new Response(body),
    );

    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /could not be read/);
  });

  it('uses sibling HEAD and never reads a response body', async () => {
    const unreadableBody = {
      getReader() {
        throw new Error('HEAD must not read the body');
      },
    };
    const siblingResponse = {
      body: unreadableBody,
      headers: new Headers(),
      ok: true,
      status: 200,
    };

    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md', { method: 'HEAD' }),
      '/dashboard.md',
      async (_input, init) => {
        assert.equal(init?.method, 'HEAD');
        return siblingResponse;
      },
    );

    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });

  it('does not recurse when the loop header is present', async () => {
    const res = await buildMarkdownTwinResponse(
      new Request('https://www.worldmonitor.app/dashboard.md', {
        headers: { [MD_TWIN_LOOP_HEADER]: '1' },
      }),
      '/dashboard.md',
      async () => {
        throw new Error('sibling fetch must not run');
      },
    );
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.doesNotMatch(res.headers.get('link') ?? '', /rel="canonical"/);
    assert.match(await res.text(), /^# /m);
  });

  it('carries a byte cap that covers the heaviest corpus document', () => {
    // /sources/ answered 132,497 bytes of Accept-negotiated markdown on
    // 2026-09-08. The retired 80 KB cap would have 502'd /sources.md, which is
    // one of the URLs #7860 reported broken.
    assert.ok(
      MAX_TWIN_BYTES > 132_497,
      `MAX_TWIN_BYTES (${MAX_TWIN_BYTES}) must exceed the heaviest measured corpus document`,
    );
  });
});

it('does not publish script contents with noncanonical closing tags', () => {
  for (const closing of ['script ', 'script foo="bar"', 'script/']) {
    assert.equal(htmlToMarkdown(`<main><script>SECRET SCRIPT</${closing}><p>Public text</p></main>`, 'Title'), '# Title\n\nPublic text');
  }
});

it('does not treat NBSP as an HTML script end-tag delimiter', () => {
  const html = '<main><script>const marker="</script\u00a0>";PRIVATE_SCRIPT()</script><p>Public text</p></main>';
  assert.equal(htmlToMarkdown(html, 'Title'), '# Title\n\nPublic text');
});
