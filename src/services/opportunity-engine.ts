/**
 * Opportunity Engine — The "Why Now" Engine
 * Takes all signals for a company and synthesizes into a narrative.
 * Outputs: timing score, recommended approach, key talking points,
 * objection predictions.
 */

import type { CompanySignal } from './signal-aggregator';
import type { AccountHealthScore } from './account-health';

export interface OpportunityAssessment {
  company: string;
  companyDomain?: string;

  // Timing
  timingScore: number; // 0-100
  timingLabel: 'Perfect timing' | 'Good timing' | 'Developing' | 'Too early' | 'Monitor';

  // Recommended approach
  recommendedApproach: string;
  approachType: 'direct_outreach' | 'warm_intro' | 'event_trigger' | 'nurture' | 'wait';

  // Key talking points (ordered by impact)
  talkingPoints: TalkingPoint[];

  // Objection predictions
  predictedObjections: Objection[];

  // Signal summary
  signalSummary: string;
  topSignals: CompanySignal[];
  convergenceCount: number;

  // Metadata
  generatedAt: Date;
  confidence: number; // 0-1
}

export interface TalkingPoint {
  point: string;
  evidence: string;
  signal: string; // Signal type that supports this point
  strength: 'strong' | 'moderate' | 'suggestive';
}

export interface Objection {
  objection: string;
  likelihood: 'high' | 'medium' | 'low';
  counterArgument: string;
}

/**
 * Assess opportunity timing based on signal convergence
 */
function assessTiming(signals: CompanySignal[], health: AccountHealthScore | null): {
  score: number;
  label: OpportunityAssessment['timingLabel'];
} {
  if (signals.length === 0) return { score: 0, label: 'Monitor' };

  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  // Recent signals carry more weight
  const recentSignals = signals.filter(s => now - s.timestamp.getTime() < sevenDaysMs);
  const monthSignals = signals.filter(s => now - s.timestamp.getTime() < thirtyDaysMs);

  // Signal type diversity in last 30 days
  const signalTypes = new Set(monthSignals.map(s => s.type));
  const typeCount = signalTypes.size;

  // Calculate timing score components
  const recencyScore = Math.min(30, recentSignals.length * 10);
  const volumeScore = Math.min(25, monthSignals.length * 5);
  const diversityScore = Math.min(25, typeCount * 8);
  const healthBonus = health ? Math.min(20, health.score * 0.2) : 0;

  const score = Math.min(100, Math.round(recencyScore + volumeScore + diversityScore + healthBonus));

  let label: OpportunityAssessment['timingLabel'];
  if (score >= 80) label = 'Perfect timing';
  else if (score >= 60) label = 'Good timing';
  else if (score >= 40) label = 'Developing';
  else if (score >= 20) label = 'Too early';
  else label = 'Monitor';

  return { score, label };
}

/**
 * Generate talking points from signals
 */
function generateTalkingPoints(signals: CompanySignal[]): TalkingPoint[] {
  const points: TalkingPoint[] = [];

  // Group signals by type
  const byType = new Map<string, CompanySignal[]>();
  for (const s of signals) {
    const group = byType.get(s.type) ?? [];
    group.push(s);
    byType.set(s.type, group);
  }

  if (byType.has('funding_event')) {
    const funding = byType.get('funding_event')!;
    const latest = funding[0];
    points.push({
      point: 'Recent funding creates budget for new initiatives',
      evidence: latest.title,
      signal: 'funding_event',
      strength: 'strong',
    });
  }

  if (byType.has('hiring_surge')) {
    points.push({
      point: 'Hiring surge indicates growth and new team needs',
      evidence: byType.get('hiring_surge')![0].title,
      signal: 'hiring_surge',
      strength: 'strong',
    });
  }

  if (byType.has('technology_adoption')) {
    points.push({
      point: 'Technology changes create evaluation windows',
      evidence: byType.get('technology_adoption')![0].title,
      signal: 'technology_adoption',
      strength: 'moderate',
    });
  }

  if (byType.has('executive_movement')) {
    points.push({
      point: 'New leadership brings fresh priorities and vendor reviews',
      evidence: byType.get('executive_movement')![0].title,
      signal: 'executive_movement',
      strength: 'strong',
    });
  }

  if (byType.has('expansion_signal')) {
    points.push({
      point: 'Expansion requires scaling tools and processes',
      evidence: byType.get('expansion_signal')![0].title,
      signal: 'expansion_signal',
      strength: 'moderate',
    });
  }

  return points;
}

/**
 * Predict likely objections based on signals
 */
function predictObjections(signals: CompanySignal[]): Objection[] {
  const objections: Objection[] = [];
  const signalTypes = new Set(signals.map(s => s.type));

  if (signalTypes.has('financial_trigger')) {
    const hasNegative = signals.some(s =>
      s.type === 'financial_trigger' &&
      (s.title.toLowerCase().includes('cut') || s.title.toLowerCase().includes('layoff')),
    );
    if (hasNegative) {
      objections.push({
        objection: 'Budget constraints due to cost-cutting',
        likelihood: 'high',
        counterArgument: 'Position your solution as a cost-reduction tool. Emphasize ROI and efficiency gains.',
      });
    }
  }

  // Default objections
  objections.push({
    objection: 'Existing vendor relationship',
    likelihood: 'medium',
    counterArgument: 'Focus on differentiation and the specific pain points their current solution misses.',
  });

  objections.push({
    objection: 'Timing — not a priority right now',
    likelihood: 'low',
    counterArgument: 'Reference specific signals showing this IS a priority. Use their own hiring/spending data as evidence.',
  });

  return objections;
}

/**
 * Determine recommended approach type
 */
function determineApproach(
  timingScore: number,
  signals: CompanySignal[],
): { type: OpportunityAssessment['approachType']; description: string } {
  const hasExecutiveSignal = signals.some(s => s.type === 'executive_movement' || s.type === 'leadership_activity');
  const hasFunding = signals.some(s => s.type === 'funding_event');

  if (timingScore >= 80 && (hasExecutiveSignal || hasFunding)) {
    return {
      type: 'direct_outreach',
      description: 'Strong signals warrant direct outreach. Reference specific triggers in your message.',
    };
  }

  if (timingScore >= 60) {
    return {
      type: 'event_trigger',
      description: 'Engage through trigger-based outreach. Wait for the next high-impact signal, then reach out.',
    };
  }

  if (timingScore >= 40) {
    return {
      type: 'warm_intro',
      description: 'Seek a warm introduction. Build relationship through shared connections or content engagement.',
    };
  }

  if (timingScore >= 20) {
    return {
      type: 'nurture',
      description: 'Add to nurture sequence. Share relevant content and monitor for stronger signals.',
    };
  }

  return {
    type: 'wait',
    description: 'Continue monitoring. Insufficient signals for meaningful engagement.',
  };
}

/**
 * Generate a full opportunity assessment for a company
 */
export function assessOpportunity(
  company: string,
  signals: CompanySignal[],
  accountHealth: AccountHealthScore | null,
  companyDomain?: string,
): OpportunityAssessment {
  // Sort signals by timestamp (most recent first)
  const sorted = [...signals].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  const { score: timingScore, label: timingLabel } = assessTiming(sorted, accountHealth);
  const { type: approachType, description: recommendedApproach } = determineApproach(timingScore, sorted);
  const talkingPoints = generateTalkingPoints(sorted);
  const predictedObjections = predictObjections(sorted);

  // Signal type convergence count
  const convergenceCount = new Set(sorted.map(s => s.type)).size;

  // Build summary
  const topSignals = sorted.slice(0, 5);
  const signalSummary = topSignals.length > 0
    ? `${company} shows ${convergenceCount} signal types across ${sorted.length} total signals. ${topSignals[0].title}`
    : `No signals detected for ${company}.`;

  return {
    company,
    companyDomain,
    timingScore,
    timingLabel,
    recommendedApproach,
    approachType,
    talkingPoints,
    predictedObjections,
    signalSummary,
    topSignals,
    convergenceCount,
    generatedAt: new Date(),
    confidence: Math.min(1, sorted.length * 0.1),
  };
}
