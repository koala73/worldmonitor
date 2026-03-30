import type { WatchSignals } from '@/services/watchlist-playbooks';

export interface CountryConsequenceInput {
  country: string;
  score: number | null;
  trend?: 'rising' | 'stable' | 'falling';
  signals: WatchSignals;
  infrastructureCounts?: Partial<Record<'pipeline' | 'cable' | 'datacenter' | 'base' | 'nuclear' | 'port', number>>;
  markets?: { title: string; yesPrice: number }[];
}

export interface CountryConsequence {
  kind:
    | 'war-escalation'
    | 'cyber-disruption'
    | 'infrastructure-shock'
    | 'market-stress'
    | 'civil-unrest'
    | 'disaster-response'
    | 'stability-window';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  summary: string;
  watchPanels: string[];
  evidence: string[];
}

const SEVERITY_SCORE: Record<CountryConsequence['severity'], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function toSeverity(score: number): CountryConsequence['severity'] {
  if (score >= 28) return 'critical';
  if (score >= 18) return 'high';
  if (score >= 9) return 'medium';
  return 'low';
}

function pushIf(items: string[], condition: boolean, item: string): void {
  if (condition) items.push(item);
}

export function buildCountryConsequences(input: CountryConsequenceInput): CountryConsequence[] {
  const signals = input.signals;
  const infra = input.infrastructureCounts ?? {};
  const marketBias = input.markets?.reduce((max, market) => Math.max(max, market.yesPrice), 0) ?? 0;

  const warScore =
    (signals.activeStrikes ?? 0) * 8 +
    (signals.militaryFlights ?? 0) * 1.5 +
    (signals.militaryVessels ?? 0) * 1.75 +
    (signals.conflictEvents ?? 0) * 2 +
    (signals.criticalNews ?? 0) * 2 +
    Math.max(0, marketBias - 50) * 0.2;

  const cyberScore =
    (signals.cyberThreats ?? 0) * 3 +
    (signals.outages ?? 0) * 2.5 +
    (signals.temporalAnomalies ?? 0) * 2 +
    ((infra.cable ?? 0) + (infra.datacenter ?? 0));

  const infrastructureScore =
    (signals.outages ?? 0) * 2 +
    (signals.aisDisruptions ?? 0) * 2.5 +
    (signals.aviationDisruptions ?? 0) * 2 +
    (infra.port ?? 0) +
    (infra.pipeline ?? 0) +
    (infra.cable ?? 0);

  const disasterScore =
    (signals.earthquakes ?? 0) * 7 +
    (signals.satelliteFires ?? 0) * 2 +
    (signals.climateStress ?? 0) * 0.8 +
    Math.min(10, (signals.displacementOutflow ?? 0) / 300_000);

  const unrestScore =
    (signals.protests ?? 0) * 2 +
    (signals.criticalNews ?? 0) * 1.5 +
    (signals.travelAdvisories ?? 0) * 1.25;

  const marketStressScore = Math.max(0, marketBias - 55) * 0.45 + Math.max(0, (input.score ?? 0) - 60) * 0.2;

  const consequences: CountryConsequence[] = [];

  if (warScore > 0) {
    const evidence: string[] = [];
    pushIf(evidence, (signals.militaryFlights ?? 0) > 0, `${signals.militaryFlights} military flights`);
    pushIf(evidence, (signals.militaryVessels ?? 0) > 0, `${signals.militaryVessels} military vessels`);
    pushIf(evidence, (signals.activeStrikes ?? 0) > 0, `${signals.activeStrikes} active strikes`);
    pushIf(evidence, (signals.criticalNews ?? 0) > 0, `${signals.criticalNews} critical headlines`);
    pushIf(evidence, (infra.port ?? 0) > 0, `${infra.port} nearby ports`);
    pushIf(evidence, (infra.cable ?? 0) > 0, `${infra.cable} cable routes in scope`);
    consequences.push({
      kind: 'war-escalation',
      severity: toSeverity(warScore),
      title: 'Force posture could spill into trade and transit',
      summary: 'Military and strike indicators imply the next-order risk is disruption to maritime access, cables, and energy logistics rather than a local-only flare-up.',
      watchPanels: ['strategic-posture', 'strategic-risk', 'alert-center', 'supply-chain'],
      evidence,
    });
  }

  if (cyberScore > 0) {
    const evidence: string[] = [];
    pushIf(evidence, (signals.cyberThreats ?? 0) > 0, `${signals.cyberThreats} cyber threats`);
    pushIf(evidence, (signals.outages ?? 0) > 0, `${signals.outages} connectivity outages`);
    pushIf(evidence, (infra.cable ?? 0) > 0, `${infra.cable} cable corridors`);
    pushIf(evidence, (infra.datacenter ?? 0) > 0, `${infra.datacenter} datacenter sites`);
    consequences.push({
      kind: 'cyber-disruption',
      severity: toSeverity(cyberScore),
      title: 'Digital disruption could outrun the headline cycle',
      summary: 'Cyber and outage signals suggest follow-on impacts to communications, payment rails, and operational continuity are more likely than a one-off incident.',
      watchPanels: ['comms-health', 'cyber-threats', 'security-advisories', 'alert-center'],
      evidence,
    });
  }

  if (infrastructureScore > 0) {
    const evidence: string[] = [];
    pushIf(evidence, (signals.aisDisruptions ?? 0) > 0, `${signals.aisDisruptions} AIS disruptions`);
    pushIf(evidence, (signals.aviationDisruptions ?? 0) > 0, `${signals.aviationDisruptions} aviation disruptions`);
    pushIf(evidence, (infra.port ?? 0) > 0, `${infra.port} ports`);
    pushIf(evidence, (infra.pipeline ?? 0) > 0, `${infra.pipeline} pipelines`);
    consequences.push({
      kind: 'infrastructure-shock',
      severity: toSeverity(infrastructureScore),
      title: 'Physical bottlenecks may be the real amplifier',
      summary: 'Transport, shipping, and energy choke points are positioned to turn localized incidents into wider supply or pricing stress.',
      watchPanels: ['cascade', 'supply-chain', 'markets', 'alert-center'],
      evidence,
    });
  }

  if (disasterScore > 0) {
    const evidence: string[] = [];
    pushIf(evidence, (signals.earthquakes ?? 0) > 0, `${signals.earthquakes} earthquake events`);
    pushIf(evidence, (signals.satelliteFires ?? 0) > 0, `${signals.satelliteFires} fire detections`);
    pushIf(evidence, (signals.displacementOutflow ?? 0) > 0, `${Math.round((signals.displacementOutflow ?? 0) / 1000)}k displaced`);
    consequences.push({
      kind: 'disaster-response',
      severity: toSeverity(disasterScore),
      title: 'Humanitarian load and infrastructure recovery could dominate next',
      summary: 'Hazard signals point to likely second-order pressure on transport, public health, and displacement pathways.',
      watchPanels: ['earthquakes', 'satellite-fires', 'displacement', 'air-quality'],
      evidence,
    });
  }

  if (unrestScore > 0) {
    const evidence: string[] = [];
    pushIf(evidence, (signals.protests ?? 0) > 0, `${signals.protests} protest signals`);
    pushIf(evidence, (signals.travelAdvisories ?? 0) > 0, `${signals.travelAdvisories} travel advisories`);
    pushIf(evidence, (signals.criticalNews ?? 0) > 0, `${signals.criticalNews} critical headlines`);
    consequences.push({
      kind: 'civil-unrest',
      severity: toSeverity(unrestScore),
      title: 'Domestic instability could widen into state response risk',
      summary: 'Protests and advisory pressure suggest the next escalation may come from crowd control, transport shutdowns, or opportunistic cyber and comms incidents.',
      watchPanels: ['cii', 'live-news', 'alert-center', 'comms-health'],
      evidence,
    });
  }

  if (marketStressScore > 0) {
    const evidence: string[] = [];
    pushIf(evidence, marketBias > 55, `${Math.round(marketBias)}% market-implied stress`);
    pushIf(evidence, (input.score ?? 0) > 60, `${input.score}/100 instability score`);
    consequences.push({
      kind: 'market-stress',
      severity: toSeverity(marketStressScore),
      title: 'Market repricing could lead the public narrative',
      summary: 'Prediction and risk signals imply the tradable consequence may move faster than official statements or mainstream coverage.',
      watchPanels: ['markets', 'macro-signals', 'polymarket', 'alert-center'],
      evidence,
    });
  }

  if (consequences.length === 0) {
    consequences.push({
      kind: 'stability-window',
      severity: 'low',
      title: 'No dominant second-order consequence yet',
      summary: 'The country is active enough to watch, but no downstream failure mode is clearly outrunning the rest of the signal set.',
      watchPanels: ['watchlist', 'strategic-risk', 'live-news'],
      evidence: ['Baseline monitoring'],
    });
  }

  // eslint-disable-next-line unicorn/no-array-sort
  return [...consequences].sort((a, b) => SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity]);
}
