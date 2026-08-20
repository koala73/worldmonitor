/**
 * Logical publisher identity for the public source catalog.
 *
 * Host ledger rows stay host-centric. Syndication transports such as
 * FeedBurner and Google News remain visible there, but they are not catalog
 * providers. Named feed declarations supply the publisher identity, origin,
 * and coverage geography that the catalog UI shows.
 */
import { existsSync, readFileSync } from 'node:fs';
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

const NAME_RE = /name:\s*(?:'((?:[^'\\]|\\.)*)'|"([^"]+)")/;
const RSS_URL_RE = /(?:rss|railwayRss)\(\s*'([^']+)'\s*\)/g;
const DIRECT_URL_RE = /url:\s*'((?:https?:)[^']+)'/g;
const GN_RE = /\bgn\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
const GN_LOCALE_RE = /\bgnLocale\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;

function unescapeName(value) {
  return String(value || '').replace(/\\'/g, "'");
}

function googleNewsUrl(query, hl = 'en-US', gl = 'US', ceid = 'US:en') {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

export function isSyndicationTransportHost(host) {
  return SYNDICATION_TRANSPORT_HOSTS.has(String(host || '').toLowerCase());
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

function parseFeedDeclarationSource(source) {
  const declarations = [];
  let currentName = null;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//')) continue;
    const nameMatch = line.match(NAME_RE);
    if (nameMatch) currentName = unescapeName(nameMatch[1] || nameMatch[2]);

    const urls = [];
    RSS_URL_RE.lastIndex = 0;
    for (const match of line.matchAll(RSS_URL_RE)) pushUrl(urls, match[1]);
    DIRECT_URL_RE.lastIndex = 0;
    for (const match of line.matchAll(DIRECT_URL_RE)) pushUrl(urls, match[1]);
    GN_RE.lastIndex = 0;
    for (const match of line.matchAll(GN_RE)) {
      pushUrl(urls, googleNewsUrl(unescapeName(match[1])));
    }
    GN_LOCALE_RE.lastIndex = 0;
    for (const match of line.matchAll(GN_LOCALE_RE)) {
      pushUrl(urls, googleNewsUrl(unescapeName(match[1]), match[2], match[3], match[4]));
    }
    if (!currentName || urls.length === 0) continue;
    for (const url of urls) {
      declarations.push(classifyFeedDeclaration(currentName, url));
    }
  }
  return declarations;
}

export function classifyFeedDeclaration(name, url) {
  const host = hostFromFeedUrl(url);
  let query = '';
  if (host === 'news.google.com') {
    try {
      query = new URL(url).searchParams.get('q') || '';
    } catch {
      query = '';
    }
  }
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
    if (!existsSync(path)) continue;
    for (const declaration of parseFeedDeclarationSource(readFileSync(path, 'utf8'))) {
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
  if (!existsSync(path)) return new Map();
  const doc = JSON.parse(readFileSync(path, 'utf8'));
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
  return [...countries].sort();
}

export function validateFeedBurnerPublisherIdentity(declarations) {
  const errors = [];
  for (const declaration of declarations) {
    if (!declaration.transportHosts.includes('feeds.feedburner.com')
      && !declaration.transportHosts.includes('feedburner.com')) {
      continue;
    }
    if (!declaration.name || !declaration.publisher) {
      errors.push(
        `FeedBurner URL ${declaration.url} requires an explicit publisher identity`,
      );
    }
  }
  return errors;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

/**
 * Publishers that exist only through a syndication transport, so the host
 * ledger cannot name them from an editorial hostname.
 */
export function buildLogicalProviders(declarations, geography = new Map()) {
  const byPublisher = new Map();
  for (const declaration of declarations) {
    if (declaration.editorialHosts.length > 0) continue;
    if (!declaration.transportHosts.includes('feeds.feedburner.com')
      && !declaration.transportHosts.includes('feedburner.com')) {
      continue;
    }
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
  if (entry.role === 'transport') return false;
  return !isSyndicationTransportHost(entry.host);
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
      addAll(coverageByHost, host, coverage);
      addAll(transportsByHost, host, declaration.transportHosts);
    }
  }

  return catalog.map((provider) => {
    const covered = new Set(provider.coveredCountries || []);
    const transports = new Set(provider.transportHosts || []);
    for (const value of coverageByPublisher.get(provider.provider) || []) covered.add(value);
    for (const value of transportsByPublisher.get(provider.provider) || []) transports.add(value);
    for (const host of provider.hosts || []) {
      for (const value of coverageByHost.get(host) || []) covered.add(value);
      for (const value of transportsByHost.get(host) || []) transports.add(value);
    }
    return {
      ...provider,
      coveredCountries: [...covered].sort(),
      transportHosts: [...transports].sort(),
    };
  });
}
