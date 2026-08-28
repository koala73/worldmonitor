/**
 * Logical publisher identity for the public source catalog.
 *
 * Host ledger rows stay host-centric. Syndication transports such as
 * FeedBurner and Google News remain visible there, but they are not catalog
 * providers. Named feed declarations supply the publisher identity, origin,
 * and coverage geography that the catalog UI shows.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  publisherFamilyFor,
  publisherNameForFamily,
} from '../shared/publisher-families.js';
import { assertKnownOriginCode, resolveSourceOrigin } from './source-origin.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SYNDICATION_TRANSPORT_HOSTS = Object.freeze(new Set([
  'feeds.feedburner.com',
  'feedburner.com',
  'news.google.com',
]));

export const FEED_DECLARATION_FILES = Object.freeze([
  'src/config/feeds.ts',
  'server/worldmonitor/news/v1/_feeds.ts',
]);

const FEEDBURNER_TRANSPORT_HOSTS = Object.freeze(new Set([
  'feeds.feedburner.com',
  'feedburner.com',
]));

function googleNewsUrl(query, hl = 'en-US', gl = 'US', ceid = 'US:en') {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

export function isSyndicationTransportHost(host) {
  return SYNDICATION_TRANSPORT_HOSTS.has(String(host || '').toLowerCase());
}

export function hasFeedBurnerTransport(declaration) {
  return (declaration?.transportHosts || []).some((host) => FEEDBURNER_TRANSPORT_HOSTS.has(host));
}

export function isSyndicationTransportEntry(entry) {
  return entry?.role === 'transport' || isSyndicationTransportHost(entry?.host);
}

export function uniqueSorted(values) {
  const list = values instanceof Set ? [...values] : [...(values || [])];
  return [...new Set(list.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function catalogHostKey(host) {
  return String(host || '').replace(/^www\./i, '').toLowerCase();
}

export function hostFromFeedUrl(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    const match = String(raw || '').match(/^https?:\/\/([^/?#]+)/i);
    return match ? match[1].replace(/^www\./, '').toLowerCase() : '';
  }
}

export function googleNewsSiteHosts(query) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(query || '').replaceAll('+', ' '));
  } catch {
    decoded = String(query || '').replaceAll('+', ' ');
  }
  const hosts = [];
  for (const match of decoded.matchAll(/\bsite:([a-z0-9.-]+)/gi)) {
    const host = hostFromFeedUrl(`https://${match[1]}`);
    if (host) hosts.push(host);
  }
  return [...new Set(hosts)];
}

export function logicalPublisherName(label) {
  const family = publisherFamilyFor(label);
  if (!family) return '';
  if (family.startsWith('label:')) return String(label).trim();
  return publisherNameForFamily(family);
}

function pushUrl(urls, raw) {
  if (!raw || urls.includes(raw)) return;
  urls.push(raw);
}

function sourceParseError(fileName, message) {
  return new Error(`Cannot parse feed declarations in ${fileName}: ${message}`);
}

function readQuotedString(source, start, fileName) {
  const quote = source[start];
  let index = start + 1;
  let value = '';
  const escapes = {
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    0: '\0',
  };

  while (index < source.length) {
    const char = source[index++];
    if (char === quote) return { next: index, value };
    if (char === '\n' || char === '\r') {
      throw sourceParseError(fileName, 'unterminated string literal');
    }
    if (char !== '\\') {
      value += char;
      continue;
    }

    if (index >= source.length) throw sourceParseError(fileName, 'unterminated string escape');
    const escaped = source[index++];
    if (escaped === '\n') continue;
    if (escaped === '\r') {
      if (source[index] === '\n') index += 1;
      continue;
    }
    if (escaped === 'x') {
      const hex = source.slice(index, index + 2);
      if (!/^[0-9a-f]{2}$/i.test(hex)) throw sourceParseError(fileName, 'invalid hexadecimal string escape');
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (escaped === 'u') {
      const braced = source[index] === '{';
      const close = braced ? source.indexOf('}', index + 1) : index + 4;
      const hex = braced ? source.slice(index + 1, close) : source.slice(index, close);
      if (close < 0 || !/^[0-9a-f]{1,6}$/i.test(hex)) {
        throw sourceParseError(fileName, 'invalid Unicode string escape');
      }
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff) throw sourceParseError(fileName, 'Unicode string escape is out of range');
      value += String.fromCodePoint(codePoint);
      index = braced ? close + 1 : close;
      continue;
    }
    value += escapes[escaped] ?? escaped;
  }

  throw sourceParseError(fileName, 'unterminated string literal');
}

function skipTemplateLiteral(source, start, fileName) {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index++];
    if (char === '`') return index;
    if (char === '\\') index += 1;
  }
  throw sourceParseError(fileName, 'unterminated template literal');
}

function tokenizeFeedSource(source, fileName) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      if (close < 0) throw sourceParseError(fileName, 'unterminated block comment');
      index = close + 2;
      continue;
    }
    if (char === '\'' || char === '"') {
      const literal = readQuotedString(source, index, fileName);
      tokens.push({ type: 'string', value: literal.value });
      index = literal.next;
      continue;
    }
    if (char === '`') {
      index = skipTemplateLiteral(source, index, fileName);
      tokens.push({ type: 'template', value: '' });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      tokens.push({ type: 'identifier', value: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ type: 'punctuation', value: char });
    index += 1;
  }
  return tokens;
}

function delimiterPairs(tokens, fileName) {
  const pairs = new Map();
  const stack = [];
  const closes = { ')': '(', ']': '[', '}': '{' };
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === '(' || value === '[' || value === '{') {
      stack.push({ index, value });
    } else if (value in closes) {
      const open = stack.pop();
      if (!open || open.value !== closes[value]) {
        throw sourceParseError(fileName, `unmatched ${value}`);
      }
      pairs.set(open.index, index);
    }
  }
  if (stack.length > 0) throw sourceParseError(fileName, `unmatched ${stack.at(-1).value}`);
  return pairs;
}

function propertyValueRange(tokens, objectStart, objectEnd, name) {
  const stack = [];
  let propertyStart = true;
  for (let index = objectStart + 1; index < objectEnd; index += 1) {
    const token = tokens[index];
    const value = token.value;
    if (value === '(' || value === '[' || value === '{') {
      stack.push(value);
      propertyStart = false;
      continue;
    }
    if (value === ')' || value === ']' || value === '}') {
      stack.pop();
      continue;
    }
    if (stack.length > 0) continue;
    if (value === ',') {
      propertyStart = true;
      continue;
    }
    if (!propertyStart) continue;
    propertyStart = false;
    if ((token.type === 'identifier' || token.type === 'string') && value === name && tokens[index + 1]?.value === ':') {
      const start = index + 2;
      const nested = [];
      let end = start;
      for (; end < objectEnd; end += 1) {
        const current = tokens[end].value;
        if (current === '(' || current === '[' || current === '{') nested.push(current);
        else if (current === ')' || current === ']' || current === '}') nested.pop();
        else if (current === ',' && nested.length === 0) break;
      }
      return { end, start };
    }
  }
  return null;
}

function stringLiteralInRange(tokens, start, end, pairs) {
  while (tokens[start]?.value === '(' && pairs.get(start) === end - 1) {
    start += 1;
    end -= 1;
  }
  return tokens[start]?.type === 'string' ? tokens[start].value : null;
}

function callArguments(tokens, open, close) {
  const ranges = [];
  const stack = [];
  let start = open + 1;
  for (let index = start; index < close; index += 1) {
    const value = tokens[index].value;
    if (value === '(' || value === '[' || value === '{') stack.push(value);
    else if (value === ')' || value === ']' || value === '}') stack.pop();
    else if (value === ',' && stack.length === 0) {
      ranges.push({ end: index, start });
      start = index + 1;
    }
  }
  if (start < close) ranges.push({ end: close, start });
  return ranges;
}

function collectFeedUrls(tokens, start, end, pairs, urls) {
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (token.type === 'string' && /^https?:\/\//i.test(token.value)) pushUrl(urls, token.value);
    if (token.type !== 'identifier' || !['rss', 'railwayRss', 'gn', 'gnLocale'].includes(token.value)) continue;
    const open = index + 1;
    const close = pairs.get(open);
    if (tokens[open]?.value !== '(' || close === undefined || close >= end) continue;
    const args = callArguments(tokens, open, close)
      .map((range) => stringLiteralInRange(tokens, range.start, range.end, pairs));
    if (token.value === 'rss' || token.value === 'railwayRss') pushUrl(urls, args[0]);
    else if (token.value === 'gn' && args[0] !== null) pushUrl(urls, googleNewsUrl(args[0]));
    else if (token.value === 'gnLocale' && args.slice(0, 4).every((value) => value !== null)) {
      pushUrl(urls, googleNewsUrl(args[0], args[1], args[2], args[3]));
    }
    index = close;
  }
}

function parseFeedDeclarationSource(source, fileName) {
  const tokens = tokenizeFeedSource(source, fileName);
  const pairs = delimiterPairs(tokens, fileName);
  const declarations = [];
  for (let objectStart = 0; objectStart < tokens.length; objectStart += 1) {
    if (tokens[objectStart].value !== '{') continue;
    const objectEnd = pairs.get(objectStart);
    const nameRange = propertyValueRange(tokens, objectStart, objectEnd, 'name');
    const urlRange = propertyValueRange(tokens, objectStart, objectEnd, 'url');
    if (!nameRange || !urlRange) continue;
    const name = stringLiteralInRange(tokens, nameRange.start, nameRange.end, pairs);
    if (!name) continue;
    const urls = [];
    collectFeedUrls(tokens, urlRange.start, urlRange.end, pairs, urls);
    for (const url of urls) declarations.push(classifyFeedDeclaration(name, url));
  }
  return declarations;
}

export function classifyFeedDeclaration(name, url) {
  let parsed = null;
  let host = '';
  try {
    parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    host = hostFromFeedUrl(url);
  }
  const query = host === 'news.google.com'
    ? (parsed?.searchParams.get('q') || '')
    : '';
  const siteHosts = host === 'news.google.com' ? googleNewsSiteHosts(query) : [];
  const transportHosts = isSyndicationTransportHost(host) ? [host] : [];
  const editorialHosts = [
    ...(!host || isSyndicationTransportHost(host) ? [] : [host]),
    ...siteHosts.filter((candidate) => !isSyndicationTransportHost(candidate)),
  ];
  return {
    name,
    url,
    host,
    publisher: logicalPublisherName(name),
    transportHosts: [...new Set(transportHosts)],
    editorialHosts: [...new Set(editorialHosts)],
  };
}

export function scanNamedFeedDeclarations(rootDir = ROOT) {
  const declarations = [];
  const seen = new Set();
  for (const relativePath of FEED_DECLARATION_FILES) {
    const path = join(rootDir, relativePath);
    let source;
    try {
      source = readFileSync(path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const declaration of parseFeedDeclarationSource(source, relativePath)) {
      const key = `${declaration.name}\0${declaration.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      declarations.push(declaration);
    }
  }
  return declarations;
}

export function loadSourceGeography(rootDir = ROOT) {
  const path = join(rootDir, 'shared/source-geography.json');
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
  const doc = JSON.parse(source);
  return new Map(
    Object.entries(doc)
      .filter(([key]) => !key.startsWith('_'))
      .map(([name, countries]) => [name, Array.isArray(countries) ? [...countries] : []]),
  );
}

export function coverageCountriesForLabels(labels, geography) {
  const countries = new Set();
  for (const label of labels) {
    for (const code of geography.get(label) || []) {
      if (code) countries.add(code);
    }
  }
  return uniqueSorted(countries);
}

export function validateFeedBurnerPublisherIdentity(declarations) {
  const errors = [];
  for (const declaration of declarations) {
    if (!hasFeedBurnerTransport(declaration)) continue;
    if (!declaration.name || !declaration.publisher) {
      errors.push(
        `FeedBurner URL ${declaration.url} requires an explicit publisher identity`,
      );
    }
  }
  return errors;
}

/**
 * Publishers that exist only through a syndication transport, so the host
 * ledger cannot name them from an editorial hostname.
 */
export function buildLogicalProviders(declarations, geography = new Map()) {
  const byPublisher = new Map();
  for (const declaration of declarations) {
    if (declaration.editorialHosts.length > 0) continue;
    if (!hasFeedBurnerTransport(declaration)) continue;
    const publisher = declaration.publisher || declaration.name;
    const current = byPublisher.get(publisher) || {
      provider: publisher,
      feedLabels: [],
      transportHosts: [],
      editorialHosts: [],
    };
    current.feedLabels.push(declaration.name);
    current.transportHosts.push(...declaration.transportHosts);
    current.editorialHosts.push(...declaration.editorialHosts);
    byPublisher.set(publisher, current);
  }

  return [...byPublisher.values()]
    .map((entry) => {
      const feedLabels = uniqueSorted(entry.feedLabels);
      const originCountry = resolveSourceOrigin({
        provider: entry.provider,
        hosts: uniqueSorted(entry.editorialHosts),
      });
      assertKnownOriginCode(originCountry, `logical provider ${entry.provider}`);
      return {
        provider: entry.provider,
        feedLabels,
        transportHosts: uniqueSorted(entry.transportHosts),
        editorialHosts: uniqueSorted(entry.editorialHosts),
        originCountry,
        coveredCountries: coverageCountriesForLabels(feedLabels, geography),
      };
    })
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

export function isCatalogProviderEntry(entry) {
  if (!entry || entry.observed !== true) return false;
  if (entry.catalogActive === false) return false;
  if (entry.status !== 'reviewed' && entry.status !== 'terms-review') return false;
  return !isSyndicationTransportEntry(entry);
}

export function catalogProviderIdentities(manifest) {
  const providers = new Set();
  for (const entry of manifest?.entries || []) {
    if (!isCatalogProviderEntry(entry)) continue;
    providers.add(entry.provider);
  }
  for (const entry of manifest?.logicalProviders || []) {
    if (entry?.provider) providers.add(entry.provider);
  }
  return providers;
}

export function attachCoverageToCatalog(catalog, declarations, geography) {
  const coverageByHost = new Map();
  const coverageByPublisher = new Map();
  const transportsByHost = new Map();
  const transportsByPublisher = new Map();

  const addAll = (map, key, values) => {
    if (!key) return;
    const current = map.get(key) || new Set();
    for (const value of values) if (value) current.add(value);
    map.set(key, current);
  };

  for (const declaration of declarations) {
    const coverage = geography.get(declaration.name) || [];
    addAll(coverageByPublisher, declaration.publisher, coverage);
    addAll(transportsByPublisher, declaration.publisher, declaration.transportHosts);
    for (const host of declaration.editorialHosts) {
      const hostKey = catalogHostKey(host);
      addAll(coverageByHost, hostKey, coverage);
      addAll(transportsByHost, hostKey, declaration.transportHosts);
    }
  }

  return catalog.map((provider) => {
    const covered = new Set(provider.coveredCountries || []);
    const transports = new Set(provider.transportHosts || []);
    for (const value of coverageByPublisher.get(provider.provider) || []) covered.add(value);
    for (const value of coverageByPublisher.get(provider.displayName) || []) covered.add(value);
    for (const value of transportsByPublisher.get(provider.provider) || []) transports.add(value);
    for (const value of transportsByPublisher.get(provider.displayName) || []) transports.add(value);
    for (const host of provider.hosts || []) {
      const hostKey = catalogHostKey(host);
      for (const value of coverageByHost.get(hostKey) || []) covered.add(value);
      for (const value of transportsByHost.get(hostKey) || []) transports.add(value);
    }
    return {
      ...provider,
      coveredCountries: uniqueSorted(covered),
      transportHosts: uniqueSorted(transports),
    };
  });
}
