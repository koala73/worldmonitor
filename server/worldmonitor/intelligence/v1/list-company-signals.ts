/**
 * RPC: listCompanySignals -- Discovers activity signals for a company from public sources.
 * Port from api/enrichment/signals.js
 * Sources: Hacker News, GitHub
 */

import type {
  ServerContext,
  ListCompanySignalsRequest,
  ListCompanySignalsResponse,
  CompanySignal,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { fetchJson } from '../../../_shared/fetch-json';

interface HNAlgoliaSignalHit {
  title?: string;
  url?: string;
  objectID?: string;
  created_at?: string;
  points?: number;
  num_comments?: number;
  comment_text?: string;
  story_id?: number;
}

interface HNAlgoliaSignalResponse {
  hits: HNAlgoliaSignalHit[];
}

interface GitHubSignalRepo {
  full_name?: string;
  description?: string | null;
  html_url?: string;
  created_at?: string;
  stargazers_count?: number;
  forks_count?: number;
}

const SIGNAL_KEYWORDS: Record<string, string[]> = {
  hiring_surge: ['hiring', "we're hiring", 'join our team', 'open positions', 'new roles', 'growing team'],
  funding_event: ['raised', 'funding', 'series', 'investment', 'valuation', 'backed by'],
  expansion_signal: ['expansion', 'new office', 'opening', 'entering market', 'new region', 'international'],
  technology_adoption: ['migrating to', 'adopting', 'implementing', 'rolling out', 'tech stack', 'infrastructure'],
  executive_movement: ['appointed', 'joins as', 'new ceo', 'new cto', 'new vp', 'leadership change', 'promoted to'],
  financial_trigger: ['revenue', 'ipo', 'acquisition', 'merger', 'quarterly results', 'earnings'],
};

function classifySignal(text: string): string {
  const lower = text.toLowerCase();
  for (const [type, keywords] of Object.entries(SIGNAL_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return type;
    }
  }
  return 'press_release';
}

function scoreSignalStrength(points: number, comments: number, recencyDays: number): string {
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

function toEventTimeMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function slugFromDomain(domain: string): string {
  return domain.replace(/\.(com|io|co|org|net|ai|dev|app)$/, '').split('.').pop() || domain;
}

async function fetchHNSignals(companyName: string): Promise<CompanySignal[]> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
  const data = await fetchJson<HNAlgoliaSignalResponse>(
    `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(companyName)}&tags=story&hitsPerPage=20&numericFilters=created_at_i>${thirtyDaysAgo}`,
  );
  if (!data?.hits) return [];

  const now = Date.now();
  return data.hits.map((h) => {
    const ts = toEventTimeMs(h.created_at);
    const recencyDays = (now - ts) / 86400000;
    return {
      type: classifySignal(h.title || ''),
      title: h.title || '',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID || ''}`,
      source: 'Hacker News',
      sourceTier: 2,
      timestampMs: ts,
      strength: scoreSignalStrength(h.points || 0, h.num_comments || 0, recencyDays),
      engagement: {
        points: h.points || 0,
        comments: h.num_comments || 0,
        stars: 0,
        forks: 0,
        mentions: 0,
      },
    };
  });
}

async function fetchGitHubSignals(orgName: string): Promise<CompanySignal[]> {
  const repos = await fetchJson<GitHubSignalRepo[]>(`https://api.github.com/orgs/${encodeURIComponent(orgName)}/repos?sort=created&per_page=10`);
  if (!Array.isArray(repos)) return [];

  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 86400000;

  return repos
    .filter((r) => toEventTimeMs(r.created_at) > thirtyDaysAgo)
    .map((r) => ({
      type: 'technology_adoption',
      title: `New repository: ${r.full_name || 'unknown'} - ${r.description || 'No description'}`,
      url: r.html_url || '',
      source: 'GitHub',
      sourceTier: 2,
      timestampMs: toEventTimeMs(r.created_at),
      strength: (r.stargazers_count || 0) > 50 ? 'high' : (r.stargazers_count || 0) > 10 ? 'medium' : 'low',
      engagement: {
        points: 0,
        comments: 0,
        stars: r.stargazers_count || 0,
        forks: r.forks_count || 0,
        mentions: 0,
      },
    }));
}

async function fetchJobSignals(companyName: string): Promise<CompanySignal[]> {
  const sixtyDaysAgo = Math.floor(Date.now() / 1000) - 60 * 86400;
  const data = await fetchJson<HNAlgoliaSignalResponse>(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(companyName)}&tags=comment,ask_hn&hitsPerPage=10&numericFilters=created_at_i>${sixtyDaysAgo}`,
  );
  if (!data?.hits) return [];

  const hiringComments = data.hits.filter((h) => {
    const text = (h.comment_text || '').toLowerCase();
    return text.includes('hiring') || text.includes('job') || text.includes('apply');
  });

  if (hiringComments.length === 0) return [];
  const firstComment = hiringComments[0];
  if (!firstComment) return [];

  return [{
    type: 'hiring_surge',
    title: `${companyName} hiring activity (${hiringComments.length} mentions in HN hiring threads)`,
    url: `https://news.ycombinator.com/item?id=${firstComment.story_id || ''}`,
    source: 'HN Hiring Threads',
    sourceTier: 3,
    timestampMs: toEventTimeMs(firstComment.created_at),
    strength: hiringComments.length >= 3 ? 'high' : 'medium',
    engagement: {
      points: 0,
      comments: 0,
      stars: 0,
      forks: 0,
      mentions: hiringComments.length,
    },
  }];
}

export async function listCompanySignals(
  _ctx: ServerContext,
  req: ListCompanySignalsRequest,
): Promise<ListCompanySignalsResponse> {
  const company = req.company?.trim();
  const domain = req.domain?.trim().toLowerCase();

  if (!company) {
    throw new ValidationError([{ field: 'company', description: 'company is required' }]);
  }

  const orgName = domain ? slugFromDomain(domain) : company.toLowerCase().replace(/\s+/g, '');

  const [hnSignals, githubSignals, jobSignals] = await Promise.all([
    fetchHNSignals(company),
    fetchGitHubSignals(orgName),
    fetchJobSignals(company),
  ]);

  const allSignals = [...hnSignals, ...githubSignals, ...jobSignals]
    .sort((a, b) => b.timestampMs - a.timestampMs);

  const signalTypeCounts: Record<string, number> = {};
  for (const s of allSignals) {
    signalTypeCounts[s.type] = (signalTypeCounts[s.type] || 0) + 1;
  }

  return {
    company,
    domain: domain || '',
    signals: allSignals,
    summary: {
      totalSignals: allSignals.length,
      byType: signalTypeCounts,
      strongestSignal: allSignals[0] || undefined,
      signalDiversity: Object.keys(signalTypeCounts).length,
    },
    discoveredAtMs: Date.now(),
  };
}
