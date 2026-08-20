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

import ts from 'typescript';

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

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return '';
}

function propertyAssignment(object, name) {
  return object.properties.find((property) => (
    ts.isPropertyAssignment(property)
    && propertyNameText(property.name) === name
  ));
}

function stringLiteralText(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isStringLiteralLike(current) ? current.text : null;
}

function collectFeedUrls(node, urls) {
  if (ts.isStringLiteralLike(node)) {
    if (/^https?:\/\//i.test(node.text)) pushUrl(urls, node.text);
    return;
  }

  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const helper = node.expression.text;
    const args = node.arguments.map(stringLiteralText);
    if (helper === 'rss' || helper === 'railwayRss') {
      pushUrl(urls, args[0]);
      return;
    }
    if (helper === 'gn') {
      if (args[0] !== null) pushUrl(urls, googleNewsUrl(args[0]));
      return;
    }
    if (helper === 'gnLocale') {
      if (args.slice(0, 4).every((value) => value !== null)) {
        pushUrl(urls, googleNewsUrl(args[0], args[1], args[2], args[3]));
      }
      return;
    }
  }

  ts.forEachChild(node, (child) => collectFeedUrls(child, urls));
}

function parseFeedDeclarationSource(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseErrors = sourceFile.parseDiagnostics || [];
  if (parseErrors.length > 0) {
    const detail = ts.flattenDiagnosticMessageText(parseErrors[0].messageText, ' ');
    throw new Error(`Cannot parse feed declarations in ${fileName}: ${detail}`);
  }

  const declarations = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const nameProperty = propertyAssignment(node, 'name');
      const urlProperty = propertyAssignment(node, 'url');
      const name = nameProperty ? stringLiteralText(nameProperty.initializer) : null;
      if (name && urlProperty) {
        const urls = [];
        collectFeedUrls(urlProperty.initializer, urls);
        for (const url of urls) declarations.push(classifyFeedDeclaration(name, url));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

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
