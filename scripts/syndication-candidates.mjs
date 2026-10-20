#!/usr/bin/env node
/**
 * Same-copy candidates for curation (#9095).
 *
 * Reads the public news digest, clusters it into stories, and lists the feed
 * labels whose items carried the same copy (title + lead) but sit in different
 * publisher families. Corroboration already counts each such group once; this
 * report is for a person deciding whether the outlets belong in one curated
 * family in shared/publisher-families.js. Nothing is written or auto-added.
 *
 *   npm run syndication:candidates                 # live digest (full, en)
 *   npm run syndication:candidates -- --file d.json   # a saved digest response
 *   npm run syndication:candidates -- --json        # machine-readable output
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { clusterNewsCore } from './shared/news-clustering-core.js';
import { publisherFamilyFor } from './shared/publisher-families.js';
import { detectSyndication } from './shared/syndication.js';

const DIGEST_URL = 'https://www.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en&public=1';
const USER_AGENT = 'WorldMonitor-SyndicationCandidates/1.0 (+https://www.worldmonitor.app)';

function hostOf(link) {
  try {
    return new URL(link).hostname;
  } catch {
    return '';
  }
}

/**
 * Same-copy groups across a digest response, merged by label set, most
 * frequent first. Only groups that join more than one family are listed:
 * a group inside one curated family is already counted once.
 *
 * @param {{ categories?: Record<string, { items?: unknown[] }> }} body
 * @returns {{ labels: string[]; families: string[]; hosts: string[]; stories: number; example: string }[]}
 */
export function syndicationCandidates(body) {
  const seen = new Set();
  const items = [];
  for (const group of Object.values(body?.categories ?? {})) {
    for (const raw of group?.items ?? []) {
      if (!raw || typeof raw.title !== 'string' || typeof raw.source !== 'string') continue;
      const key = raw.link || `${raw.source}|${raw.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        source: raw.source,
        title: raw.title,
        snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
        link: typeof raw.link === 'string' ? raw.link : '',
        pubDate: new Date(Number(raw.publishedAt) || 0),
        isAlert: raw.isAlert === true,
      });
    }
  }

  const byLabels = new Map();
  // Tier only orders a cluster's primary item; it does not affect membership.
  for (const cluster of clusterNewsCore(items, () => 3)) {
    const { groups } = detectSyndication(cluster.allItems, (item) => publisherFamilyFor(item.source));
    for (const group of groups) {
      const labels = [...group.labels].sort();
      const key = labels.join('\u0000');
      const entry = byLabels.get(key) ?? { labels, families: group.families, hosts: new Set(), stories: 0, example: cluster.primaryTitle };
      entry.stories += 1;
      for (const item of cluster.allItems) {
        if (labels.includes(item.source)) {
          const host = hostOf(item.link);
          if (host) entry.hosts.add(host);
        }
      }
      byLabels.set(key, entry);
    }
  }
  return [...byLabels.values()]
    .map((entry) => ({ ...entry, hosts: [...entry.hosts].sort() }))
    .sort((a, b) => b.stories - a.stories || a.labels.join().localeCompare(b.labels.join()));
}

async function main(argv) {
  const fileIndex = argv.indexOf('--file');
  let body;
  if (fileIndex >= 0 && argv[fileIndex + 1]) {
    body = JSON.parse(readFileSync(argv[fileIndex + 1], 'utf8'));
  } else {
    const res = await fetch(DIGEST_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`digest HTTP ${res.status}`);
    body = await res.json();
  }
  const candidates = syndicationCandidates(body);
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
    return;
  }
  if (candidates.length === 0) {
    console.log('No same-copy groups across publisher families in this digest.');
    return;
  }
  console.log(`${candidates.length} same-copy group(s) across publisher families. Each already counts once;`);
  console.log('review whether the outlets belong in one curated family (shared/publisher-families.js).\n');
  for (const candidate of candidates) {
    console.log(`- ${candidate.labels.join(' + ')}  (${candidate.stories} ${candidate.stories === 1 ? 'story' : 'stories'})`);
    console.log(`    families: ${candidate.families.join(', ')}`);
    if (candidate.hosts.length > 0) console.log(`    hosts:    ${candidate.hosts.join(', ')}`);
    console.log(`    e.g.      ${candidate.example}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[syndication-candidates] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
