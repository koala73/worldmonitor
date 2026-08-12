/**
 * Feed parity test — client vs server digest configuration.
 *
 * The browser wraps upstream RSS URLs in `rss()` / `railwayRss()` while the
 * digest expands Google News queries through `gn()` / `gnLocale()`. Compare
 * the upstream URL after statically unwrapping those helpers: comparing the
 * browser proxy URL would conceal the feed that each side actually fetches.
 *
 * The client catalog is deliberately broader than the digest. The contract is
 * therefore limited to the categories whose sources are deliberately mirrored
 * by the digest; opt-in, client-direct catalog entries remain out of scope.
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
const MIRRORED_CATEGORIES = new Set(['full/us', 'full/gov']);

/**
 * Intentionally different upstreams. Keep this list small: every exception
 * must name the exact coordinate, why it differs, and the normalized URLs on
 * both sides. The assertion below also fails if either URL changes or the
 * exception becomes unnecessary.
 */
const PARITY_EXCEPTIONS = new Map([
  ['full/us/Reuters US', {
    reason: 'The digest applies its one-day Google News freshness window; the client catalog keeps the publisher-wide query.',
    clientUrl: 'https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=site%3Areuters.com+US',
    serverUrl: 'https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=site%3Areuters.com+US+when%3A1d',
  }],
  ['full/gov/State Dept', {
    reason: 'The digest uses a one-day freshness window while the client keeps the broader agency search.',
    clientUrl: 'https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=site%3Astate.gov+OR+%22State+Department%22',
    serverUrl: 'https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=%28site%3Astate.gov+OR+%22State+Department%22%29+when%3A1d',
  }],
  ['full/gov/Treasury', {
    reason: 'The digest uses a one-day freshness window and a narrower Treasury query than the client catalog.',
    clientUrl: 'https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=site%3Atreasury.gov+OR+%22Treasury+Department%22',
    serverUrl: 'https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=site%3Atreasury.gov+when%3A1d',
  }],
  ['full/gov/DOJ', {
    reason: 'The digest uses a one-day freshness window and a narrower Justice Department query than the client catalog.',
    clientUrl: 'https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=site%3Ajustice.gov+OR+%22Justice+Department%22+DOJ',
    serverUrl: 'https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=site%3Ajustice.gov+when%3A1d',
  }],
]);

// These three public-safety sources are intentionally fetched only through
// the browser's direct RSS path. Keep each URL here so adding another
// client-only source to a mirrored category fails rather than silently
// broadening this exception.
const CLIENT_DIRECT_EXCEPTIONS = new Map([
  ['full/gov/CDC', {
    reason: 'CDC remains a client-direct source; no digest counterpart is configured.',
    clientUrl: 'https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=site%3Acdc.gov+OR+CDC+health',
  }],
  ['full/gov/FEMA', {
    reason: 'FEMA remains a client-direct source; no digest counterpart is configured.',
    clientUrl: 'https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=site%3Afema.gov+OR+FEMA+emergency',
  }],
  ['full/gov/DHS', {
    reason: 'DHS remains a client-direct source; no digest counterpart is configured.',
    clientUrl: 'https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=site%3Adhs.gov+OR+%22Homeland+Security%22',
  }],
]);

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null;
}

function stringValue(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function findVariable(ast, name) {
  let found;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function getProperty(object, name) {
  return object.properties.find(
    property => ts.isPropertyAssignment(property) && propertyName(property.name) === name,
  );
}

function normalizeUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }
  url.hash = '';

  // URLSearchParams decodes equivalent `+` / `%20` spellings, then emits one
  // stable encoding. Sorting makes query parameter ordering non-semantic,
  // while retaining every value (notably Google News's `q` expression).
  const params = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
    aKey.localeCompare(bKey) || aValue.localeCompare(bValue),
  );
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

function googleNewsUrl(query, hl = 'en-US', gl = 'US', ceid = 'US:en') {
  return normalizeUrl(`https://news.google.com/rss/search?${new URLSearchParams({ q: query, hl, gl, ceid })}`);
}

function upstreamUrl(expression, side) {
  const direct = stringValue(expression);
  if (direct) return normalizeUrl(direct);

  if (ts.isObjectLiteralExpression(expression)) {
    // A digest has one upstream per feed. Client locale maps use `en` as the
    // baseline URL, which is the server's non-locale-specific counterpart.
    const en = getProperty(expression, 'en');
    if (!en || !ts.isPropertyAssignment(en)) {
      throw new Error('locale-keyed URL has no en baseline');
    }
    return upstreamUrl(en.initializer, side);
  }

  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
    throw new Error(`unsupported URL expression: ${expression.getText().slice(0, 120)}`);
  }

  const helper = expression.expression.text;
  if (side === 'client' && (helper === 'rss' || helper === 'railwayRss')) {
    const url = stringValue(expression.arguments[0]);
    if (!url) throw new Error(`${helper}() requires a string-literal upstream URL`);
    return normalizeUrl(url);
  }
  if (side === 'server' && (helper === 'gn' || helper === 'gnLocale')) {
    const args = expression.arguments.map(stringValue);
    if (args.some(arg => arg === null)) throw new Error(`${helper}() requires string-literal arguments`);
    return helper === 'gn'
      ? googleNewsUrl(args[0])
      : googleNewsUrl(args[0], args[1], args[2], args[3]);
  }
  throw new Error(`unsupported ${side} URL helper: ${helper}()`);
}

function addFeed(records, errors, variant, category, element, side) {
  if (!ts.isObjectLiteralExpression(element)) return;
  const name = getProperty(element, 'name');
  const url = getProperty(element, 'url');
  const feedName = name && ts.isPropertyAssignment(name) ? stringValue(name.initializer) : null;
  if (!feedName || !url || !ts.isPropertyAssignment(url)) {
    errors.push(`${variant}/${category}: feed entry is missing a string name or URL`);
    return;
  }
  const key = `${variant}/${category}/${feedName}`;
  if (records.has(key)) {
    errors.push(`${key}: duplicate ${side} feed coordinate`);
    return;
  }
  try {
    records.set(key, { url: upstreamUrl(url.initializer, side), source: url.initializer.getText() });
  } catch (error) {
    errors.push(`${key}: ${error.message}`);
  }
}

function addFeedArray(records, errors, variant, category, array, side) {
  if (!ts.isArrayLiteralExpression(array)) {
    errors.push(`${variant}/${category}: expected a feed array`);
    return;
  }
  for (const element of array.elements) addFeed(records, errors, variant, category, element, side);
}

function extractCatalog(filePath, side) {
  const src = readFileSync(filePath, 'utf-8');
  const ast = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const records = new Map();
  const errors = [];
  const mapName = side === 'client' ? 'FULL_FEEDS' : 'VARIANT_FEEDS';
  const root = findVariable(ast, mapName);
  if (!root || !ts.isObjectLiteralExpression(root)) {
    return { records, errors: [`could not find object literal ${mapName}`] };
  }

  if (side === 'client') {
    const clientMaps = new Map([['full', 'FULL_FEEDS']]);
    for (const [variant, variableName] of clientMaps) {
      const feedMap = findVariable(ast, variableName);
      if (!feedMap || !ts.isObjectLiteralExpression(feedMap)) {
        errors.push(`could not find object literal ${variableName}`);
        continue;
      }
      for (const property of feedMap.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const category = propertyName(property.name);
        if (category && MIRRORED_CATEGORIES.has(`${variant}/${category}`)) {
          addFeedArray(records, errors, variant, category, property.initializer, side);
        }
      }
    }
  } else {
    for (const variantProperty of root.properties) {
      if (!ts.isPropertyAssignment(variantProperty)) continue;
      const variant = propertyName(variantProperty.name);
      if (!variant || !ts.isObjectLiteralExpression(variantProperty.initializer)) continue;
      for (const categoryProperty of variantProperty.initializer.properties) {
        if (!ts.isPropertyAssignment(categoryProperty)) continue;
        const category = propertyName(categoryProperty.name);
        if (category && MIRRORED_CATEGORIES.has(`${variant}/${category}`)) {
          addFeedArray(records, errors, variant, category, categoryProperty.initializer, side);
        }
      }
    }
  }

  return { records, errors };
}

function exceptionFor(key, client, server) {
  const exception = PARITY_EXCEPTIONS.get(key);
  if (!exception) return null;
  assert.ok(exception.reason, `${key}: parity exception needs a reason`);
  assert.equal(client?.url, exception.clientUrl, `${key}: exception client URL no longer matches config`);
  assert.equal(server?.url, exception.serverUrl, `${key}: exception server URL no longer matches config`);
  return exception;
}

function clientDirectExceptionFor(key, client) {
  const exception = CLIENT_DIRECT_EXCEPTIONS.get(key);
  if (!exception) return null;
  assert.ok(exception.reason, `${key}: client-direct exception needs a reason`);
  assert.equal(client?.url, exception.clientUrl, `${key}: client-direct exception URL no longer matches config`);
  return exception;
}

describe('feed parity: client vs server digest', () => {
  const client = extractCatalog(CLIENT_PATH, 'client');
  const server = extractCatalog(SERVER_PATH, 'server');

  it('statically extracts every supported digest feed URL', () => {
    assert.deepEqual(client.errors, [], `client feed extraction errors:\n${client.errors.join('\n')}`);
    assert.deepEqual(server.errors, [], `server feed extraction errors:\n${server.errors.join('\n')}`);
    assert.ok(client.records.size, 'client feed extraction must not be empty');
    assert.ok(server.records.size, 'server feed extraction must not be empty');
  });

  it('has no unannotated missing or divergent feed coordinates', () => {
    const failures = [];
    const usedExceptions = new Set();
    const usedClientDirectExceptions = new Set();
    for (const key of new Set([...client.records.keys(), ...server.records.keys()])) {
      const clientFeed = client.records.get(key);
      const serverFeed = server.records.get(key);
      if (clientFeed && !serverFeed) {
        const exception = clientDirectExceptionFor(key, clientFeed);
        if (exception) {
          usedClientDirectExceptions.add(key);
          continue;
        }
      }
      const exception = exceptionFor(key, clientFeed, serverFeed);
      if (exception) {
        usedExceptions.add(key);
        continue;
      }
      if (!clientFeed) failures.push(`server-only ${key}\n    server: ${serverFeed.url}`);
      else if (!serverFeed) failures.push(`client-only ${key}\n    client: ${clientFeed.url}`);
      else if (clientFeed.url !== serverFeed.url) {
        failures.push(`URL drift ${key}\n    client: ${clientFeed.url}\n    server: ${serverFeed.url}`);
      }
    }
    assert.deepEqual(
      [...PARITY_EXCEPTIONS.keys()].filter(key => !usedExceptions.has(key)),
      [],
      'parity exceptions no longer match a feed coordinate; remove the stale entry',
    );
    assert.deepEqual(
      [...CLIENT_DIRECT_EXCEPTIONS.keys()].filter(key => !usedClientDirectExceptions.has(key)),
      [],
      'client-direct exceptions no longer match a client-only feed; remove the stale entry',
    );
    assert.equal(
      failures.length,
      0,
      'Feed parity failures. Align the upstreams, add the missing counterpart, or add a URL-verified exception:\n' +
        failures.sort().map(failure => `  - ${failure}`).join('\n'),
    );
  });

  it('regression (#6427): Fox News and official government feeds are aligned', () => {
    const expected = new Map([
      ['full/us/Fox News', 'https://moxie.foxnews.com/google-publisher/us.xml'],
      ['full/gov/White House', 'https://www.whitehouse.gov/briefings-statements/feed/'],
      ['full/gov/Pentagon', 'https://www.war.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945'],
    ]);
    for (const [key, rawUrl] of expected) {
      const expectedUrl = normalizeUrl(rawUrl);
      assert.equal(client.records.get(key)?.url, expectedUrl, `${key}: client URL`);
      assert.equal(server.records.get(key)?.url, expectedUrl, `${key}: server URL`);
    }
    assert.doesNotMatch(
      readFileSync(CLIENT_PATH, 'utf-8'),
      /site:defense\.gov\+OR\+Pentagon/,
      'client must not retain the pre-war.gov Pentagon Google News query',
    );
  });

  it('REGRESSION (#3715): Blockworks does not appear on either side with a direct blockworks.co URL', () => {
    for (const [path, label] of [[CLIENT_PATH, 'client'], [SERVER_PATH, 'server']]) {
      assert.doesNotMatch(
        readFileSync(path, 'utf-8'),
        /['"]https?:\/\/blockworks\.co\/feed['"]/,
        `${label} (${path}) still references the dead blockworks.co/feed URL`,
      );
    }
  });

  it('REGRESSION (#3717): Commodity Trade Mantra is not on the server side', () => {
    assert.doesNotMatch(
      readFileSync(SERVER_PATH, 'utf-8'),
      /name:\s*['"]Commodity Trade Mantra['"]/,
      `${SERVER_PATH} still has a 'Commodity Trade Mantra' entry`,
    );
  });
});
