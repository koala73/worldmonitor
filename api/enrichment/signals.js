/**
 * Signal Discovery API — Vercel Edge Function
 * Discovers activity signals for a company from public sources:
 * - News mentions (Hacker News)
 * - GitHub activity spikes
 * - Job posting signals (HN hiring threads)
 *
 * GET /api/enrichment/signals?company=Stripe&domain=stripe.com
 */

import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { checkRateLimit } from '../_rate-limit.js';

export const config = { runtime: 'edge' };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SIGNAL_KEYWORDS = {
  hiring_surge: ['hiring', 'we\'re hiring', 'join our team', 'open positions', 'new roles', 'growing team'],
  funding_event: ['raised', 'funding', 'series', 'investment', 'valuation', 'backed by'],
  expansion_signal: ['expansion', 'new office', 'opening', 'entering market', 'new region', 'international'],
  technology_adoption: ['migrating to', 'adopting', 'implementing', 'rolling out', 'tech stack', 'infrastructure'],
  executive_movement: ['appointed', 'joins as', 'new ceo', 'new cto', 'new vp', 'leadership change', 'promoted to'],
  financial_trigger: ['revenue', 'ipo', 'acquisition', 'merger', 'quarterly results', 'earnings'],
};

function classifySignal(text) {
  const lower = text.toLowerCase();
  for (const [type, keywords] of Object.entries(SIGNAL_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return type;
    }
  }
  return 'press_release';
}

function scoreSignalStrength(points, comments, recencyDays) {
  let score = 0;
  if (points > 100) score += 3;
  else if (points > 30) score += 2;
  else score += 1;

  if (comments > 50) score += 2;
  else if (comments > 10) score += 1;

  if (recencyDays <= 3) score += 3;
  else if (recencyDays <= 7) score += 2;
  else if (recencyDays <= 14) score += 1;

  if (score >= 7) return 'critical';
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

async function fetchHNSignals(companyName) {
  try {
    const res = await fetch(
      `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(companyName)}&tags=story&hitsPerPage=20&numericFilters=created_at_i>${Math.floor(Date.now() / 1000) - 30 * 86400}`,
      {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return [];
    const data = await res.json();
    const now = Date.now();

    return (data.hits || []).map((h) => {
      const recencyDays = (now - new Date(h.created_at).getTime()) / 86400000;
      return {
        type: classifySignal(h.title),
        title: h.title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        source: 'Hacker News',
        sourceTier: 2,
        timestamp: h.created_at,
        strength: scoreSignalStrength(h.points || 0, h.num_comments || 0, recencyDays),
        engagement: { points: h.points, comments: h.num_comments },
      };
    });
  } catch {
    return [];
  }
}

async function fetchGitHubSignals(orgName) {
  try {
    const res = await fetch(
      `https://api.github.com/orgs/${encodeURIComponent(orgName)}/repos?sort=created&per_page=10`,
      {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': UA },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return [];
    const repos = await res.json();
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 86400000;

    return repos
      .filter((r) => new Date(r.created_at).getTime() > thirtyDaysAgo)
      .map((r) => ({
        type: 'technology_adoption',
        title: `New repository: ${r.full_name} — ${r.description || 'No description'}`,
        url: r.html_url,
        source: 'GitHub',
        sourceTier: 2,
        timestamp: r.created_at,
        strength: r.stargazers_count > 50 ? 'high' : r.stargazers_count > 10 ? 'medium' : 'low',
        engagement: { stars: r.stargazers_count, forks: r.forks_count },
      }));
  } catch {
    return [];
  }
}

async function fetchJobSignals(companyName) {
  try {
    const res = await fetch(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(companyName)}&tags=comment,ask_hn&hitsPerPage=10&numericFilters=created_at_i>${Math.floor(Date.now() / 1000) - 60 * 86400}`,
      {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return [];
    const data = await res.json();

    const hiringComments = (data.hits || []).filter((h) => {
      const text = (h.comment_text || '').toLowerCase();
      return text.includes('hiring') || text.includes('job') || text.includes('apply');
    });

    if (hiringComments.length === 0) return [];

    return [{
      type: 'hiring_surge',
      title: `${companyName} hiring activity (${hiringComments.length} mentions in HN hiring threads)`,
      url: `https://news.ycombinator.com/item?id=${hiringComments[0].story_id}`,
      source: 'HN Hiring Threads',
      sourceTier: 3,
      timestamp: hiringComments[0].created_at,
      strength: hiringComments.length >= 3 ? 'high' : 'medium',
      engagement: { mentions: hiringComments.length },
    }];
  } catch {
    return [];
  }
}

export default async function handler(req) {
  const cors = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (isDisallowedOrigin(req)) {
    return new Response('Forbidden', { status: 403, headers: cors });
  }

  const rateLimitResult = await checkRateLimit(req, 'signals', 20, '60s');
  if (rateLimitResult) return rateLimitResult;

  const url = new URL(req.url);
  const company = url.searchParams.get('company')?.trim();
  const domain = url.searchParams.get('domain')?.trim().toLowerCase();

  if (!company) {
    return new Response(JSON.stringify({ error: 'Provide ?company= parameter' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const orgName = domain?.replace(/\.(com|io|co|org|net|ai|dev|app)$/, '').split('.').pop() || company.toLowerCase().replace(/\s+/g, '');

  const [hnSignals, githubSignals, jobSignals] = await Promise.all([
    fetchHNSignals(company),
    fetchGitHubSignals(orgName),
    fetchJobSignals(company),
  ]);

  const allSignals = [...hnSignals, ...githubSignals, ...jobSignals]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const signalTypeCounts = {};
  for (const s of allSignals) {
    signalTypeCounts[s.type] = (signalTypeCounts[s.type] || 0) + 1;
  }

  const result = {
    company,
    domain: domain || null,
    signals: allSignals,
    summary: {
      totalSignals: allSignals.length,
      byType: signalTypeCounts,
      strongestSignal: allSignals[0] || null,
      signalDiversity: Object.keys(signalTypeCounts).length,
    },
    discoveredAt: new Date().toISOString(),
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
    },
  });
}
