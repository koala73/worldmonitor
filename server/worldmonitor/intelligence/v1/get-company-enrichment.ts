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

import { CHROME_UA } from '../../../_shared/constants';

/**
 * Fetch JSON from a URL with a configurable timeout.
 * Rejects on non-2xx status.
 */
async function fetchJSON(url: string, timeout = 8000): Promise<any> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': CHROME_UA,
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

function getDateMonthsAgo(months: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().split('T')[0];
}

function getTodayISO() {
  return new Date().toISOString().split('T')[0];
}

function inferFromDomain(domain: string) {
  const name = domain.replace(/\.(com|io|co|org|net|ai|dev|app)$/, '')
    .split('.')
    .pop()
    ?.replace(/-/g, ' ')
    ?.replace(/\b\w/g, (c) => c.toUpperCase()) || domain;

  return { inferredName: name, domain };
}

async function fetchGitHubOrg(name: string) {
  const data = await fetchJSON(`https://api.github.com/orgs/${encodeURIComponent(name)}`);
  if (!data) return null;
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
}

async function fetchGitHubTechStack(orgName: string) {
  const repos = await fetchJSON(`https://api.github.com/orgs/${encodeURIComponent(orgName)}/repos?sort=stars&per_page=10`);
  if (!Array.isArray(repos)) return [];

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
}

async function fetchSECData(companyName: string) {
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(companyName)}&dateRange=custom&startdt=${getDateMonthsAgo(6)}&enddt=${getTodayISO()}&forms=10-K,10-Q,8-K&from=0&size=5`;
  const data = await fetchJSON(url, 12000);
  if (!data?.hits?.hits) return null;

  return {
    totalFilings: data.hits.total?.value || 0,
    recentFilings: data.hits.hits.slice(0, 5).map((h: any) => ({
      form: h._source?.form_type || h._source?.file_type,
      date: h._source?.file_date || h._source?.period_of_report,
      description: h._source?.display_names?.[0] || companyName,
    })),
  };
}

async function fetchHackerNewsMentions(companyName: string) {
  const data = await fetchJSON(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(companyName)}&tags=story&hitsPerPage=5`);
  if (!data?.hits) return [];

  return data.hits.map((h: any) => ({
    title: h.title,
    url: h.url,
    points: h.points,
    comments: h.num_comments,
    date: h.created_at,
  }));
}

export async function getCompanyEnrichment(
  _ctx: ServerContext,
  req: GetCompanyEnrichmentRequest,
): Promise<GetCompanyEnrichmentResponse> {
  const domain = req.domain?.trim().toLowerCase();
  const name = req.name?.trim();

  if (!domain && !name) {
    throw new Error('Provide domain or name parameter');
  }

  const companyName = name || (domain ? inferFromDomain(domain).inferredName : 'Unknown');
  const searchName = companyName.toLowerCase().replace(/\s+/g, '');

  const [githubOrg, techStack, secData, hnMentions] = await Promise.all([
    fetchGitHubOrg(searchName),
    fetchGitHubTechStack(searchName),
    fetchSECData(companyName),
    fetchHackerNewsMentions(companyName),
  ]);

  return {
    company: {
      name: githubOrg?.name || companyName,
      domain: domain || githubOrg?.blog?.replace(/^https?:\/\//, '').replace(/\/$/, '') || "",
      description: githubOrg?.description || "",
      location: githubOrg?.location || "",
      website: githubOrg?.blog || (domain ? `https://${domain}` : ""),
      founded: githubOrg?.createdAt ? new Date(githubOrg.createdAt).getFullYear() : 0,
    },
    github: githubOrg ? {
      publicRepos: githubOrg.publicRepos,
      followers: githubOrg.followers,
      avatarUrl: githubOrg.avatarUrl,
    } : undefined,
    techStack: techStack.length > 0 ? techStack : [],
    secFilings: secData || undefined,
    hackerNewsMentions: hnMentions.length > 0 ? hnMentions : [],
    enrichedAt: new Date().toISOString(),
    sources: [
      githubOrg ? 'github' : null,
      techStack.length > 0 ? 'github_repos' : null,
      secData ? 'sec_edgar' : null,
      hnMentions.length > 0 ? 'hacker_news' : null,
    ].filter((s): s is string => s !== null),
  };
}
