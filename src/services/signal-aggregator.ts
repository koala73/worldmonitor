/**
 * Signal Aggregator Service — SalesIntel Edition
 * Collects commercial intent signals and correlates them by company.
 * Feeds opportunity context to downstream AI / LLM processing.
 */

export type SignalType =
  | 'executive_movement'
  | 'funding_event'
  | 'expansion_signal'
  | 'technology_adoption'
  | 'hiring_surge'
  | 'financial_trigger'
  | 'leadership_activity'
  | 'press_release'
  | 'job_posting'
  | 'tender_rfp';

export interface CompanySignal {
  type: SignalType;
  company: string;
  companyDomain?: string;
  strength: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  summary?: string;
  timestamp: Date;
  source: string;
  sourceTier: number; // 1-4 (1 = highest quality)
  signalScore: number; // 0-100
  people?: string[];
  fundingAmount?: string;
  jobTitle?: string;
}

export interface CompanySignalCluster {
  company: string;
  companyDomain?: string;
  signals: CompanySignal[];
  signalTypes: Set<SignalType>;
  totalCount: number;
  highStrengthCount: number;
  convergenceScore: number; // 0-100
  accountHealthScore?: number;
}

export interface OpportunityConvergence {
  company: string;
  signalTypes: SignalType[];
  totalSignals: number;
  description: string;
  urgency: 'immediate' | 'this_week' | 'this_month' | 'monitor';
  recommendedAction: string;
}

export interface SignalSummary {
  timestamp: Date;
  totalSignals: number;
  byType: Record<SignalType, number>;
  convergenceAlerts: OpportunityConvergence[];
  topCompanies: CompanySignalCluster[];
  aiContext: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  executive_movement: 'executive movement',
  funding_event: 'funding event',
  expansion_signal: 'expansion signal',
  technology_adoption: 'technology adoption',
  hiring_surge: 'hiring surge',
  financial_trigger: 'financial trigger',
  leadership_activity: 'leadership activity',
  press_release: 'press release',
  job_posting: 'job posting',
  tender_rfp: 'tender / RFP',
};

/** How many days old a signal can be before we discard it. */
const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Minimum distinct signal types in the convergence window to fire an alert. */
const CONVERGENCE_TYPE_THRESHOLD = 3;

function normalizeCompanyName(name: string): string {
  return name.trim().toLowerCase();
}

function deriveUrgency(
  convergenceScore: number,
  highCount: number,
): OpportunityConvergence['urgency'] {
  if (convergenceScore >= 80 || highCount >= 4) return 'immediate';
  if (convergenceScore >= 60 || highCount >= 2) return 'this_week';
  if (convergenceScore >= 40) return 'this_month';
  return 'monitor';
}

function deriveRecommendedAction(
  signalTypes: SignalType[],
  urgency: OpportunityConvergence['urgency'],
): string {
  const types = new Set(signalTypes);

  if (types.has('funding_event') && types.has('hiring_surge')) {
    return 'High-growth account — initiate outbound immediately with expansion-focused messaging.';
  }
  if (types.has('tender_rfp')) {
    return 'Active RFP detected — prepare proposal and engage procurement contacts.';
  }
  if (types.has('executive_movement') && types.has('technology_adoption')) {
    return 'New leadership + tech evaluation — reach out to the incoming executive with a tailored value prop.';
  }
  if (types.has('funding_event')) {
    return 'Recent funding — position around growth use-cases and ROI acceleration.';
  }
  if (types.has('hiring_surge')) {
    return 'Hiring surge indicates scaling — highlight onboarding and productivity solutions.';
  }
  if (urgency === 'immediate') {
    return 'Multiple strong buying signals — prioritise for immediate outreach.';
  }
  if (urgency === 'this_week') {
    return 'Building momentum — schedule discovery call this week.';
  }
  return 'Monitor account for additional intent signals before outreach.';
}

// ── Core Aggregator ────────────────────────────────────────────────────────

class SignalAggregator {
  private signals: CompanySignal[] = [];

  // ---- Ingestion ----------------------------------------------------------

  /**
   * Add an array of CompanySignal items.
   * Duplicates are **not** deduplicated here — callers should pre-filter if
   * the same raw event may be ingested more than once.
   */
  ingestSignals(incoming: CompanySignal[]): void {
    this.signals.push(...incoming);
    this.pruneOld();
  }

  /**
   * Replace all signals of a given type with a fresh batch.
   * Useful when a feed provides a complete snapshot on each poll.
   */
  replaceSignalType(type: SignalType, incoming: CompanySignal[]): void {
    this.signals = this.signals.filter(s => s.type !== type);
    this.signals.push(...incoming);
    this.pruneOld();
  }

  // ---- Clustering ---------------------------------------------------------

  getCompanyClusters(): CompanySignalCluster[] {
    const byCompany = new Map<string, CompanySignal[]>();

    for (const s of this.signals) {
      const key = normalizeCompanyName(s.company);
      const existing = byCompany.get(key) || [];
      existing.push(s);
      byCompany.set(key, existing);
    }

    const clusters: CompanySignalCluster[] = [];

    for (const [, signals] of byCompany) {
      const signalTypes = new Set(signals.map(s => s.type));
      const highCount = signals.filter(
        s => s.strength === 'high' || s.strength === 'critical',
      ).length;

      // Convergence formula:
      //   - distinct signal types contribute up to 50 pts (5 types × 10)
      //   - volume contributes up to 25 pts
      //   - high-strength signals contribute up to 25 pts
      const typeBonus = Math.min(50, signalTypes.size * 10);
      const countBonus = Math.min(25, signals.length * 3);
      const strengthBonus = Math.min(25, highCount * 5);
      const convergenceScore = Math.min(100, typeBonus + countBonus + strengthBonus);

      // Prefer the first non-undefined domain we find
      const companyDomain = signals.find(s => s.companyDomain)?.companyDomain;

      clusters.push({
        company: signals[0]!.company, // preserve original casing from first signal
        companyDomain,
        signals,
        signalTypes,
        totalCount: signals.length,
        highStrengthCount: highCount,
        convergenceScore,
      });
    }

    return clusters.sort((a, b) => b.convergenceScore - a.convergenceScore);
  }

  // ---- Convergence Alerts -------------------------------------------------

  getConvergenceAlerts(): OpportunityConvergence[] {
    const clusters = this.getCompanyClusters();
    const alerts: OpportunityConvergence[] = [];

    for (const cluster of clusters) {
      if (cluster.signalTypes.size < CONVERGENCE_TYPE_THRESHOLD) continue;

      const signalTypes = [...cluster.signalTypes];
      const urgency = deriveUrgency(cluster.convergenceScore, cluster.highStrengthCount);
      const recommendedAction = deriveRecommendedAction(signalTypes, urgency);

      const typeDescriptions = signalTypes.map(t => SIGNAL_TYPE_LABELS[t]).join(', ');

      alerts.push({
        company: cluster.company,
        signalTypes,
        totalSignals: cluster.totalCount,
        description: `${cluster.company}: convergence of ${typeDescriptions} (${cluster.totalCount} signals, score ${cluster.convergenceScore})`,
        urgency,
        recommendedAction,
      });
    }

    return alerts.sort((a, b) => {
      const urgencyOrder: Record<OpportunityConvergence['urgency'], number> = {
        immediate: 0,
        this_week: 1,
        this_month: 2,
        monitor: 3,
      };
      return urgencyOrder[a.urgency] - urgencyOrder[b.urgency] || b.totalSignals - a.totalSignals;
    });
  }

  // ---- AI Context ---------------------------------------------------------

  generateAIContext(): string {
    const clusters = this.getCompanyClusters().slice(0, 10);
    const alerts = this.getConvergenceAlerts().slice(0, 5);

    if (clusters.length === 0 && alerts.length === 0) {
      return '';
    }

    const lines: string[] = ['[COMMERCIAL INTENT SIGNALS]'];

    if (alerts.length > 0) {
      lines.push('Opportunity convergence alerts:');
      for (const a of alerts) {
        lines.push(`- [${a.urgency.toUpperCase()}] ${a.description}`);
        lines.push(`  Action: ${a.recommendedAction}`);
      }
    }

    if (clusters.length > 0) {
      lines.push('Top companies by signal convergence:');
      for (const c of clusters) {
        const types = [...c.signalTypes].map(t => SIGNAL_TYPE_LABELS[t]).join(', ');
        lines.push(
          `- ${c.company}: ${c.totalCount} signals (${types}), convergence ${c.convergenceScore}`,
        );
      }
    }

    return lines.join('\n');
  }

  // ---- Summary ------------------------------------------------------------

  getSummary(): SignalSummary {
    const byType: Record<SignalType, number> = {
      executive_movement: 0,
      funding_event: 0,
      expansion_signal: 0,
      technology_adoption: 0,
      hiring_surge: 0,
      financial_trigger: 0,
      leadership_activity: 0,
      press_release: 0,
      job_posting: 0,
      tender_rfp: 0,
    };

    for (const s of this.signals) {
      byType[s.type]++;
    }

    return {
      timestamp: new Date(),
      totalSignals: this.signals.length,
      byType,
      convergenceAlerts: this.getConvergenceAlerts(),
      topCompanies: this.getCompanyClusters().slice(0, 10),
      aiContext: this.generateAIContext(),
    };
  }

  // ---- Utilities ----------------------------------------------------------

  clear(): void {
    this.signals = [];
  }

  getSignalCount(): number {
    return this.signals.length;
  }

  private pruneOld(): void {
    const cutoff = Date.now() - WINDOW_MS;
    this.signals = this.signals.filter(s => s.timestamp.getTime() > cutoff);
  }
}

export const signalAggregator = new SignalAggregator();
