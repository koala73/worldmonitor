/**
 * Pipeline Runner — orchestrates the INGEST→ENCODE→FILTER→COLLAPSE→SYNTHESIZE→EMIT
 * pipeline with invariant verification at every stage boundary.
 */

import type {
  PipelineContext,
  IntelligenceBrief,
  CollapseRule,
} from '../types';
import { PipelineStage } from '../types';
import {
  ingest,
  encode,
  filter,
  collapse,
  synthesize,
  buildStageResult,
  type IngestInput,
  type FilterConfig,
  type SynthesisOutput,
} from './stages';
import { InvariantVerifier, type VerificationReport } from '../invariants/verifier';
import { agentBus } from '../bus/event-bus';

export interface PipelineRunResult {
  runId: string;
  success: boolean;
  brief: IntelligenceBrief | null;
  synthesis: SynthesisOutput | null;
  context: PipelineContext;
  verificationReports: VerificationReport[];
  totalDuration: number;
  haltedAt?: PipelineStage;
  error?: string;
}

export interface PipelineRunConfig {
  filter?: Partial<FilterConfig>;
  collapseRules?: CollapseRule[];
}

let runCounter = 0;

export class PipelineRunner {
  private verifier = new InvariantVerifier();

  /**
   * Execute a full pipeline run.
   */
  async run(
    inputs: IngestInput[],
    config: PipelineRunConfig = {},
  ): Promise<PipelineRunResult> {
    const runId = `run-${++runCounter}-${Date.now()}`;
    const startTime = performance.now();
    const reports: VerificationReport[] = [];

    const context: PipelineContext = {
      runId,
      startedAt: Date.now(),
      stages: [],
      memory: { session: [], episodic: [], longterm: [], totalEntries: 0, lastCompactedAt: 0 },
      goals: [],
    };

    agentBus.emit('pipeline:started', { runId }, 'pipeline-runner');

    try {
      // ── INGEST ────────────────────────────────────────────
      const t0 = performance.now();
      const signals = ingest(inputs);

      const ingestReport = this.verifier.verify(
        PipelineStage.INGEST, context, signals
      );
      reports.push(ingestReport);
      if (ingestReport.halt) {
        return this.buildHaltResult(runId, PipelineStage.INGEST, context, reports, startTime);
      }

      context.stages.push(buildStageResult(
        PipelineStage.INGEST, inputs, signals, t0,
        ingestReport.violations.length === 0 ? ['all'] : [],
        ingestReport.violations,
        0,
      ));
      agentBus.emit('pipeline:stage:complete', { runId, stage: 'INGEST', count: signals.length }, 'pipeline-runner');

      // ── ENCODE ────────────────────────────────────────────
      const t1 = performance.now();
      const encoded = encode(signals);

      const encodeReport = this.verifier.verify(
        PipelineStage.ENCODE, context, signals, encoded
      );
      reports.push(encodeReport);
      if (encodeReport.halt) {
        return this.buildHaltResult(runId, PipelineStage.ENCODE, context, reports, startTime);
      }

      context.stages.push(buildStageResult(
        PipelineStage.ENCODE, signals, encoded, t1,
        encodeReport.violations.length === 0 ? ['all'] : [],
        encodeReport.violations,
        0,
      ));
      agentBus.emit('pipeline:stage:complete', { runId, stage: 'ENCODE', count: encoded.length }, 'pipeline-runner');

      // ── FILTER ────────────────────────────────────────────
      const t2 = performance.now();
      const filtered = filter(encoded, config.filter);

      const filterReport = this.verifier.verify(
        PipelineStage.FILTER, context, filtered, filtered
      );
      reports.push(filterReport);

      const droppedCount = encoded.length - filtered.length;
      context.stages.push(buildStageResult(
        PipelineStage.FILTER, encoded, filtered, t2,
        filterReport.violations.length === 0 ? ['all'] : [],
        filterReport.violations,
        droppedCount,
      ));
      agentBus.emit('pipeline:stage:complete', { runId, stage: 'FILTER', count: filtered.length, dropped: droppedCount }, 'pipeline-runner');

      // ── COLLAPSE ──────────────────────────────────────────
      const t3 = performance.now();
      const collapsed = collapse(filtered, config.collapseRules);

      const collapseReport = this.verifier.verify(
        PipelineStage.COLLAPSE, context, filtered, filtered, collapsed
      );
      reports.push(collapseReport);

      context.stages.push(buildStageResult(
        PipelineStage.COLLAPSE, filtered, collapsed, t3,
        collapseReport.violations.length === 0 ? ['all'] : [],
        collapseReport.violations,
        0,
      ));
      agentBus.emit('pipeline:stage:complete', { runId, stage: 'COLLAPSE', count: collapsed.length }, 'pipeline-runner');

      // ── SYNTHESIZE ────────────────────────────────────────
      const t4 = performance.now();
      const synthesis = synthesize(collapsed);

      const synthReport = this.verifier.verify(
        PipelineStage.SYNTHESIZE, context, filtered, filtered, collapsed
      );
      reports.push(synthReport);

      context.stages.push(buildStageResult(
        PipelineStage.SYNTHESIZE, collapsed, synthesis, t4,
        synthReport.violations.length === 0 ? ['all'] : [],
        synthReport.violations,
        0,
      ));
      agentBus.emit('pipeline:stage:complete', { runId, stage: 'SYNTHESIZE', findings: synthesis.findings.length }, 'pipeline-runner');

      // ── EMIT ──────────────────────────────────────────────
      const t5 = performance.now();

      const brief: IntelligenceBrief = {
        id: `brief:${runId}`,
        timestamp: Date.now(),
        threatLevel: synthesis.overallThreatLevel,
        findings: synthesis.findings,
        focalPoints: synthesis.focalPoints,
        recommendations: this.generateRecommendations(synthesis),
        pipelineRunId: runId,
        signalCount: signals.length,
        domainsCovered: [...new Set(signals.map(s => s.domain))],
      };

      const emitReport = this.verifier.verify(
        PipelineStage.EMIT, context, signals, encoded, collapsed
      );
      reports.push(emitReport);

      context.stages.push(buildStageResult(
        PipelineStage.EMIT, synthesis, brief, t5,
        emitReport.violations.length === 0 ? ['all'] : [],
        emitReport.violations,
        0,
      ));

      agentBus.emit('pipeline:complete', {
        runId,
        findings: synthesis.findings.length,
        focalPoints: synthesis.focalPoints.length,
        threatLevel: synthesis.overallThreatLevel,
        duration: performance.now() - startTime,
      }, 'pipeline-runner');

      return {
        runId,
        success: true,
        brief,
        synthesis,
        context,
        verificationReports: reports,
        totalDuration: performance.now() - startTime,
      };

    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      agentBus.emit('pipeline:error', { runId, error }, 'pipeline-runner');
      return {
        runId,
        success: false,
        brief: null,
        synthesis: null,
        context,
        verificationReports: reports,
        totalDuration: performance.now() - startTime,
        error,
      };
    }
  }

  getVerifier(): InvariantVerifier {
    return this.verifier;
  }

  private buildHaltResult(
    runId: string,
    stage: PipelineStage,
    context: PipelineContext,
    reports: VerificationReport[],
    startTime: number,
  ): PipelineRunResult {
    agentBus.emit('pipeline:error', { runId, haltedAt: stage }, 'pipeline-runner');
    return {
      runId,
      success: false,
      brief: null,
      synthesis: null,
      context,
      verificationReports: reports,
      totalDuration: performance.now() - startTime,
      haltedAt: stage,
      error: `Pipeline halted at ${stage} due to fatal invariant violation`,
    };
  }

  private generateRecommendations(synthesis: SynthesisOutput): string[] {
    const recs: string[] = [];
    const criticalFindings = synthesis.findings.filter(f => f.severity === 'critical');
    const highFindings = synthesis.findings.filter(f => f.severity === 'high');

    if (criticalFindings.length > 0) {
      recs.push(`CRITICAL: ${criticalFindings.length} critical finding(s) require immediate attention`);
    }
    if (highFindings.length > 0) {
      recs.push(`HIGH: Monitor ${highFindings.length} high-severity finding(s) for escalation`);
    }
    if (synthesis.focalPoints.length > 0) {
      const top = synthesis.focalPoints[0]!;
      recs.push(`WATCH: ${top.entity} shows highest convergence (${top.activeDomains.length} domains active)`);
    }
    if (synthesis.findings.length === 0) {
      recs.push('No significant convergence detected — routine monitoring continues');
    }
    return recs;
  }
}
