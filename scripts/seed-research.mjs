#!/usr/bin/env node

/**
 * Seed research data to Redis for 4 research endpoints:
 * - listArxivPapers (cs.AI default category)
 * - listHackernewsItems (top feed)
 * - listTechEvents (Techmeme ICS + dev.events RSS) — relay also seeds this
 * - listTrendingRepos (python, javascript, typescript daily)
 */

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKeyWithMeta, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const ARXIV_TTL = 3600;
const HN_TTL = 600;
const TECH_EVENTS_TTL = 28800; // 8h — outlives maxStaleMin:480 for health buffer
const TRENDING_TTL = 3600;

// ─── arXiv Papers ───

async function fetchArxivPapers() {
  const categories = ['cs.AI', 'cs.CL', 'cs.CR'];
  const results = {};

  for (const cat of categories) {
    const url = `https://export.arxiv.org/api/query?search_query=cat:${cat}&start=0&max_results=50`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/xml', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) { console.warn(`  arXiv ${cat}: HTTP ${resp.status}`); continue; }
    const xml = await resp.text();

    // Simple XML parse for arXiv entries
    const papers = [];
    const entryBlocks = xml.split('<entry>').slice(1);
    for (const block of entryBlocks) {
      const id = (block.match(/<id>([\s\S]*?)<\/id>/)?.[1] || '').trim().split('/').pop() || '';
      const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim().replace(/\s+/g, ' ');
      const summary = (block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '').trim().replace(/\s+/g, ' ');
      const published = block.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() || '';
      const publishedAt = published ? new Date(published).getTime() : 0;
      const urlMatch = block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/);
      const paperUrl = urlMatch?.[1] || `https://arxiv.org/abs/${id}`;

      const authors = [];
      const authorMatches = block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g);
      for (const m of authorMatches) authors.push(m[1].trim());

      const cats = [];
      const catMatches = block.matchAll(/<category[^>]*term="([^"]+)"/g);
      for (const m of catMatches) cats.push(m[1]);

      if (title && id) papers.push({ id, title, summary, authors, categories: cats, publishedAt, url: paperUrl });
    }

    const cacheKey = `research:arxiv:v1:${cat}::50`;
    if (papers.length > 0) {
      results[cacheKey] = { papers, pagination: undefined };
    }
    console.log(`  arXiv ${cat}: ${papers.length} papers`);
    await sleep(3000); // arXiv rate limit: 1 req/3s
  }
  return results;
}

// ─── Hacker News ───

async function fetchHackerNews() {
  const feeds = ['top', 'best'];
  const results = {};

  for (const feed of feeds) {
    const idsResp = await fetch(`https://hacker-news.firebaseio.com/v0/${feed}stories.json`, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!idsResp.ok) { console.warn(`  HN ${feed}: HTTP ${idsResp.status}`); continue; }
    const allIds = await idsResp.json();
    if (!Array.isArray(allIds)) continue;

    const ids = allIds.slice(0, 30);
    const items = [];

    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      const batchResults = await Promise.all(
        batch.map(async (id) => {
          try {
            const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
              headers: { 'User-Agent': CHROME_UA },
              signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) return null;
            const raw = await res.json();
            if (!raw || raw.type !== 'story') return null;
            return {
              id: raw.id || 0, title: raw.title || '', url: raw.url || '',
              score: raw.score || 0, commentCount: raw.descendants || 0,
              by: raw.by || '', submittedAt: (raw.time || 0) * 1000,
            };
          } catch { return null; }
        }),
      );
      items.push(...batchResults.filter(Boolean));
    }

    const cacheKey = `research:hackernews:v1:${feed}:30`;
    if (items.length > 0) {
      results[cacheKey] = { items, pagination: undefined };
    }
    console.log(`  HN ${feed}: ${items.length} stories`);
  }
  return results;
}

// ─── Tech Events (Techmeme ICS + dev.events RSS) ───

async function fetchTechEvents() {
  const ICS_URL = 'https://www.techmeme.com/newsy_events.ics';
  const RSS_URL = 'https://dev.events/rss.xml';
  const events = [];

  // Techmeme ICS
  try {
    const resp = await fetch(ICS_URL, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(8_000),
    });
    if (resp.ok) {
      const ics = await resp.text();
      const blocks = ics.split('BEGIN:VEVENT').slice(1);
      for (const block of blocks) {
        const summary = block.match(/SUMMARY:(.+)/)?.[1]?.trim() || '';
        const location = block.match(/LOCATION:(.+)/)?.[1]?.trim() || '';
        const dtstart = block.match(/DTSTART;VALUE=DATE:(\d+)/)?.[1] || '';
        const dtend = block.match(/DTEND;VALUE=DATE:(\d+)/)?.[1] || dtstart;
        const url = block.match(/URL:(.+)/)?.[1]?.trim() || '';
        const uid = block.match(/UID:(.+)/)?.[1]?.trim() || '';
        if (!summary || !dtstart) continue;
        let type = 'other';
        if (summary.startsWith('Earnings:')) type = 'earnings';
        else if (summary.startsWith('IPO')) type = 'ipo';
        else if (location) type = 'conference';
        events.push({
          id: uid, title: summary, type, location,
          startDate: `${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6, 8)}`,
          endDate: `${dtend.slice(0, 4)}-${dtend.slice(4, 6)}-${dtend.slice(6, 8)}`,
          url, source: 'techmeme', description: '',
        });
      }
      console.log(`  Techmeme ICS: ${events.length} events`);
    }
  } catch (e) { console.warn(`  Techmeme ICS: ${e.message}`); }

  // dev.events RSS
  const rssCount = events.length;
  try {
    const resp = await fetch(RSS_URL, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/rss+xml, text/xml, */*' },
      signal: AbortSignal.timeout(8_000),
    });
    if (resp.ok) {
      const rss = await resp.text();
      const items = rss.matchAll(/<item>([\s\S]*?)<\/item>/g);
      const today = new Date().toISOString().split('T')[0];
      for (const m of items) {
        const block = m[1];
        const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/)?.[1] ||
                       block.match(/<title>(.*?)<\/title>/)?.[1] || '').trim();
        const link = block.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || '';
        const desc = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ||
                      block.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').trim();
        const guid = block.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1]?.trim() || '';
        if (!title) continue;
        const dateMatch = desc.match(/on\s+(\w+\s+\d{1,2},?\s+\d{4})/i);
        let startDate = null;
        if (dateMatch) { const p = new Date(dateMatch[1]); if (!Number.isNaN(p.getTime())) startDate = p.toISOString().split('T')[0]; }
        if (!startDate || startDate < today) continue;
        events.push({
          id: guid || `dev-${title.slice(0, 20)}`, title, type: 'conference',
          location: '', startDate, endDate: startDate, url: link,
          source: 'dev.events', description: '',
        });
      }
      console.log(`  dev.events RSS: ${events.length - rssCount} events`);
    }
  } catch (e) { console.warn(`  dev.events RSS: ${e.message}`); }

  // Curated major conferences (must match list-tech-events.ts CURATED_EVENTS)
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const CURATED = [
    { id: 'gitex-global-2026', title: 'GITEX Global 2026', type: 'conference', location: 'Dubai World Trade Centre, Dubai',
      coords: { lat: 25.2285, lng: 55.2867, country: 'UAE', original: 'Dubai World Trade Centre, Dubai', virtual: false },
      startDate: '2026-12-07', endDate: '2026-12-11', url: 'https://www.gitex.com', source: 'curated', description: "World's largest tech & startup show" },
    { id: 'token2049-dubai-2026', title: 'TOKEN2049 Dubai 2026', type: 'conference', location: 'Dubai, UAE',
      coords: { lat: 25.2048, lng: 55.2708, country: 'UAE', original: 'Dubai, UAE', virtual: false },
      startDate: '2026-04-29', endDate: '2026-04-30', url: 'https://www.token2049.com', source: 'curated', description: 'Premier crypto event in Dubai' },
    { id: 'collision-2026', title: 'Collision 2026', type: 'conference', location: 'Toronto, Canada',
      coords: { lat: 43.6532, lng: -79.3832, country: 'Canada', original: 'Toronto, Canada', virtual: false },
      startDate: '2026-06-22', endDate: '2026-06-25', url: 'https://collisionconf.com', source: 'curated', description: "North America's fastest growing tech conference" },
    { id: 'web-summit-2026', title: 'Web Summit 2026', type: 'conference', location: 'Lisbon, Portugal',
      coords: { lat: 38.7223, lng: -9.1393, country: 'Portugal', original: 'Lisbon, Portugal', virtual: false },
      startDate: '2026-11-02', endDate: '2026-11-05', url: 'https://websummit.com', source: 'curated', description: "The world's premier tech conference" },
  ];
  for (const c of CURATED) { if (new Date(c.startDate) >= now) events.push(c); }

  // Deduplicate
  const seen = new Set();
  const deduped = events.filter(e => {
    const key = e.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) + e.startDate.slice(0, 4);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.startDate.localeCompare(b.startDate));

  console.log(`  Tech events total: ${deduped.length} (deduplicated)`);
  return {
    success: true, count: deduped.length,
    conferenceCount: deduped.filter(e => e.type === 'conference').length,
    mappableCount: 0, lastUpdated: new Date().toISOString(),
    events: deduped, error: '',
  };
}

// ─── Trending Repos ───

const OSSINSIGHT_LANG_MAP = { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript' };

async function fetchTrendingFromOSSInsight(lang) {
  const ossLang = OSSINSIGHT_LANG_MAP[lang] || lang;
  const resp = await fetch(
    `https://api.ossinsight.io/v1/trends/repos/?language=${ossLang}&period=past_24_hours`,
    {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!resp.ok) return null;
  const json = await resp.json();
  const rows = json?.data?.rows;
  if (!Array.isArray(rows)) return null;
  return rows.slice(0, 50).map(r => ({
    fullName: r.repo_name || '', description: r.description || '',
    language: r.primary_language || lang, stars: r.stars || 0,
    starsToday: 0, forks: r.forks || 0,
    url: r.repo_name ? `https://github.com/${r.repo_name}` : '',
  }));
}

async function fetchTrendingFromGitHubSearch(lang) {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const resp = await fetch(
    `https://api.github.com/search/repositories?q=language:${lang}+created:>${since}&sort=stars&order=desc&per_page=50`,
    {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!Array.isArray(data?.items)) return null;
  return data.items.map(r => ({
    fullName: r.full_name, description: r.description || '',
    language: r.language || '', stars: r.stargazers_count || 0,
    starsToday: 0, forks: r.forks_count || 0,
    url: r.html_url,
  }));
}

async function fetchTrendingRepos() {
  const languages = ['python', 'javascript', 'typescript'];
  const results = {};

  for (const lang of languages) {
    try {
      let repos = await fetchTrendingFromOSSInsight(lang);
      if (!repos) repos = await fetchTrendingFromGitHubSearch(lang);
      if (!repos || repos.length === 0) { console.warn(`  Trending ${lang}: no data from any source`); continue; }

      const cacheKey = `research:trending:v1:${lang}:daily:50`;
      results[cacheKey] = { repos, pagination: undefined };
      console.log(`  Trending ${lang}: ${repos.length} repos`);
      await sleep(500);
    } catch (e) {
      console.warn(`  Trending ${lang}: ${e.message}`);
    }
  }
  return results;
}

// ─── Main ───

let allData = null;

async function fetchAll() {
  const [arxiv, hn, techEvents, trending] = await Promise.allSettled([
    fetchArxivPapers(),
    fetchHackerNews(),
    fetchTechEvents(),
    fetchTrendingRepos(),
  ]);

  allData = {
    arxiv: arxiv.status === 'fulfilled' ? arxiv.value : null,
    hn: hn.status === 'fulfilled' ? hn.value : null,
    techEvents: techEvents.status === 'fulfilled' ? techEvents.value : null,
    trending: trending.status === 'fulfilled' ? trending.value : null,
  };

  if (arxiv.status === 'rejected') console.warn(`  arXiv failed: ${arxiv.reason?.message || arxiv.reason}`);
  if (hn.status === 'rejected') console.warn(`  HN failed: ${hn.reason?.message || hn.reason}`);
  if (techEvents.status === 'rejected') console.warn(`  TechEvents failed: ${techEvents.reason?.message || techEvents.reason}`);
  if (trending.status === 'rejected') console.warn(`  Trending failed: ${trending.reason?.message || trending.reason}`);

  if (!allData.arxiv && !allData.hn && !allData.trending) throw new Error('All research fetches failed');

  // Write secondary keys BEFORE returning (runSeed calls process.exit after primary write)
  if (allData.arxiv) {
    for (const [key, data] of Object.entries(allData.arxiv)) {
      if (key === 'research:arxiv:v1:cs.AI::50') continue;
      await writeExtraKeyWithMeta(key, data, ARXIV_TTL, data.papers?.length ?? 0);
    }
  }
  if (allData.hn) { for (const [key, data] of Object.entries(allData.hn)) await writeExtraKeyWithMeta(key, data, HN_TTL, data.items?.length ?? 0); }
  if (allData.techEvents?.events?.length > 0) await writeExtraKeyWithMeta('research:tech-events:v1', allData.techEvents, TECH_EVENTS_TTL, allData.techEvents.events.length);
  if (allData.trending) { for (const [key, data] of Object.entries(allData.trending)) await writeExtraKeyWithMeta(key, data, TRENDING_TTL, data.repos?.length ?? 0); }

  const primaryKey = allData.arxiv?.['research:arxiv:v1:cs.AI::50'];
  return primaryKey || { papers: [], pagination: undefined };
}

function validate(data) {
  return data?.papers?.length > 0;
}

export function declareRecords(data) {
  return data?.papers?.length ?? 0;
}

runSeed('research', 'arxiv-hn-trending', 'research:arxiv:v1:cs.AI::50', fetchAll, {
  validateFn: validate,
  ttlSeconds: ARXIV_TTL,
  sourceVersion: 'arxiv-hn-gitter',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 150,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
