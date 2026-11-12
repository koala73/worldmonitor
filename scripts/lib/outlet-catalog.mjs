/**
 * Every outlet WorldMonitor names, keyed by source name: both RSS catalogs
 * (src/config/feeds.ts and server/worldmonitor/news/v1/_feeds.ts), Telegram
 * channels, X accounts, and every name in the tier and provenance tables
 * (aggregated publishers such as Reuters or AFP that no feed is named after). The outlet profile gate and the candidate builder
 * share this so they cannot disagree about the population.
 *
 * Imports TypeScript modules, so run it under tsx.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { bundleFeedsModule } from '../geo-coverage-health.mjs';

function feedUrls(url) {
  if (typeof url === 'string') return [url];
  if (url && typeof url === 'object') return Object.values(url).filter((value) => typeof value === 'string');
  return [];
}

/**
 * @returns {Promise<Map<string, { kinds: Set<string>, urls: Set<string>, langs: Set<string>, handles: Set<string> }>>}
 */
export async function loadOutletCatalog(repoRoot) {
  const importTs = (relativePath) => import(pathToFileURL(join(repoRoot, relativePath)).href);
  const [server, telegram, x, tiers, provenance] = await Promise.all([
    importTs('server/worldmonitor/news/v1/_feeds.ts'),
    importTs('shared/telegram-channel-trust.ts'),
    importTs('shared/x-account-trust.ts'),
    importTs('server/_shared/source-tiers.ts'),
    importTs('shared/source-provenance.ts'),
  ]);
  const { feeds: client, cleanup } = await bundleFeedsModule(repoRoot);

  const outlets = new Map();
  const add = (name, kind, { url, lang, handle } = {}) => {
    if (typeof name !== 'string' || name.trim() === '') return;
    let entry = outlets.get(name);
    if (!entry) {
      entry = { kinds: new Set(), urls: new Set(), langs: new Set(), handles: new Set() };
      outlets.set(name, entry);
    }
    entry.kinds.add(kind);
    for (const value of feedUrls(url)) entry.urls.add(value);
    if (lang) entry.langs.add(lang);
    if (handle) entry.handles.add(handle);
  };

  try {
    const rssLists = [
      ...Object.values(server.VARIANT_FEEDS).flatMap((categories) => Object.values(categories)),
      server.INTEL_SOURCES,
      ...Object.values(client.CANONICAL_FEEDS),
      ...Object.values(client.ON_DEMAND_FEEDS),
      client.INTEL_SOURCES,
    ];
    for (const list of rssLists) {
      for (const feed of list) add(feed.name, 'rss', { url: feed.url, lang: feed.lang });
    }
  } finally {
    cleanup();
  }
  for (const channel of telegram.TELEGRAM_CHANNEL_TRUST) add(channel.name, 'telegram', { handle: channel.handle });
  for (const account of x.X_ACCOUNT_TRUST) add(account.sourceName, 'x');
  for (const name of Object.keys(tiers.SOURCE_TIERS)) add(name, 'tier');
  for (const name of Object.keys(provenance.SOURCE_PROPAGANDA_RISK)) add(name, 'provenance');
  return outlets;
}

/** True when every URL the outlet is fetched from is a Google News search with no site: term. */
export function isKeywordSearchOnly(outlet) {
  const urls = outlet && outlet.urls instanceof Set ? [...outlet.urls] : [];
  if (urls.length === 0) return false;
  return urls.every((url) => {
    const match = /news\.google\.com\/rss\/search\?q=([^&]*)/.exec(decodeURIComponent(url));
    return match !== null && !/\bsite:/.test(match[1]);
  });
}

const AUDIENCES = new Set(['domestic', 'international', 'diaspora']);
const OWNERSHIP_CLASSES = new Set(['state', 'public-service', 'private', 'nonprofit', 'intergovernmental', 'unreviewed']);
const PROFILE_KEYS = new Set(['country', 'audience', 'language', 'ownershipClass', 'note']);

/**
 * Closed-world check of shared/outlet-profile.json against the catalog.
 * Returns problems; an empty list is clean.
 *
 * @param {{
 *   profiles: Record<string, any>,
 *   catalog: Map<string, unknown>,
 *   validCountries: Set<string>,
 *   familyFor: (name: string) => string,
 *   isStateAffiliated: (name: string) => boolean,
 * }} input
 */
export function validateOutletProfiles({ profiles, catalog, validCountries, familyFor, isStateAffiliated }) {
  const problems = [];
  const entries = Object.entries(profiles).filter(([name]) => !name.startsWith('_'));
  const profileNames = new Set(entries.map(([name]) => name));

  for (const name of catalog.keys()) {
    if (!profileNames.has(name)) problems.push(`missing profile: ${name}`);
  }

  const familyCountry = new Map();
  for (const [name, profile] of entries) {
    const outlet = catalog.get(name);
    if (!outlet) {
      problems.push(`stale profile (not in any catalog): ${name}`);
      continue;
    }
    if (!profile || typeof profile !== 'object') {
      problems.push(`${name}: profile must be an object`);
      continue;
    }
    for (const key of Object.keys(profile)) {
      if (!PROFILE_KEYS.has(key)) problems.push(`${name}: unknown field ${key}`);
    }
    if (!validCountries.has(profile.country)) problems.push(`${name}: invalid country ${profile.country}`);
    if (!AUDIENCES.has(profile.audience)) problems.push(`${name}: invalid audience ${profile.audience}`);
    if (typeof profile.language !== 'string' || !/^[a-z]{2,3}$/.test(profile.language)) {
      problems.push(`${name}: invalid language ${profile.language}`);
    }
    if (!OWNERSHIP_CLASSES.has(profile.ownershipClass)) {
      problems.push(`${name}: invalid ownershipClass ${profile.ownershipClass}`);
    }
    if (profile.ownershipClass === 'unreviewed' && isStateAffiliated(name)) {
      problems.push(`${name}: state-affiliated outlet must have a reviewed ownershipClass`);
    }

    // A Google News keyword search without site: returns many publishers'
    // stories, so it has no single home country or owner.
    const multiPublisher = isKeywordSearchOnly(outlet);
    if (multiPublisher && (profile.country !== 'INTL' || profile.ownershipClass !== 'unreviewed')) {
      problems.push(`${name}: keyword-search feed (no site:) must be INTL and unreviewed`);
    }

    const family = familyFor(name);
    if (family && !multiPublisher) {
      const seen = familyCountry.get(family);
      if (!seen) familyCountry.set(family, { country: profile.country, name });
      else if (seen.country !== profile.country) {
        problems.push(`publisher family ${family}: ${seen.name} is ${seen.country} but ${name} is ${profile.country}`);
      }
    }
  }
  return problems;
}
