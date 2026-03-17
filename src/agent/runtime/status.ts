/**
 * Agent Status Renderer — cyberpunk-themed terminal status display.
 *
 * Renders the agent system state as a stylized HUD for the dashboard.
 * Designed for both console output and DOM injection.
 */

import type {
  AgentState,
  IntelligenceBrief,
  Severity,
  SignalDomain,
  Finding,
  FocalPointBrief,
} from '../types';

// ============================================================================
// GLYPH SETS
// ============================================================================

const PHASE_GLYPHS: Record<string, string> = {
  observe:  '◉ OBSERVE',
  plan:     '◈ PLAN',
  act:      '▸ ACT',
  reflect:  '◎ REFLECT',
  idle:     '⏸ IDLE',
};

const SEVERITY_GLYPHS: Record<Severity, string> = {
  critical: '▓▓▓▓▓',
  high:     '▓▓▓▓░',
  medium:   '▓▓▓░░',
  low:      '▓▓░░░',
  info:     '▓░░░░',
};

const DOMAIN_GLYPHS: Record<SignalDomain, string> = {
  news:           'NEWS',
  conflict:       'CFLX',
  unrest:         'UNRS',
  military:       'MLTX',
  maritime:       'MARV',
  cyber:          'CYBR',
  economic:       'ECON',
  climate:        'CLMT',
  infrastructure: 'INFR',
  seismology:     'SEIS',
  wildfire:       'WLDF',
  displacement:   'DSPL',
  aviation:       'AVTN',
  prediction:     'PRED',
  intelligence:   'INTL',
};

// ============================================================================
// STATUS RENDERERS
// ============================================================================

export interface StatusSnapshot {
  timestamp: number;
  phase: string;
  phaseGlyph: string;
  cycleCount: number;
  threatLevel: Severity;
  threatBar: string;
  findings: number;
  focalPoints: number;
  domainsActive: string[];
  topRegions: string[];
  goalCount: number;
  tasksPending: number;
  memoryEntries: number;
  uptime: number;
}

export function captureStatus(
  state: AgentState,
  brief: IntelligenceBrief | null,
  startedAt: number,
): StatusSnapshot {
  const threatLevel = brief?.threatLevel ?? 'info';
  return {
    timestamp: Date.now(),
    phase: state.phase,
    phaseGlyph: PHASE_GLYPHS[state.phase] ?? '? UNKNOWN',
    cycleCount: state.cycleCount,
    threatLevel,
    threatBar: SEVERITY_GLYPHS[threatLevel],
    findings: brief?.findings.length ?? 0,
    focalPoints: brief?.focalPoints.length ?? 0,
    domainsActive: brief?.domainsCovered.map(d => DOMAIN_GLYPHS[d] ?? d) ?? [],
    topRegions: brief?.focalPoints.slice(0, 5).map(fp => fp.entity) ?? [],
    goalCount: state.activeGoals.length,
    tasksPending: state.taskQueue.filter(t => t.status === 'queued').length,
    memoryEntries: 0,
    uptime: Date.now() - startedAt,
  };
}

/**
 * Render a full-width terminal HUD string.
 */
export function renderTerminalHUD(snap: StatusSnapshot): string {
  const upH = Math.floor(snap.uptime / 3600_000);
  const upM = Math.floor((snap.uptime % 3600_000) / 60_000);

  const lines = [
    `┌──────────────────────────────────────────────────────────────────┐`,
    `│  ▌ WORLDMONITOR AGENT v1.0 ▐    ${snap.phaseGlyph.padEnd(16)} CYCLE ${String(snap.cycleCount).padStart(4)} │`,
    `├──────────────────────────────────────────────────────────────────┤`,
    `│  THREAT  ${snap.threatBar}  ${snap.threatLevel.toUpperCase().padEnd(10)}  UP ${String(upH).padStart(2)}h${String(upM).padStart(2, '0')}m${' '.repeat(18)}│`,
    `│  FINDINGS  ${String(snap.findings).padStart(3)}    FOCAL POINTS  ${String(snap.focalPoints).padStart(3)}    GOALS  ${String(snap.goalCount).padStart(3)}         │`,
    `├──────────────────────────────────────────────────────────────────┤`,
    `│  DOMAINS  ${snap.domainsActive.join(' ').padEnd(54)}│`,
    `│  REGIONS  ${snap.topRegions.join(' ').padEnd(54)}│`,
    `└──────────────────────────────────────────────────────────────────┘`,
  ];

  return lines.join('\n');
}

/**
 * Render a compact one-line status string.
 */
export function renderStatusLine(snap: StatusSnapshot): string {
  return `[${snap.phaseGlyph}] T:${snap.threatLevel.toUpperCase()} F:${snap.findings} FP:${snap.focalPoints} G:${snap.goalCount} C:${snap.cycleCount} D:[${snap.domainsActive.join(',')}]`;
}

/**
 * Render findings as a cyberpunk-styled intelligence feed.
 */
export function renderFindingsFeed(findings: Finding[]): string {
  if (findings.length === 0) return '  ░░░ NO ACTIVE FINDINGS ░░░';

  return findings.slice(0, 10).map((f, i) => {
    const sev = SEVERITY_GLYPHS[f.severity];
    const regions = f.regions.join(',') || 'GLOBAL';
    const domains = f.domains.map(d => DOMAIN_GLYPHS[d] ?? d).join('+');
    return `  ${String(i + 1).padStart(2)}. ${sev} [${regions}] ${domains} — ${f.title.slice(0, 50)}`;
  }).join('\n');
}

/**
 * Render focal points as a ranked convergence display.
 */
export function renderFocalPoints(fps: FocalPointBrief[]): string {
  if (fps.length === 0) return '  ░░░ NO FOCAL POINTS ░░░';

  return fps.slice(0, 8).map((fp, i) => {
    const bar = '█'.repeat(Math.round(fp.convergenceScore / 10));
    const pad = '░'.repeat(10 - Math.round(fp.convergenceScore / 10));
    const trend = fp.trend === 'rising' ? '↑' : fp.trend === 'falling' ? '↓' : '→';
    const domains = fp.activeDomains.map(d => DOMAIN_GLYPHS[d] ?? d).join(' ');
    return `  ${String(i + 1).padStart(2)}. ${fp.entity.padEnd(5)} ${bar}${pad} ${fp.convergenceScore.toFixed(0).padStart(3)}% ${trend}  [${domains}]`;
  }).join('\n');
}

/**
 * Render a complete intelligence brief as a styled document.
 */
export function renderBrief(brief: IntelligenceBrief): string {
  const ts = new Date(brief.timestamp).toISOString().slice(0, 19);
  const sev = SEVERITY_GLYPHS[brief.threatLevel];

  return [
    `╔══════════════════════════════════════════════════════════════════╗`,
    `║  INTELLIGENCE BRIEF                              ${ts} ║`,
    `║  Threat Level: ${sev} ${brief.threatLevel.toUpperCase().padEnd(47)}║`,
    `║  Signals: ${String(brief.signalCount).padStart(4)}  │  Domains: ${brief.domainsCovered.length.toString().padStart(2)}  │  Run: ${brief.pipelineRunId.slice(0, 20).padEnd(20)} ║`,
    `╠══════════════════════════════════════════════════════════════════╣`,
    `║  FINDINGS                                                      ║`,
    `╠──────────────────────────────────────────────────────────────────╣`,
    renderFindingsFeed(brief.findings),
    `╠══════════════════════════════════════════════════════════════════╣`,
    `║  FOCAL POINTS                                                  ║`,
    `╠──────────────────────────────────────────────────────────────────╣`,
    renderFocalPoints(brief.focalPoints),
    `╠══════════════════════════════════════════════════════════════════╣`,
    `║  RECOMMENDATIONS                                               ║`,
    `╠──────────────────────────────────────────────────────────────────╣`,
    ...brief.recommendations.map(r => `  → ${r}`),
    `╚══════════════════════════════════════════════════════════════════╝`,
  ].join('\n');
}

// ============================================================================
// CSS CLASS GENERATORS (for DOM rendering)
// ============================================================================

export function severityClass(severity: Severity): string {
  return `agent-severity--${severity}`;
}

export function phaseClass(phase: string): string {
  return `agent-phase--${phase}`;
}

export function domainClass(domain: SignalDomain): string {
  return `agent-domain--${domain}`;
}
