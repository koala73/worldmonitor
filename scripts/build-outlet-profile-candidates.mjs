#!/usr/bin/env node
/**
 * Offline helper for shared/outlet-profile.json. Collects the evidence the
 * repo already holds about every catalog outlet (hosts, host-derived origin,
 * source-geography locality, declared feed language, state affiliation,
 * publisher family, Telegram region) so a reviewer can tag outlets that have
 * no profile yet. Never runs in CI and never writes the registry itself.
 *
 *   npx tsx scripts/build-outlet-profile-candidates.mjs > candidates.json
 *   npx tsx scripts/build-outlet-profile-candidates.mjs --all > candidates.json
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOutletCatalog } from './lib/outlet-catalog.mjs';
import { resolveHostOrigin } from './source-origin.mjs';
import { loadSourceGeography } from './source-catalog-identity.mjs';
import { publisherFamilyFor } from '../shared/publisher-families.js';
import { SOURCE_PROPAGANDA_RISK, getSourceType } from '../shared/source-provenance.ts';
import { TELEGRAM_CHANNEL_TRUST } from '../shared/telegram-channel-trust.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const includeProfiled = process.argv.includes('--all');

/** Publisher host behind a feed URL, unwrapping Google News `site:` queries. */
function publisherHost(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname === 'news.google.com') {
    const site = /site:([^\s)]+)/.exec(url.searchParams.get('q') ?? '');
    return site ? site[1].toLowerCase() : null;
  }
  return url.hostname.toLowerCase();
}

const telegramRegions = new Map(
  Object.values(JSON.parse(readFileSync(join(repoRoot, 'data/telegram-channels.json'), 'utf8')).channels)
    .flat()
    .map((channel) => [channel.handle, channel.region]),
);
const telegramByName = new Map(TELEGRAM_CHANNEL_TRUST.map((entry) => [entry.name, entry]));
const profiles = JSON.parse(readFileSync(join(repoRoot, 'shared/outlet-profile.json'), 'utf8'));
const geography = loadSourceGeography(repoRoot);
const catalog = await loadOutletCatalog(repoRoot);

const candidates = {};
for (const [name, outlet] of [...catalog].sort(([a], [b]) => a.localeCompare(b))) {
  if (!includeProfiled && Object.prototype.hasOwnProperty.call(profiles, name)) continue;
  const hosts = [...new Set([...outlet.urls].map(publisherHost).filter(Boolean))];
  const hostOrigins = Object.fromEntries(hosts.map((host) => [host, resolveHostOrigin(host) ?? null]));
  const risk = SOURCE_PROPAGANDA_RISK[name] ?? telegramByName.get(name);
  const telegram = telegramByName.get(name);
  candidates[name] = {
    kinds: [...outlet.kinds],
    hosts,
    hostOrigins,
    declaredLangs: [...outlet.langs],
    localTo: geography.get(name) ?? null,
    stateAffiliated: risk?.stateAffiliated ?? null,
    sourceType: getSourceType(name),
    family: publisherFamilyFor(name) || null,
    telegramHandle: telegram?.handle ?? null,
    telegramRegion: telegram ? telegramRegions.get(telegram.handle) ?? null : null,
    provenanceNote: risk?.note ?? null,
  };
}

process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
