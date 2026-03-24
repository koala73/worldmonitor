/**
 * Corpus Synthesizer — generates structured, AI-readable intelligence
 * reports from pipeline output.
 *
 * The synthesizer produces machine-parseable documents that can be:
 * 1. Fed back into Ollama/Claude as context for deeper analysis
 * 2. Stored in the memory system as episodic records
 * 3. Used as tool output for the agent's reflect phase
 * 4. Exported as structured reports for external consumption
 *
 * Output format is designed for LLM consumption — structured text with
 * clear section delimiters, integer-encoded severity, and explicit
 * causal chains from the action-consequence corpus.
 */

import type {
  IntelligenceBrief,
  Severity,
  SignalDomain,
} from '../types';
import {
  traceConsequences,
  CORPUS_STATS,
} from './action-consequence';

// ============================================================================
// REPORT TYPES
// ============================================================================

export interface SynthesizedReport {
  /** Unique report ID */
  id: string;
  /** When generated */
  timestamp: number;
  /** Report format version */
  version: string;
  /** The structured text document (AI-readable) */
  document: string;
  /** Metadata for indexing */
  meta: ReportMeta;
}

export interface ReportMeta {
  threatLevel: Severity;
  findingCount: number;
  focalPointCount: number;
  consequenceChains: number;
  domainsActive: SignalDomain[];
  regionsActive: string[];
  wordCount: number;
}

// ============================================================================
// SEVERITY ENCODING (integer for constraint mapping)
// ============================================================================

const SEV_INT: Record<Severity, number> = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };

function sevBar(s: Severity): string {
  const n = SEV_INT[s];
  return '#'.repeat(n) + '.'.repeat(5 - n);
}

// ============================================================================
// CORE SYNTHESIZER
// ============================================================================

let reportCounter = 0;

/**
 * Generate a full AI-readable intelligence report from a pipeline brief.
 */
export function synthesizeReport(brief: IntelligenceBrief): SynthesizedReport {
  const id = `RPT-${++reportCounter}-${Date.now()}`;
  const ts = new Date(brief.timestamp).toISOString();

  const sections: string[] = [];

  // ── HEADER ──────────────────────────────────────────────────────
  sections.push(`[INTELLIGENCE REPORT ${id}]`);
  sections.push(`GENERATED: ${ts}`);
  sections.push(`THREAT_LEVEL: ${brief.threatLevel.toUpperCase()} (${SEV_INT[brief.threatLevel]}/5) ${sevBar(brief.threatLevel)}`);
  sections.push(`SIGNALS: ${brief.signalCount} | DOMAINS: ${brief.domainsCovered.length} | FINDINGS: ${brief.findings.length} | FOCAL_POINTS: ${brief.focalPoints.length}`);
  sections.push(`PIPELINE_RUN: ${brief.pipelineRunId}`);
  sections.push('');

  // ── FINDINGS ────────────────────────────────────────────────────
  if (brief.findings.length > 0) {
    sections.push('[FINDINGS]');
    for (const [i, f] of brief.findings.entries()) {
      sections.push(`  F${i + 1}. [${f.severity.toUpperCase()}] ${sevBar(f.severity)} | REGIONS: ${f.regions.join(',') || 'GLOBAL'} | DOMAINS: ${f.domains.join('+')}`);
      sections.push(`      ${f.title}`);
      sections.push(`      ${f.summary}`);
      sections.push(`      CONFIDENCE: ${(f.confidence * 100).toFixed(0)}% | SOURCES: ${f.sourceSignals.length} signals`);

      // Trace causal consequences from finding tags
      const findingTags = [...f.domains, ...f.regions.map(r => r.toLowerCase()), f.severity];
      const consequences = traceConsequences(findingTags, 'medium', 2);
      if (consequences.length > 0) {
        sections.push('      CONSEQUENCE_CHAIN:');
        for (const c of consequences.slice(0, 5)) {
          const delayStr = c.consequence.delayHours < 24
            ? `${c.consequence.delayHours}h`
            : `${Math.round(c.consequence.delayHours / 24)}d`;
          sections.push(`        → [D${c.depth}] ${c.consequence.effect} | DELAY: ${delayStr} | CONF: ${(c.consequence.confidence * 100).toFixed(0)}% | TARGET: ${c.consequence.targetDomain}/${c.consequence.targetRegions.join(',')}`);
        }
      }
      sections.push('');
    }
  }

  // ── FOCAL POINTS ────────────────────────────────────────────────
  if (brief.focalPoints.length > 0) {
    sections.push('[FOCAL_POINTS]');
    for (const [i, fp] of brief.focalPoints.entries()) {
      const bar = '█'.repeat(Math.round(fp.convergenceScore / 10)) + '░'.repeat(10 - Math.round(fp.convergenceScore / 10));
      const trend = fp.trend === 'rising' ? '↑ RISING' : fp.trend === 'falling' ? '↓ FALLING' : '→ STABLE';
      sections.push(`  FP${i + 1}. ${fp.entity.padEnd(6)} ${bar} ${fp.convergenceScore.toFixed(0)}% | ${trend} | DOMAINS: ${fp.activeDomains.join('+')}`);
      sections.push(`       ${fp.narrative}`);

      // Trace consequences for focal point
      const fpTags = [fp.entity.toLowerCase(), ...fp.activeDomains];
      const fpConsequences = traceConsequences(fpTags, 'medium', 2);
      if (fpConsequences.length > 0) {
        sections.push('       PROJECTED_EFFECTS:');
        for (const c of fpConsequences.slice(0, 3)) {
          sections.push(`         → ${c.consequence.effect} (${(c.consequence.confidence * 100).toFixed(0)}% conf, ${c.consequence.targetDomain})`);
        }
      }
      sections.push('');
    }
  }

  // ── RECOMMENDATIONS ─────────────────────────────────────────────
  if (brief.recommendations.length > 0) {
    sections.push('[RECOMMENDATIONS]');
    for (const rec of brief.recommendations) {
      sections.push(`  • ${rec}`);
    }
    sections.push('');
  }

  // ── DOMAIN COVERAGE MATRIX ──────────────────────────────────────
  sections.push('[DOMAIN_COVERAGE]');
  const allDomains: SignalDomain[] = [
    'news', 'conflict', 'unrest', 'military', 'maritime', 'cyber',
    'economic', 'climate', 'infrastructure', 'seismology', 'wildfire',
    'displacement', 'aviation', 'prediction', 'intelligence',
  ];
  for (const d of allDomains) {
    const active = brief.domainsCovered.includes(d);
    sections.push(`  ${active ? '[■]' : '[ ]'} ${d.toUpperCase().padEnd(16)}`);
  }
  sections.push('');

  // ── CORPUS REFERENCE ────────────────────────────────────────────
  sections.push('[CORPUS_STATS]');
  sections.push(`  ENTRIES: ${CORPUS_STATS.totalEntries} | CONSEQUENCES: ${CORPUS_STATS.totalConsequences} | TAGS: ${CORPUS_STATS.uniqueTags} | MAX_CHAIN: ${CORPUS_STATS.maxChainDepth}`);
  sections.push('');

  sections.push(`[END REPORT ${id}]`);

  const document = sections.join('\n');
  const wordCount = document.split(/\s+/).length;

  return {
    id,
    timestamp: Date.now(),
    version: '1.0',
    document,
    meta: {
      threatLevel: brief.threatLevel,
      findingCount: brief.findings.length,
      focalPointCount: brief.focalPoints.length,
      consequenceChains: brief.findings.reduce((sum, f) => {
        const tags = [...f.domains, ...f.regions.map(r => r.toLowerCase())];
        return sum + traceConsequences(tags, 'medium', 2).length;
      }, 0),
      domainsActive: brief.domainsCovered,
      regionsActive: [...new Set(brief.findings.flatMap(f => f.regions))],
      wordCount,
    },
  };
}

/**
 * Generate a compact situation summary (single paragraph) for LLM context injection.
 */
export function synthesizeSitRep(brief: IntelligenceBrief): string {
  if (brief.findings.length === 0) {
    return `SITREP ${new Date().toISOString().slice(0, 16)}: No significant convergence detected across ${brief.domainsCovered.length} domains. Routine monitoring continues.`;
  }

  const topFinding = brief.findings[0]!;
  const topFP = brief.focalPoints[0];
  const regions = [...new Set(brief.findings.flatMap(f => f.regions))].join(', ');

  let sitrep = `SITREP ${new Date().toISOString().slice(0, 16)}: `;
  sitrep += `THREAT=${brief.threatLevel.toUpperCase()}. `;
  sitrep += `${brief.findings.length} finding(s) across ${brief.domainsCovered.join('+')}. `;
  sitrep += `Primary: ${topFinding.title}. `;
  if (topFP) {
    sitrep += `Focal: ${topFP.entity} (${topFP.convergenceScore.toFixed(0)}% convergence, ${topFP.trend}). `;
  }
  if (regions) sitrep += `Regions: ${regions}. `;
  sitrep += `Signals: ${brief.signalCount}.`;

  return sitrep;
}

/**
 * Generate an action-consequence trace document for a specific set of tags.
 * Used by the agent to reason about second-order effects.
 */
export function synthesizeCausalTrace(tags: string[], minSeverity: Severity = 'medium'): string {
  const consequences = traceConsequences(tags, minSeverity);
  if (consequences.length === 0) return `CAUSAL_TRACE: No matching entries for tags [${tags.join(', ')}].`;

  const lines = [`CAUSAL_TRACE for [${tags.join(', ')}]:`];
  for (const c of consequences) {
    const delay = c.consequence.delayHours < 24
      ? `${c.consequence.delayHours}h`
      : `${Math.round(c.consequence.delayHours / 24)}d`;
    lines.push(`  D${c.depth}: ${c.entry.action} → ${c.consequence.effect}`);
    lines.push(`     DELAY=${delay} CONF=${(c.consequence.confidence * 100).toFixed(0)}% TARGET=${c.consequence.targetDomain}/${c.consequence.targetRegions.join(',')}`);
  }

  return lines.join('\n');
}
