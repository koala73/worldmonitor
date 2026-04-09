/**
 * RPC: getCompanyEnrichment -- Aggregates company data from multiple public sources.
 * Port from api/enrichment/company.js
 * Sources: GitHub, SEC EDGAR, Hacker News
 */

import type {
  ServerContext,
  GetCompanyEnrichmentRequest,
  GetCompanyEnrichmentResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { fetchJson } from '../../../_shared/fetch-json';
import { cachedFetchJson } from '../../../_shared/redis';

interface GitHubOrg {
  name?: string;
  login?: string;
  description?: string;
  blog?: string;
  location?: string;
  public_repos?: number;
  followers?: number;
  avatar_url?: string;
  created_at?: string;
}

interface GitHubRepo {
  language?: string | null;
  stargazers_count?: number;
}

interface SECSearchResponse {
  hits: {
    total?: { value: number };
    hits: Array<{
      _source?: {
        form_type?: string;
        file_type?: string;
        file_date?: string;
        period_of_report?: string;
        display_names?: string[];
      }
    }>;
  };
}

interface HNAlgoliaHit {
  title?: string;
  url?: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
}

interface HNAlgoliaResponse {
  hits: HNAlgoliaHit[];
}

interface GitHubOrgResult {
  name: string;
  description: string;
  blog: string;
  location: string;
  publicRepos: number;
  followers: number;
  avatarUrl: string;
  createdAt: string | undefined;
}

interface TechStackItem {
  name: string;
  category: string;
  confidence: number;
}

interface SECResult {
  totalFilings: number;
  recentFilings: Array<{ form: string; fileDate: string; description: string }>;
}

interface HNMentionItem {
  title: string;
  url: string;
  points: number;
  comments: number;
  createdAtMs: number;
}

function getDateMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().split('T')[0]!;
}

function getTodayISO(): string {
  return new Date().toISOString().split('T')[0]!;
}

function inferFromDomain(domain: string): { inferredName: string; domain: string } {
  const name = domain.replace(/\.(com|io|co|org|net|ai|dev|app)$/, '')
    .split('.')
    .pop()
    ?.replace(/-/g, ' ')
    ?.replace(/\b\w/g, (c) => c.toUpperCase()) || domain;

  return { inferredName: name, domain };
}

function slugFromDomain(domain: string): string {
  return domain.replace(/\.(com|io|co|org|net|ai|dev|app)$/, '').split('.').pop() || domain;
}

function parseIsoMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function fetchGitHubOrg(name: string): Promise<GitHubOrgResult | null> {
  return cachedFetchJson<GitHubOrgResult>(
    `intel:enrichment:gh-org:${encodeURIComponent(name.toLowerCase())}`,
    3600,
    async () => {
      const data = await fetchJson<GitHubOrg>(`https://api.github.com/orgs/${encodeURIComponent(name)}`);
      if (!data) return null;
      return {
        name: data.name || data.login || '',
        description: data.description || '',
        blog: data.blog || '',
        location: data.location || '',
        publicRepos: data.public_repos || 0,
        followers: data.followers || 0,
        avatarUrl: data.avatar_url || '',
        createdAt: data.created_at,
      };
    },
  );
}

async function fetchGitHubTechStack(orgName: string): Promise<TechStackItem[] | null> {
  return cachedFetchJson<TechStackItem[]>(
    `intel:enrichment:gh-tech:${encodeURIComponent(orgName.toLowerCase())}`,
    3600,
    async () => {
      const repos = await fetchJson<GitHubRepo[]>(`https://api.github.com/orgs/${encodeURIComponent(orgName)}/repos?sort=stars&per_page=10`);
      if (!Array.isArray(repos)) return null;

      const languages = new Map<string, number>();
      for (const repo of repos) {
        if (repo.language) {
          languages.set(repo.language, (languages.get(repo.language) || 0) + (repo.stargazers_count || 0) + 1);
        }
      }

      return Array.from(languages.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([lang, score]) => ({
          name: lang,
          category: 'Programming Language',
          confidence: Math.min(1, score / 100),
        }));
    },
  );
}

async function fetchSECData(companyName: string): Promise<SECResult | null> {
  return cachedFetchJson<SECResult>(
    `intel:enrichment:sec:${encodeURIComponent(companyName.toLowerCase())}:${getTodayISO()}`,
    3600,
    async () => {
      const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(companyName)}&dateRange=custom&startdt=${getDateMonthsAgo(6)}&enddt=${getTodayISO()}&forms=10-K,10-Q,8-K&from=0&size=5`;
      const data = await fetchJson<SECSearchResponse>(url, { timeoutMs: 12_000 });
      if (!data?.hits?.hits) return null;

      return {
        totalFilings: data.hits.total?.value || 0,
        recentFilings: data.hits.hits.slice(0, 5).map((h) => ({
          form: h._source?.form_type || h._source?.file_type || 'Unknown',
          fileDate: h._source?.file_date || h._source?.period_of_report || '',
          description: h._source?.display_names?.[0] || companyName,
        })),
      };
    },
  );
}

async function fetchHackerNewsMentions(companyName: string): Promise<HNMentionItem[] | null> {
  return cachedFetchJson<HNMentionItem[]>(
    `intel:enrichment:hn:${encodeURIComponent(companyName.toLowerCase())}`,
    1800,
    async () => {
      const data = await fetchJson<HNAlgoliaResponse>(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(companyName)}&tags=story&hitsPerPage=5`);
      if (data === null || !data.hits) return null;

      return data.hits.map((h) => ({
        title: h.title || '',
        url: h.url || '',
        points: h.points || 0,
        comments: h.num_comments || 0,
        createdAtMs: parseIsoMs(h.created_at),
      }));
    },
  );
}

export async function getCompanyEnrichment(
  _ctx: ServerContext,
  req: GetCompanyEnrichmentRequest,
): Promise<GetCompanyEnrichmentResponse> {
  const domain = req.domain?.trim().toLowerCase();
  const name = req.name?.trim();

  if (!domain && !name) {
    throw new ValidationError([{ field: 'domain', description: 'Provide domain or name' }]);
  }

  const companyName = name || (domain ? inferFromDomain(domain).inferredName : 'Unknown');
  const searchName = domain ? slugFromDomain(domain) : companyName.toLowerCase().replace(/\s+/g, '');

  const [githubOrg, techStack, secData, hnMentions] = await Promise.all([
    fetchGitHubOrg(searchName),
    fetchGitHubTechStack(searchName),
    fetchSECData(companyName),
    fetchHackerNewsMentions(companyName),
  ]);

  const techStackItems = techStack ?? [];
  const hnMentionItems = hnMentions ?? [];

  return {
    company: {
      name: githubOrg?.name || companyName,
      domain: domain || githubOrg?.blog?.replace(/^https?:\/\//, '').replace(/\/$/, '') || '',
      description: githubOrg?.description || '',
      location: githubOrg?.location || '',
      website: githubOrg?.blog || (domain ? `https://${domain}` : ''),
      founded: githubOrg?.createdAt ? new Date(githubOrg.createdAt).getFullYear() : 0,
    },
    github: githubOrg ? {
      publicRepos: githubOrg.publicRepos,
      followers: githubOrg.followers,
      avatarUrl: githubOrg.avatarUrl,
    } : undefined,
    techStack: techStackItems,
    secFilings: secData || undefined,
    hackerNewsMentions: hnMentionItems,
    enrichedAtMs: Date.now(),
    sources: [
      githubOrg ? 'github' : null,
      techStackItems.length > 0 ? 'github_repos' : null,
      secData ? 'sec_edgar' : null,
      hnMentionItems.length > 0 ? 'hacker_news' : null,
    ].filter((s): s is string => s !== null),
  };
}
