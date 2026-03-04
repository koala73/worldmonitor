/**
 * Company Enrichment API — Vercel Edge Function
 * Aggregates company data from multiple public sources:
 * - GitHub org data
 * - Hacker News mentions
 * - SEC EDGAR filings (public US companies)
 * - Tech stack inference from GitHub repos
 *
 * GET /api/enrichment/company?domain=example.com
 * GET /api/enrichment/company?name=Stripe
 */

import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { checkRateLimit } from '../_rate-limit.js';

export const config = { runtime: 'edge' };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CACHE_TTL_SECONDS = 3600;

async function fetchGitHubOrg(name) {
  try {
    const res = await fetch(`https://api.github.com/orgs/${encodeURIComponent(name)}`, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': UA },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      name: data.name || data.login,
      description: data.description,
      blog: data.blog,
      location: data.location,
      publicRepos: data.public_repos,
      followers: data.followers,
      avatarUrl: data.avatar_url,
      createdAt: data.created_at,
    };
  } catch {
    return null;
  }
}

async function fetchGitHubTechStack(orgName) {
  try {
    const res = await fetch(
      `https://api.github.com/orgs/${encodeURIComponent(orgName)}/repos?sort=stars&per_page=10`,
      {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': UA },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return [];
    const repos = await res.json();
    const languages = new Map();
    for (const repo of repos) {
      if (repo.language) {
        languages.set(repo.language, (languages.get(repo.language) || 0) + repo.stargazers_count + 1);
      }
    }
    return Array.from(languages.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([lang, score]) => ({ name: lang, category: 'Programming Language', confidence: Math.min(1, score / 100) }));
  } catch {
    return [];
  }
}

async function fetchSECData(companyName) {
  try {
    const res = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(companyName)}&dateRange=custom&startdt=${getDateMonthsAgo(6)}&enddt=${getTodayISO()}&forms=10-K,10-Q,8-K&from=0&size=5`,
      {
        headers: { 'User-Agent': 'WorldMonitor research@worldmonitor.app', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.hits || !data.hits.hits || data.hits.hits.length === 0) return null;
    return {
      totalFilings: data.hits.total?.value || 0,
      recentFilings: data.hits.hits.slice(0, 5).map((h) => ({
        form: h._source?.form_type || h._source?.file_type,
        date: h._source?.file_date || h._source?.period_of_report,
        description: h._source?.display_names?.[0] || companyName,
      })),
    };
  } catch {
    return null;
  }
}

async function fetchHackerNewsMentions(companyName) {
  try {
    const res = await fetch(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(companyName)}&tags=story&hitsPerPage=5`,
      {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.hits || []).map((h) => ({
      title: h.title,
      url: h.url,
      points: h.points,
      comments: h.num_comments,
      date: h.created_at,
    }));
  } catch {
    return [];
  }
}

function inferFromDomain(domain) {
  const name = domain.replace(/\.(com|io|co|org|net|ai|dev|app)$/, '')
    .split('.')
    .pop()
    ?.replace(/-/g, ' ')
    ?.replace(/\b\w/g, (c) => c.toUpperCase()) || domain;

  return { inferredName: name, domain };
}

function getTodayISO() {
  return new Date().toISOString().split('T')[0];
}

function getDateMonthsAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().split('T')[0];
}

export default async function handler(req) {
  const cors = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (isDisallowedOrigin(req)) {
    return new Response('Forbidden', { status: 403, headers: cors });
  }

  const rateLimitResult = await checkRateLimit(req, 'enrichment', 30, '60s');
  if (rateLimitResult) return rateLimitResult;

  const url = new URL(req.url);
  const domain = url.searchParams.get('domain')?.trim().toLowerCase();
  const name = url.searchParams.get('name')?.trim();

  if (!domain && !name) {
    return new Response(JSON.stringify({ error: 'Provide ?domain= or ?name= parameter' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const companyName = name || (domain ? inferFromDomain(domain).inferredName : 'Unknown');
  const searchName = companyName.toLowerCase().replace(/\s+/g, '');

  const [githubOrg, techStack, secData, hnMentions] = await Promise.all([
    fetchGitHubOrg(searchName),
    fetchGitHubTechStack(searchName),
    fetchSECData(companyName),
    fetchHackerNewsMentions(companyName),
  ]);

  const enrichedData = {
    company: {
      name: githubOrg?.name || companyName,
      domain: domain || githubOrg?.blog?.replace(/^https?:\/\//, '').replace(/\/$/, '') || null,
      description: githubOrg?.description || null,
      location: githubOrg?.location || null,
      website: githubOrg?.blog || (domain ? `https://${domain}` : null),
      founded: githubOrg?.createdAt ? new Date(githubOrg.createdAt).getFullYear() : null,
    },
    github: githubOrg ? {
      publicRepos: githubOrg.publicRepos,
      followers: githubOrg.followers,
      avatarUrl: githubOrg.avatarUrl,
    } : null,
    techStack: techStack.length > 0 ? techStack : null,
    secFilings: secData,
    hackerNewsMentions: hnMentions.length > 0 ? hnMentions : null,
    enrichedAt: new Date().toISOString(),
    sources: [
      githubOrg ? 'github' : null,
      techStack.length > 0 ? 'github_repos' : null,
      secData ? 'sec_edgar' : null,
      hnMentions.length > 0 ? 'hacker_news' : null,
    ].filter(Boolean),
  };

  return new Response(JSON.stringify(enrichedData), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${CACHE_TTL_SECONDS * 2}`,
    },
  });
}
