/**
 * Company Profile Service — Unified company intelligence profile
 * Aggregates firmographics, tech stack, org chart, signal history,
 * account health score, and recommended approach.
 */

import type { CompanySignal } from './signal-aggregator';
import { computeAccountHealth, DEFAULT_ICP, type AccountHealthScore, type CompanyInfo } from './account-health';

export interface Firmographics {
  name: string;
  domain?: string;
  industry: string;
  subIndustry?: string;
  employeeCount?: number;
  employeeRange: string;
  revenue?: number;
  revenueRange?: string;
  fundingStage?: string;
  totalFunding?: number;
  founded?: number;
  headquarters: string;
  website?: string;
  description?: string;
}

export interface TechStackItem {
  name: string;
  category: string; // e.g., 'CRM', 'Cloud', 'Analytics', 'DevOps'
  firstDetected?: Date;
  confidence: number; // 0-1
}

export interface OrgChartMember {
  name: string;
  title: string;
  email?: string;
  linkedin?: string;
  photoUrl?: string;
  budgetAuthority: boolean;
  recentActivity?: string;
  lastActiveDate?: Date;
}

export interface CompanyProfile {
  firmographics: Firmographics;
  techStack: TechStackItem[];
  orgChart: OrgChartMember[];
  signalHistory: CompanySignal[];
  accountHealth: AccountHealthScore | null;
  recommendedApproach?: string;
  lastEnriched: Date;
  sources: string[];
}

// In-memory company profile cache
const profileCache = new Map<string, CompanyProfile>();

/**
 * Get or create a company profile
 */
export function getCompanyProfile(companyName: string): CompanyProfile | null {
  const key = companyName.toLowerCase().trim();
  return profileCache.get(key) ?? null;
}

/**
 * Update a company profile with new data
 */
export function updateCompanyProfile(
  companyName: string,
  update: Partial<CompanyProfile>,
): CompanyProfile {
  const key = companyName.toLowerCase().trim();
  const existing = profileCache.get(key);

  const profile: CompanyProfile = {
    firmographics: update.firmographics ?? existing?.firmographics ?? {
      name: companyName,
      industry: 'Unknown',
      employeeRange: 'Unknown',
      headquarters: 'Unknown',
    },
    techStack: update.techStack ?? existing?.techStack ?? [],
    orgChart: update.orgChart ?? existing?.orgChart ?? [],
    signalHistory: update.signalHistory ?? existing?.signalHistory ?? [],
    accountHealth: existing?.accountHealth ?? null,
    recommendedApproach: update.recommendedApproach ?? existing?.recommendedApproach,
    lastEnriched: new Date(),
    sources: update.sources ?? existing?.sources ?? [],
  };

  profileCache.set(key, profile);
  return profile;
}

/**
 * Add signals to a company profile and recalculate health
 */
export function addSignalsToProfile(
  companyName: string,
  newSignals: CompanySignal[],
): CompanyProfile {
  const key = companyName.toLowerCase().trim();
  const existing = profileCache.get(key);

  const allSignals = [...(existing?.signalHistory ?? []), ...newSignals];

  // Deduplicate by title + timestamp
  const seen = new Set<string>();
  const deduplicated = allSignals.filter(s => {
    const sigKey = `${s.title}::${s.timestamp.getTime()}`;
    if (seen.has(sigKey)) return false;
    seen.add(sigKey);
    return true;
  });

  const companyInfo: CompanyInfo = {
    name: companyName,
    domain: existing?.firmographics.domain,
    industry: existing?.firmographics.industry ?? 'Unknown',
    employeeCount: existing?.firmographics.employeeCount,
    region: existing?.firmographics.headquarters,
    techStack: existing?.techStack.map(t => t.name),
    revenue: existing?.firmographics.revenue,
    fundingStage: existing?.firmographics.fundingStage,
  };

  const accountHealth = computeAccountHealth(companyInfo, deduplicated.map(s => ({
    type: s.type,
    strength: s.strength,
    timestamp: s.timestamp,
    isCLevel: s.people?.some(p =>
      /^(CEO|CTO|CFO|CIO|COO|CMO|CRO|VP|SVP|EVP)/i.test(p),
    ) ?? false,
  })), DEFAULT_ICP);

  const profile: CompanyProfile = {
    firmographics: existing?.firmographics ?? {
      name: companyName,
      industry: 'Unknown',
      employeeRange: 'Unknown',
      headquarters: 'Unknown',
    },
    techStack: existing?.techStack ?? [],
    orgChart: existing?.orgChart ?? [],
    signalHistory: deduplicated,
    accountHealth,
    recommendedApproach: existing?.recommendedApproach,
    lastEnriched: new Date(),
    sources: existing?.sources ?? [],
  };

  profileCache.set(key, profile);
  return profile;
}

/**
 * List all tracked company profiles
 */
export function listCompanyProfiles(): CompanyProfile[] {
  return Array.from(profileCache.values())
    .sort((a, b) => (b.accountHealth?.score ?? 0) - (a.accountHealth?.score ?? 0));
}

/**
 * Remove a company from tracking
 */
export function removeCompanyProfile(companyName: string): boolean {
  return profileCache.delete(companyName.toLowerCase().trim());
}
