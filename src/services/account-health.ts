/**
 * Account Signal Health Score for SalesIntel
 *
 * Repurposes the Country Instability Index (CII) scoring architecture
 * into an Account Signal Health Score that measures how "hot" a target
 * account is based on ICP fit, activity velocity, buying intent signals,
 * and engagement readiness.
 *
 * Score 0-100 with levels: cold | warming | warm | hot | on_fire
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AccountHealthComponents {
  /** ICP match: company size, industry, tech stack, geography (weight: 30%) */
  accountFit: number;
  /** Rate of new signals in last 30 days vs. baseline (weight: 25%) */
  activityVelocity: number;
  /** Weighted count of high-intent signals (weight: 30%) */
  buyingIntentSignals: number;
  /** Recency of C-level activity, response likelihood (weight: 15%) */
  engagementReadiness: number;
}

export type AccountHealthLevel = 'cold' | 'warming' | 'warm' | 'hot' | 'on_fire';
export type AccountHealthTrend = 'rising' | 'stable' | 'falling';

export interface AccountHealthScore {
  company: string;
  companyDomain?: string;
  score: number;
  level: AccountHealthLevel;
  trend: AccountHealthTrend;
  change7d: number;
  components: AccountHealthComponents;
  lastUpdated: Date;
}

export interface IdealCustomerProfile {
  targetIndustries: string[];
  targetCompanySize: { min: number; max: number };
  targetRegions: string[];
  targetTechStack: string[];
  targetRevenue?: { min: number; max: number };
  targetFundingStages: string[];
}

export type SignalStrength = 'critical' | 'high' | 'medium' | 'low';

export interface AccountSignal {
  id: string;
  type: string;
  strength: SignalStrength;
  timestamp: Date;
  source?: string;
  /** Whether this signal involves a C-level or VP-level contact */
  isCLevelActivity?: boolean;
  /** Whether this represents a public touchpoint (webinar, conference, etc.) */
  isPublicTouchpoint?: boolean;
}

export interface CompanyInfo {
  name: string;
  domain?: string;
  industry: string;
  employeeCount: number;
  region: string;
  techStack: string[];
  revenue?: number;
  fundingStage?: string;
}

// ---------------------------------------------------------------------------
// Signal strength weights (mirrors CII severity multipliers)
// ---------------------------------------------------------------------------

const SIGNAL_STRENGTH_WEIGHTS: Record<SignalStrength, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// ---------------------------------------------------------------------------
// Component weights (mirrors CII blended score architecture)
// ---------------------------------------------------------------------------

const COMPONENT_WEIGHTS = {
  accountFit: 0.30,
  activityVelocity: 0.25,
  buyingIntentSignals: 0.30,
  engagementReadiness: 0.15,
} as const;

// ---------------------------------------------------------------------------
// Previous scores map for trend detection (mirrors CII previousScores)
// ---------------------------------------------------------------------------

const previousScores = new Map<string, number>();

// ---------------------------------------------------------------------------
// Component scoring functions
// ---------------------------------------------------------------------------

/**
 * Calculate how well a company matches the Ideal Customer Profile.
 * Mirrors CII's baseline risk approach — a static "fit" foundation.
 */
function calcAccountFit(company: CompanyInfo, icp: IdealCustomerProfile): number {
  let score = 0;
  let totalWeight = 0;

  // Industry match (30 points)
  totalWeight += 30;
  if (icp.targetIndustries.length > 0) {
    const industryLower = company.industry.toLowerCase();
    const matched = icp.targetIndustries.some(
      ind => industryLower.includes(ind.toLowerCase()) || ind.toLowerCase().includes(industryLower),
    );
    if (matched) score += 30;
  }

  // Company size match (25 points)
  totalWeight += 25;
  if (company.employeeCount >= icp.targetCompanySize.min && company.employeeCount <= icp.targetCompanySize.max) {
    score += 25;
  } else {
    // Partial credit for being close
    const midpoint = (icp.targetCompanySize.min + icp.targetCompanySize.max) / 2;
    const range = icp.targetCompanySize.max - icp.targetCompanySize.min;
    if (range > 0) {
      const distance = Math.abs(company.employeeCount - midpoint);
      const proximity = Math.max(0, 1 - distance / range);
      score += Math.round(25 * proximity * 0.5);
    }
  }

  // Region match (20 points)
  totalWeight += 20;
  if (icp.targetRegions.length > 0) {
    const regionLower = company.region.toLowerCase();
    const matched = icp.targetRegions.some(
      r => regionLower.includes(r.toLowerCase()) || r.toLowerCase().includes(regionLower),
    );
    if (matched) score += 20;
  }

  // Tech stack overlap (15 points)
  totalWeight += 15;
  if (icp.targetTechStack.length > 0 && company.techStack.length > 0) {
    const companyTechLower = new Set(company.techStack.map(t => t.toLowerCase()));
    const matchCount = icp.targetTechStack.filter(t => companyTechLower.has(t.toLowerCase())).length;
    const overlapRatio = matchCount / icp.targetTechStack.length;
    score += Math.round(15 * overlapRatio);
  }

  // Revenue match (5 points, optional)
  totalWeight += 5;
  if (icp.targetRevenue && company.revenue !== undefined) {
    if (company.revenue >= icp.targetRevenue.min && company.revenue <= icp.targetRevenue.max) {
      score += 5;
    }
  }

  // Funding stage match (5 points)
  totalWeight += 5;
  if (icp.targetFundingStages.length > 0 && company.fundingStage) {
    const stageLower = company.fundingStage.toLowerCase();
    const matched = icp.targetFundingStages.some(s => s.toLowerCase() === stageLower);
    if (matched) score += 5;
  }

  // Normalize to 0-100
  return Math.round(Math.min(100, (score / totalWeight) * 100));
}

/**
 * Calculate the velocity of signal activity over the last 30 days.
 * Mirrors CII's event multiplier and velocity scoring — higher
 * acceleration gets a bonus, similar to CII's news velocity boost.
 */
function calcActivityVelocity(signals: AccountSignal[]): number {
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;

  const cutoff30d = now - THIRTY_DAYS_MS;
  const cutoff15d = now - FIFTEEN_DAYS_MS;

  const signals30d = signals.filter(s => s.timestamp.getTime() >= cutoff30d);
  const signalsRecent15d = signals30d.filter(s => s.timestamp.getTime() >= cutoff15d);
  const signalsOlder15d = signals30d.filter(s => s.timestamp.getTime() < cutoff15d);

  if (signals30d.length === 0) return 0;

  // Base velocity: count of signals in 30d, normalized
  // 20+ signals in 30d = max base score of 70
  const baseVelocity = Math.min(70, (signals30d.length / 20) * 70);

  // Acceleration bonus: if recent 15d has more signals than older 15d
  let accelerationBonus = 0;
  if (signalsOlder15d.length > 0) {
    const ratio = signalsRecent15d.length / signalsOlder15d.length;
    if (ratio > 1.5) {
      accelerationBonus = Math.min(30, (ratio - 1) * 15);
    }
  } else if (signalsRecent15d.length > 0) {
    // All signals are recent — strong acceleration signal
    accelerationBonus = 20;
  }

  return Math.round(Math.min(100, baseVelocity + accelerationBonus));
}

/**
 * Calculate buying intent from weighted signal strength.
 * Mirrors CII's conflict score with severity-based multipliers
 * (critical=4, high=3, medium=2, low=1).
 */
function calcBuyingIntentSignals(signals: AccountSignal[]): number {
  if (signals.length === 0) return 0;

  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const cutoff = now - THIRTY_DAYS_MS;

  const recentSignals = signals.filter(s => s.timestamp.getTime() >= cutoff);
  if (recentSignals.length === 0) return 0;

  // Weighted sum of signal strengths
  const weightedSum = recentSignals.reduce((sum, s) => {
    return sum + SIGNAL_STRENGTH_WEIGHTS[s.strength];
  }, 0);

  // Normalize: a weighted sum of 40+ maps to 100
  // This means ~10 critical signals or ~20 medium signals saturate the score
  const normalized = Math.min(100, (weightedSum / 40) * 100);

  // Bonus for having critical signals (like CII's strike boost)
  const criticalCount = recentSignals.filter(s => s.strength === 'critical').length;
  const criticalBonus = Math.min(15, criticalCount * 5);

  return Math.round(Math.min(100, normalized + criticalBonus));
}

/**
 * Calculate engagement readiness based on C-level activity recency
 * and number of public touchpoints.
 * Mirrors CII's security score approach — recent high-value events
 * raise the score significantly.
 */
function calcEngagementReadiness(signals: AccountSignal[]): number {
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // C-level activity recency (up to 60 points)
  const cLevelSignals = signals.filter(s => s.isCLevelActivity);
  let cLevelRecencyScore = 0;

  if (cLevelSignals.length > 0) {
    const mostRecent = Math.max(...cLevelSignals.map(s => s.timestamp.getTime()));
    const ageMs = now - mostRecent;

    if (ageMs <= SEVEN_DAYS_MS) {
      cLevelRecencyScore = 60;
    } else if (ageMs <= FOURTEEN_DAYS_MS) {
      cLevelRecencyScore = 45;
    } else if (ageMs <= THIRTY_DAYS_MS) {
      cLevelRecencyScore = 25;
    } else {
      cLevelRecencyScore = 10;
    }
  }

  // Public touchpoints (up to 40 points)
  const touchpoints = signals.filter(s => s.isPublicTouchpoint);
  const recentTouchpoints = touchpoints.filter(
    s => (now - s.timestamp.getTime()) <= THIRTY_DAYS_MS,
  );
  const touchpointScore = Math.min(40, recentTouchpoints.length * 10);

  return Math.round(Math.min(100, cLevelRecencyScore + touchpointScore));
}

// ---------------------------------------------------------------------------
// Level and trend helpers (mirrors CII getLevel / getTrend)
// ---------------------------------------------------------------------------

/**
 * Determine account health level from score.
 * Thresholds: on_fire >= 85, hot >= 70, warm >= 50, warming >= 30, cold < 30
 */
export function getAccountHealthLevel(score: number): AccountHealthLevel {
  if (score >= 85) return 'on_fire';
  if (score >= 70) return 'hot';
  if (score >= 50) return 'warm';
  if (score >= 30) return 'warming';
  return 'cold';
}

/**
 * Get a CSS color string for the given health level.
 */
export function getAccountHealthColor(level: AccountHealthLevel): string {
  switch (level) {
    case 'on_fire': return '#ef4444';
    case 'hot': return '#f97316';
    case 'warm': return '#eab308';
    case 'warming': return '#3b82f6';
    case 'cold': return '#6b7280';
  }
}

/**
 * Determine trend by comparing current score to the stored 7-day-ago score.
 * Mirrors CII's getTrend with a +/- 5 point threshold.
 */
function getAccountTrend(key: string, currentScore: number): AccountHealthTrend {
  const prev = previousScores.get(key);
  if (prev === undefined) return 'stable';
  const diff = currentScore - prev;
  if (diff >= 5) return 'rising';
  if (diff <= -5) return 'falling';
  return 'stable';
}

// ---------------------------------------------------------------------------
// Main computation (mirrors CII's calculateCII)
// ---------------------------------------------------------------------------

/**
 * Compute the Account Signal Health Score for a given company.
 *
 * Architecture mirrors the CII blended score:
 *   - Component scores are calculated independently (0-100 each)
 *   - Weighted average produces the final score
 *   - Level thresholds and trend detection applied
 *   - Previous scores stored for 7-day trend comparison
 */
export function computeAccountHealth(
  company: CompanyInfo,
  signals: AccountSignal[],
  icp: IdealCustomerProfile,
): AccountHealthScore {
  const components: AccountHealthComponents = {
    accountFit: calcAccountFit(company, icp),
    activityVelocity: calcActivityVelocity(signals),
    buyingIntentSignals: calcBuyingIntentSignals(signals),
    engagementReadiness: calcEngagementReadiness(signals),
  };

  // Weighted average (mirrors CII blended score calculation)
  const rawScore =
    COMPONENT_WEIGHTS.accountFit * components.accountFit +
    COMPONENT_WEIGHTS.activityVelocity * components.activityVelocity +
    COMPONENT_WEIGHTS.buyingIntentSignals * components.buyingIntentSignals +
    COMPONENT_WEIGHTS.engagementReadiness * components.engagementReadiness;

  const score = Math.round(Math.min(100, Math.max(0, rawScore)));

  // Use company name + domain as the unique key for trend tracking
  const key = company.domain ? `${company.name}::${company.domain}` : company.name;

  const prev = previousScores.get(key) ?? score;
  const change7d = score - prev;
  const trend = getAccountTrend(key, score);
  const level = getAccountHealthLevel(score);

  // Store current score for future trend comparison
  previousScores.set(key, score);

  return {
    company: company.name,
    companyDomain: company.domain,
    score,
    level,
    trend,
    change7d,
    components,
    lastUpdated: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Default ICP configuration
// ---------------------------------------------------------------------------

export const DEFAULT_ICP: IdealCustomerProfile = {
  targetIndustries: ['SaaS', 'Technology', 'Software', 'Cloud', 'Fintech', 'Cybersecurity'],
  targetCompanySize: { min: 50, max: 5000 },
  targetRegions: ['North America', 'Europe', 'United Kingdom', 'DACH', 'Nordics'],
  targetTechStack: ['React', 'TypeScript', 'Node.js', 'AWS', 'Kubernetes', 'PostgreSQL'],
  targetRevenue: { min: 5_000_000, max: 500_000_000 },
  targetFundingStages: ['Series A', 'Series B', 'Series C', 'Growth', 'Public'],
};

// ---------------------------------------------------------------------------
// Utility exports
// ---------------------------------------------------------------------------

/**
 * Clear all stored previous scores (useful for testing / reset).
 */
export function clearPreviousScores(): void {
  previousScores.clear();
}

/**
 * Get the stored previous scores map (useful for debugging).
 */
export function getPreviousScores(): Map<string, number> {
  return previousScores;
}
