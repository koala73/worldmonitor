/**
 * Feed parity test — client vs server (PR #3715 review follow-up).
 *
 * The client feed config (`src/config/feeds.ts`) and the server-side digest
 * feed config (`server/worldmonitor/news/v1/_feeds.ts`) are independent files
 * that frequently share feed NAMES. When a publisher dies and we fall back
 * to Google News on one side but forget to mirror the change on the other,
 * the digest path keeps fetching the dead URL while the direct-RSS path is
 * healthy (or vice versa) — exactly the Blockworks drift caught on #3715.
 *
 * This test fails when a feed NAME appears on both sides with INCONSISTENT
 * routing — i.e. client uses Google News while server uses a direct upstream
 * URL (or vice versa). It does NOT require URL byte-equality (server uses a
 * `gn()` helper with slightly different topic terms in places), only that
 * both sides agree on the "Google News fallback or direct fetch" question.
 *
 * KNOWN_DRIFTS grandfathers in feeds that already drift at the time this
 * test landed. Each is its own per-feed judgment (some intentionally use
 * Google News on one side because the direct URL recently broke). New drift
 * fails the test. The set should SHRINK over time as feeds get reconciled,
 * not grow.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CLIENT_PATH = resolve(ROOT, 'src/config/feeds.ts');
const SERVER_PATH = resolve(ROOT, 'server/worldmonitor/news/v1/_feeds.ts');

/**
 * Extract feed name + a routing hint from a source file.
 *
 * Handles both shapes:
 *
 *     // inline
 *     { name: 'X', url: rss('https://...') },
 *     { name: 'Y', url: gn('site:y.com when:1d') },
 *
 *     // multiline with locale-keyed URL object (locale variants all use
 *     // direct rss/gn helpers, never mixed)
 *     {
 *       name: 'Z',
 *       url: {
 *         en: rss('...'),
 *         fr: rss('...'),
 *       },
 *     }
 *
 * The earlier single-line-only regex missed ~46 multiline entries on the
 * client side, which caused the orphan check below to falsely flag entries
 * that ARE on both sides (France 24, EuroNews, etc.) as server-only.
 *
 * Returns a Map<name, { isGoogleNews: boolean, snippet: string }>.
 */
function extractFeedRouting(filePath) {
  const src = readFileSync(filePath, 'utf-8');
  const out = new Map();
  const NAME_RE = /\bname:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = NAME_RE.exec(src)) !== null) {
    const [, name] = m;
    // Scan forward from this `name:` to find the matching `url:` — within
    // the next ~600 chars (enough to span a multiline locale-object url
    // without crossing into the sibling entry's name).
    const window = src.slice(m.index, m.index + 600);
    const urlMatch = window.match(/\burl:\s*([\s\S]*?)(?:,\s*$|}\s*[,\]])/m);
    if (!urlMatch) continue;
    const urlExpr = urlMatch[1];
    // Match the bare `gn(...)` helper AND any sibling like `gnLocale(...)` —
    // both emit `news.google.com/rss/search?...` URLs that the cache /
    // user-experience pipeline should treat identically. Don't widen this to
    // unrelated `gn*` identifiers; restrict to known prefixes that wrap GN.
    const isGN =
      /news\.google\.com\/rss\/search/i.test(urlExpr) ||
      /\bgn(?:Locale)?\s*\(/.test(urlExpr);
    // First-seen wins — names can repeat across categories (localized
    // variants etc.); the first definition is the canonical routing.
    if (!out.has(name)) {
      out.set(name, { isGoogleNews: isGN, snippet: urlExpr.trim().slice(0, 120) });
    }
  }
  return out;
}

/**
 * Extract feed names by their containing category array.
 *
 * A global name match is insufficient here: the digest truncates and the
 * client filters within each category, so a same-name client feed in another
 * category cannot make a server item visible. The client intentionally uses
 * CANONICAL_FEEDS, the cross-variant union for a category, when a user enables
 * a custom panel; this extractor mirrors that behavior by unioning catalogs
 * by category. Use the TypeScript AST so multiline entries remain visible.
 *
 * Returns a Map<category, Set<name>>.
 */
function extractFeedNamesByCategory(filePath) {
  const src = readFileSync(filePath, 'utf-8');
  const ast = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Map();

  const propertyName = (node) => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
    return null;
  };

  const collectNames = (category, elements) => {
    for (const element of elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      const nameProperty = element.properties.find(
        property =>
          ts.isPropertyAssignment(property) &&
          propertyName(property.name) === 'name' &&
          ts.isStringLiteral(property.initializer),
      );
      if (!nameProperty || !ts.isPropertyAssignment(nameProperty) || !ts.isStringLiteral(nameProperty.initializer)) {
        continue;
      }
      const names = out.get(category) ?? new Set();
      names.add(nameProperty.initializer.text);
      out.set(category, names);
    }
  };

  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && ts.isArrayLiteralExpression(node.initializer)) {
      const category = propertyName(node.name);
      if (category) collectNames(category, node.initializer.elements);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'INTEL_SOURCES' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      collectNames('intel', node.initializer.elements);
    }
    ts.forEachChild(node, visit);
  };

  visit(ast);
  return out;
}

const stringArgument = (expression, index) => {
  const argument = expression.arguments[index];
  return ts.isStringLiteralLike(argument) ? argument.text : null;
};

/**
 * Resolve a feed initializer to the upstream URL(s) it denotes. Locale-keyed
 * URL objects can intentionally contain more than one URL; callers compare
 * every returned member rather than silently choosing an English default.
 */
function extractUpstreamUrls(initializer) {
  if (ts.isStringLiteralLike(initializer)) return [initializer.text];

  if (ts.isObjectLiteralExpression(initializer)) {
    return initializer.properties.flatMap(property => {
      if (!ts.isPropertyAssignment(property)) return [];
      return extractUpstreamUrls(property.initializer);
    });
  }

  if (!ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)) return [];
  const helper = initializer.expression.text;
  if ((helper === 'rss' || helper === 'railwayRss') && initializer.arguments.length === 1) {
    const upstream = stringArgument(initializer, 0);
    return upstream === null ? [] : [upstream];
  }
  if (helper === 'gn' && initializer.arguments.length === 1) {
    const query = stringArgument(initializer, 0);
    return query === null
      ? []
      : [
          `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
        ];
  }
  if (helper === 'gnLocale' && initializer.arguments.length === 4) {
    const [query, hl, gl, ceid] = [0, 1, 2, 3].map(index => stringArgument(initializer, index));
    if ([query, hl, gl, ceid].some(value => value === null)) return [];
    return [
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`,
    ];
  }
  return [];
}

function canonicalizeUpstreamUrl(upstream) {
  const url = new URL(upstream);
  url.hash = '';
  url.host = url.host.toLowerCase();
  const parameters = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
  url.search = '';
  for (const [name, value] of parameters) url.searchParams.append(name, value);
  return url.toString();
}

function findVariableInitializerInSource(source, filePath, variableName) {
  const ast = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let initializer = null;
  const visit = node => {
    if (
      initializer === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      initializer = node.initializer ?? null;
    }
    if (initializer === null) ts.forEachChild(node, visit);
  };
  visit(ast);
  return initializer;
}

function findVariableInitializer(filePath, variableName) {
  return findVariableInitializerInSource(readFileSync(filePath, 'utf-8'), filePath, variableName);
}

/**
 * Extract the full-variant catalog with enough context to compare URLs.
 *
 * The routing test above intentionally ignores query differences, but a shared
 * name whose sides point at different publishers is still two different feeds.
 * Scope this strict comparison to FULL_FEEDS versus VARIANT_FEEDS.full; the
 * variant-specific catalogs are not required to duplicate the full catalog.
 */
function extractFullFeedsByCategory(filePath, side) {
  const initializer = findVariableInitializer(
    filePath,
    side === 'client' ? 'FULL_FEEDS' : 'VARIANT_FEEDS',
  );
  assert.ok(initializer, `Unable to locate the ${side} full-feed declaration in ${filePath}`);
  const record = ts.isObjectLiteralExpression(initializer) ? initializer : null;
  if (side === 'server') {
    const fullVariant = record?.properties.find(
      property => ts.isPropertyAssignment(property) && property.name.getText() === 'full',
    );
    assert.ok(ts.isPropertyAssignment(fullVariant), 'VARIANT_FEEDS must contain a full variant');
    assert.ok(ts.isObjectLiteralExpression(fullVariant.initializer));
    return extractFeedRecord(fullVariant.initializer, filePath);
  }
  assert.ok(record);
  return extractFeedRecord(record, filePath);
}

function extractFeedRecord(record, filePath) {
  const out = new Map();
  for (const categoryProperty of record.properties) {
    assert.ok(
      ts.isPropertyAssignment(categoryProperty),
      `${filePath} full-feed catalog contains an unsupported category entry: ${categoryProperty.getText()}`,
    );
    const category = categoryProperty.name.getText().replace(/^['"]|['"]$/g, '');
    assert.ok(
      ts.isArrayLiteralExpression(categoryProperty.initializer),
      `${filePath} category ${category} must use an inline array literal`,
    );
    let parsedCount = 0;
    for (const element of categoryProperty.initializer.elements) {
      assert.ok(
        ts.isObjectLiteralExpression(element),
        `${filePath} category ${category} contains an unsupported feed entry: ${element.getText()}`,
      );
      const nameProperty = element.properties.find(property => {
        return (
          ts.isPropertyAssignment(property) &&
          property.name.getText().replace(/^['"]|['"]$/g, '') === 'name' &&
          ts.isStringLiteralLike(property.initializer)
        );
      });
      const urlProperty = element.properties.find(property => {
        return (
          ts.isPropertyAssignment(property) &&
          property.name.getText().replace(/^['"]|['"]$/g, '') === 'url'
        );
      });
      assert.ok(
        ts.isPropertyAssignment(nameProperty) && ts.isStringLiteralLike(nameProperty.initializer),
        `${filePath} category ${category} contains a feed without an inline string name`,
      );
      assert.ok(
        ts.isPropertyAssignment(urlProperty),
        `${filePath} feed ${category}:${nameProperty.initializer.text} has no inline URL`,
      );
      const name = nameProperty.initializer.text;
      const urls = extractUpstreamUrls(urlProperty.initializer).map(canonicalizeUpstreamUrl);
      if (urls.length === 0) {
        throw new Error(`Unable to resolve a URL for ${filePath} feed ${category}:${name}`);
      }
      const key = `${category}:${name}`;
      const existing = out.get(key) ?? new Set();
      for (const url of urls) existing.add(url);
      out.set(key, existing);
      parsedCount += 1;
    }
    assert.ok(parsedCount > 0, `No feeds parsed from ${filePath} category ${category}`);
  }
  return out;
}

function assertReasonedExceptions(exceptions, label) {
  for (const [key, reason] of exceptions) {
    assert.equal(typeof reason, 'string', `${label} ${key} must have a written reason`);
    assert.ok(reason.trim().length > 0, `${label} ${key} must have a written reason`);
  }
}

describe('feed parity: client vs server (PR #3715 follow-up)', () => {
  const client = extractFeedRouting(CLIENT_PATH);
  const server = extractFeedRouting(SERVER_PATH);

  it('extracted feeds from both files', () => {
    assert.ok(client.size > 0, 'client feed extraction must not be empty');
    assert.ok(server.size > 0, 'server feed extraction must not be empty');
    assert.ok(client.has('CBC News'), 'client feed extraction must retain the critical CBC News member');
    assert.ok(server.has('CBC News'), 'server feed extraction must retain the critical CBC News member');
  });

  // Snapshot of feeds that ALREADY drift between client and server at PR #3715
  // merge time. Each one is its own per-feed judgment (some intentionally use
  // Google News on one side because the direct URL recently broke). The test
  // fails for NEW drift, not historic drift. This set should SHRINK over time
  // as feeds get reconciled — not grow.
  const KNOWN_DRIFTS = new Set([
    'The National',
    'CSIS',
    'South China Morning Post',
    'a16z Blog',
    'EU Startups',
    'Tech in Asia',
    'SemiAnalysis',
    'EIA Reports',
    'Northern Miner',
    // Mixed-locale routing: client uses direct rss() for en+de and a Google
    // News query for es; server uses pure direct for en. The classifier
    // treats any-locale-is-GoogleNews as Google News, so it flags this as a
    // drift even though both sides do agree on en. Worth reconciling
    // (probably: server should fall back to gn() for the same es query) but
    // out of scope for the #3717 review fix.
    'DW News',
  ]);

  it('every NEW shared feed name uses consistent routing (grandfathered drift snapshot)', () => {
    const newDrift = [];
    const resolvedKnown = [];
    for (const [name, c] of client) {
      const s = server.get(name);
      if (!s) continue;
      if (c.isGoogleNews === s.isGoogleNews) {
        if (KNOWN_DRIFTS.has(name)) resolvedKnown.push(name);
        continue;
      }
      if (KNOWN_DRIFTS.has(name)) continue; // grandfathered
      newDrift.push(
        `  - "${name}":\n` +
          `      client: ${c.isGoogleNews ? 'Google News' : 'direct'}  ${c.snippet.slice(0, 100)}\n` +
          `      server: ${s.isGoogleNews ? 'Google News' : 'direct'}  ${s.snippet.slice(0, 100)}`,
      );
    }
    assert.equal(
      newDrift.length,
      0,
      'NEW feed routing drift between client and server. Either update both sides ' +
        'or rename one entry so the parity check skips it:\n' +
        newDrift.join('\n'),
    );
    // If a previously-known drift is now consistent, the contributor should
    // remove it from KNOWN_DRIFTS — fail loudly so it gets cleaned up.
    assert.equal(
      resolvedKnown.length,
      0,
      `Drifts in KNOWN_DRIFTS are now consistent — remove from the set: ${resolvedKnown.join(', ')}`,
    );
  });

  it('REGRESSION (#3715): Blockworks does not appear on either side with a direct blockworks.co URL', () => {
    // The exact failure mode that prompted this test — server still pointed
    // at https://blockworks.co/feed after client moved to Google News, so the
    // digest path kept hitting Cloudflare-blocked upstream. Both sides have
    // since removed Blockworks (The Block covers the same territory). Lock
    // it in: a future contributor must not re-add the dead URL.
    for (const [path, label] of [[CLIENT_PATH, 'client'], [SERVER_PATH, 'server']]) {
      const src = readFileSync(path, 'utf-8');
      assert.ok(
        !/['"]https?:\/\/blockworks\.co\/feed['"]/.test(src),
        `${label} (${path}) still references the dead blockworks.co/feed URL`,
      );
    }
  });

  // Server-only feeds get aggregated, ranked, and TRUNCATED to
  // MAX_ITEMS_PER_CATEGORY in list-feed-digest.ts, THEN data-loader.ts filters
  // them by `enabledNames` from src/config/feeds.ts.
  // If the server emits a feed whose name has no client-side counterpart, the
  // server fetches it for nothing AND its items crowd out visible items in the
  // same category, shrinking the visible result set. Exactly the
  // Commodity-Trade-Mantra failure mode the #3717 reviewer caught.
  //
  it('every server feed has a client home in the same category before MAX_ITEMS_PER_CATEGORY truncation', () => {
    const clientByCategory = extractFeedNamesByCategory(CLIENT_PATH);
    const serverByCategory = extractFeedNamesByCategory(SERVER_PATH);
    const clientNameCount = [...clientByCategory.values()].reduce((sum, names) => sum + names.size, 0);
    const serverNameCount = [...serverByCategory.values()].reduce((sum, names) => sum + names.size, 0);
    assert.ok(clientNameCount > 0, 'client category parser must not be empty');
    assert.ok(serverNameCount > 0, 'server category parser must not be empty');
    const orphans = [];
    for (const [category, serverNames] of serverByCategory) {
      const clientNames = clientByCategory.get(category) ?? new Set();
      for (const name of serverNames) {
        if (!clientNames.has(name)) orphans.push(`${category}: ${name}`);
      }
    }
    assert.equal(
      orphans.length,
      0,
      'Server-only feed entries detected. The server will fetch these, ' +
        'rank them into MAX_ITEMS_PER_CATEGORY, then the client filter will ' +
        'drop them from that category — silently shrinking the visible result set. Either add a ' +
        'matching entry with the same name and category to src/config/feeds.ts, or remove ' +
        'the server entry:\n' +
        orphans.map(entry => `  - ${entry}`).join('\n'),
    );
  });

  it('REGRESSION (#3717): Commodity Trade Mantra is not on the server side', () => {
    // The #3717 reviewer caught this: I removed CTM from the client in #3715
    // but left it on the server, so the server fetched it, counted it toward
    // MAX_ITEMS_PER_CATEGORY, then the client filter dropped it — invisible
    // crowd-out. Lock it in.
    const src = readFileSync(SERVER_PATH, 'utf-8');
    assert.ok(
      !/name:\s*['"]Commodity Trade Mantra['"]/.test(src),
      `${SERVER_PATH} still has a 'Commodity Trade Mantra' entry — it has no client counterpart so its items get truncated-then-dropped`,
    );
  });

  // Existing full-catalog differences are deliberate or grandfathered with a
  // reason. New differences must either be aligned or get a new reviewed entry
  // here; silently adding another exception in product code is not allowed.
  const INTENTIONAL_URL_DIVERGENCES = new Map([
    ['politics:AP News', 'The server digest adds a one-day Google News window.'],
    ['politics:Reuters World', 'The server digest adds a one-day Google News window.'],
    ['us:Reuters US', 'The server digest adds a one-day Google News window.'],
    ['europe:ANSA', 'The server uses ANSA’s site-wide feed; the client uses its top-news feed.'],
    ['europe:DW News', 'Locale variants intentionally select language-specific DW feeds.'],
    ['europe:France 24', 'Locale variants intentionally select language-specific France 24 feeds.'],
    ['europe:EuroNews', 'Locale variants intentionally select language-specific EuroNews feeds.'],
    ['europe:Le Monde', 'Locale variants intentionally select language-specific Le Monde feeds.'],
    ['europe:Meduza', 'Locale variants intentionally select language-specific Meduza feeds.'],
    ['europe:Suspilne', 'Locale variants intentionally select language-specific Suspilne feeds.'],
    ['europe:Ukrinform', 'Locale variants intentionally select language-specific Ukrinform feeds.'],
    ['middleeast:Al Arabiya', 'Locale variants intentionally select language-specific Al Arabiya feeds.'],
    ['middleeast:Al Jazeera', 'Locale variants intentionally select language-specific Al Jazeera feeds.'],
    ['middleeast:Rudaw', 'The client requests the en edition explicitly; the server relies on the default edition.'],
    ['middleeast:The National', 'Grandfathered direct-versus-Google-News drift tracked by the routing test.'],
    ['finance:Reuters Business', 'The server digest adds a one-day Google News window.'],
    ['gov:State Dept', 'The server digest narrows the query and adds a one-day window.'],
    ['gov:Treasury', 'The server digest narrows the query and adds a one-day window.'],
    ['gov:DOJ', 'The server digest narrows the query and adds a one-day window.'],
    ['layoffs:Layoffs.fyi', 'The server adds broader terms and a three-day window.'],
    ['thinktanks:CSIS', 'Grandfathered direct-versus-Google-News drift tracked by the routing test.'],
    ['thinktanks:War on the Rocks', 'The two sides differ only by a documented trailing slash.'],
    ['africa:Africanews', 'Locale variants intentionally select language-specific Africanews feeds.'],
    ['asia:Asia News', 'The client uses a broad Asia query; the server targets AsiaNews.it.'],
    ['asia:South China Morning Post', 'Grandfathered direct-versus-Google-News drift tracked by the routing test.'],
    ['asia:The Hindu', 'The client uses the national feed; the server uses the site-wide feed.'],
    ['asia:RFE/RL Central Asia', 'The client spells the phrase; the server URL-encodes a plus in the same phrase.'],
    ['energy:Nuclear Energy', 'The server uses a narrower reactor-focused query.'],
    ['energy:Reuters Energy', 'The server uses a narrower, more recent energy query.'],
  ]);

  it('REGRESSION (#6427): full-feed extraction rejects unsupported catalog shapes', () => {
    const unsupportedCatalogs = [
      'const FULL_FEEDS = { ...baseCategories };',
      'const FULL_FEEDS = { us: sharedFeeds };',
      "const FULL_FEEDS = { us: [{ name: 'Inline', url: rss('https://example.com/feed') }, ...sharedFeeds] };",
    ];

    for (const [index, source] of unsupportedCatalogs.entries()) {
      const filePath = `unsupported-full-feeds-${index}.ts`;
      const initializer = findVariableInitializerInSource(source, filePath, 'FULL_FEEDS');
      assert.ok(ts.isObjectLiteralExpression(initializer));
      assert.throws(
        () => extractFeedRecord(initializer, filePath),
        /unsupported category entry|must use an inline array literal|unsupported feed entry/,
      );
    }
  });

  it('REGRESSION (#6427): parity exceptions require written reasons', () => {
    assertReasonedExceptions(INTENTIONAL_URL_DIVERGENCES, 'URL-divergence exception');
    assert.throws(
      () => assertReasonedExceptions(new Map([['us:Example', '   ']]), 'test exception'),
      /must have a written reason/,
    );
  });

  it('REGRESSION (#6427): shared full-variant feeds resolve to the same upstream', () => {
    assertReasonedExceptions(INTENTIONAL_URL_DIVERGENCES, 'URL-divergence exception');
    const clientFullFeeds = extractFullFeedsByCategory(CLIENT_PATH, 'client');
    const serverFullFeeds = extractFullFeedsByCategory(SERVER_PATH, 'server');
    assert.ok(clientFullFeeds.size > 0);
    assert.ok(serverFullFeeds.size > 0);

    const differences = [];
    const resolvedExceptions = [];
    for (const [key, clientUrls] of clientFullFeeds) {
      const serverUrls = serverFullFeeds.get(key);
      if (!serverUrls) continue;
      const isSame =
        clientUrls.size === serverUrls.size && [...clientUrls].every(url => serverUrls.has(url));
      if (isSame) {
        if (INTENTIONAL_URL_DIVERGENCES.has(key)) resolvedExceptions.push(key);
        continue;
      }
      if (INTENTIONAL_URL_DIVERGENCES.has(key)) continue;
      differences.push(
        `  - ${key}\n      client: ${[...clientUrls].join(', ')}\n      server: ${[...serverUrls].join(', ')}`,
      );
    }
    assert.equal(
      differences.length,
      0,
      'Shared feed names point at different upstreams. Align both sides, or add a reviewed reason to INTENTIONAL_URL_DIVERGENCES:\n' +
        differences.join('\n'),
    );
    assert.equal(
      resolvedExceptions.length,
      0,
      `URL-divergence exceptions are now aligned — remove them: ${resolvedExceptions.join(', ')}`,
    );
    const staleExceptions = [...INTENTIONAL_URL_DIVERGENCES.keys()].filter(
      key => !clientFullFeeds.has(key) || !serverFullFeeds.has(key),
    );
    assert.equal(
      staleExceptions.length,
      0,
      `URL-divergence exceptions no longer describe a shared feed — remove them: ${staleExceptions.join(', ')}`,
    );
  });

  it('REGRESSION (#6427): new client-only full-variant feeds require a reviewed server decision', () => {
    const clientFullFeeds = extractFullFeedsByCategory(CLIENT_PATH, 'client');
    const serverFullFeeds = extractFullFeedsByCategory(SERVER_PATH, 'server');
    const INTENTIONAL_CLIENT_ONLY = new Map([
      ['europe:El País', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:El Mundo', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:BBC Mundo', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:Bild', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:Der Spiegel', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:Die Zeit', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:Corriere della Sera', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:Repubblica', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:NRC', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:De Telegraaf', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:Dagens Nyheter', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:Svenska Dagbladet', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:BBC Turkce', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:DW Turkish', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:BBC Russian', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:Novaya Gazeta Europe', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:TASS', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:RT', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['europe:RT Russia', 'Locale-specific client catalog entry; the full digest serves its English feed set.'],
      ['middleeast:Fars News', 'Intentionally client-only regional source.'],
      ['middleeast:IRNA', 'Intentionally client-only regional source.'],
      ['middleeast:Mehr News', 'Intentionally client-only regional source.'],
      ['middleeast:Asharq News', 'Intentionally client-only regional source.'],
      ['gov:CDC', 'Intentionally client-only catalog source.'],
      ['gov:FEMA', 'Intentionally client-only catalog source.'],
      ['gov:DHS', 'Intentionally client-only catalog source.'],
      ['thinktanks:RAND', 'Intentionally client-only catalog source.'],
      ['thinktanks:Brookings', 'Intentionally client-only catalog source.'],
      ['thinktanks:Carnegie', 'Intentionally client-only catalog source.'],
      ['thinktanks:Responsible Statecraft', 'Intentionally client-only catalog source.'],
      ['thinktanks:RUSI', 'Intentionally client-only catalog source.'],
      ['thinktanks:FPRI', 'Intentionally client-only catalog source.'],
      ['thinktanks:Jamestown', 'Intentionally client-only catalog source.'],
      ['crisis:UNHCR', 'Intentionally client-only catalog source.'],
      ['africa:BBC Afrique', 'Intentionally client-only catalog source.'],
      ['latam:Latin America', 'Intentionally client-only catalog source.'],
      ['latam:Reuters LatAm', 'Intentionally client-only catalog source.'],
      ['latam:O Globo', 'Intentionally client-only catalog source.'],
      ['latam:Folha de S.Paulo', 'Intentionally client-only catalog source.'],
      ['latam:Brasil Paralelo', 'Intentionally client-only catalog source.'],
      ['latam:El Tiempo', 'Intentionally client-only catalog source.'],
      ['latam:La Silla Vacía', 'Intentionally client-only catalog source.'],
      ['latam:Mexico News Daily', 'Intentionally client-only catalog source.'],
      ['latam:Mexico Security', 'Intentionally client-only catalog source.'],
      ['latam:AP Mexico', 'Intentionally client-only catalog source.'],
      ['latam:France 24 LatAm', 'Intentionally client-only catalog source.'],
      ['asia:Indian Express', 'Intentionally client-only catalog source.'],
      ['asia:India News Network', 'Intentionally client-only catalog source.'],
      ['asia:Thai PBS', 'Intentionally client-only catalog source.'],
      ['asia:Tuoi Tre News', 'Intentionally client-only catalog source.'],
      ['asia:Chosun Ilbo', 'Intentionally client-only catalog source.'],
      ['asia:ABC News Australia', 'Intentionally client-only catalog source.'],
      ['asia:Guardian Australia', 'Intentionally client-only catalog source.'],
      ['energy:Mining & Resources', 'Intentionally client-only catalog source.'],
    ]);
    assertReasonedExceptions(INTENTIONAL_CLIENT_ONLY, 'client-only exception');
    const unreviewed = [];
    for (const key of clientFullFeeds.keys()) {
      if (serverFullFeeds.has(key) || INTENTIONAL_CLIENT_ONLY.has(key)) continue;
      unreviewed.push(key);
    }
    const staleClientOnly = [...INTENTIONAL_CLIENT_ONLY.keys()].filter(
      key => !clientFullFeeds.has(key) || serverFullFeeds.has(key),
    );
    assert.equal(
      unreviewed.length,
      0,
      'Client-only full-variant feeds are invisible to the server digest. Add the feed to both sides, or record a reviewed client-only decision:\n' +
        unreviewed.map(key => `  - ${key}: ${INTENTIONAL_CLIENT_ONLY.get(key) ?? ''}`).join('\n'),
    );
    assert.equal(
      staleClientOnly.length,
      0,
      `Client-only exceptions are no longer client-only — remove them: ${staleClientOnly.join(', ')}`,
    );
  });
});
