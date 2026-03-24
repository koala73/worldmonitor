/**
 * Agent Runtime — the Observe → Plan → Act → Reflect loop.
 *
 * This is the core intelligence orchestrator that replaces the
 * monolithic App.ts service coordination. It runs in cycles,
 * using the pipeline, planner, memory, and tools to produce
 * intelligence briefs.
 */

import type {
  AgentState,
  Observation,
  Reflection,
  Signal,
  IntelligenceBrief,
  TaskResult,
} from '../types';
import { PipelineRunner, type PipelineRunResult } from '../pipeline/runner';
import { MemoryStore } from '../memory/store';
import { GoalDecomposer } from '../planner/decomposer';
import { executeTool } from '../tools/registry';
import { agentBus } from '../bus/event-bus';
import type { IngestInput } from '../pipeline/stages';
import { synthesizeReport, synthesizeSitRep } from '../corpus/synthesizer';

// ============================================================================
// AGENT CONFIGURATION
// ============================================================================

export interface AgentConfig {
  /** Minimum interval between full cycles (ms) */
  cycleIntervalMs: number;
  /** Maximum tasks to execute per cycle */
  maxTasksPerCycle: number;
  /** Salience threshold for observations to be actionable */
  salienceThreshold: number;
  /** Auto-start the full sweep on init? */
  autoStart: boolean;
  /** Enable market scan goal template? */
  enableMarketScan: boolean;
}

const DEFAULT_CONFIG: AgentConfig = {
  cycleIntervalMs: 5 * 60 * 1000, // 5 minutes
  maxTasksPerCycle: 15,
  salienceThreshold: 50,
  autoStart: true,
  enableMarketScan: true,
};

// ============================================================================
// AGENT RUNTIME
// ============================================================================

export class AgentRuntime {
  private state: AgentState = {
    phase: 'idle',
    cycleCount: 0,
    lastCycleAt: 0,
    activeGoals: [],
    taskQueue: [],
    observations: [],
    reflections: [],
  };

  private pipeline = new PipelineRunner();
  private memory = new MemoryStore();
  private planner = new GoalDecomposer();
  private config: AgentConfig;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private lastBrief: IntelligenceBrief | null = null;
  private lastReport: import('../corpus/synthesizer').SynthesizedReport | null = null;
  private accumulatedSignals: Signal[] = [];
  private running = false;

  constructor(config: Partial<AgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.setupEventListeners();
  }

  // ──────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Start the agent runtime.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    console.log('[Agent] Runtime starting');

    if (this.config.autoStart) {
      // Create initial full sweep goal
      this.planner.createFromTemplate('gt-full-sweep', {
        rationale: 'Initial intelligence sweep on startup',
      });

      if (this.config.enableMarketScan) {
        this.planner.createFromTemplate('gt-market-scan', {
          rationale: 'Scheduled market sector analysis',
        });
      }
    }

    // Run first cycle immediately
    this.runCycle().catch(err => {
      console.error('[Agent] Initial cycle failed:', err);
    });

    // Schedule recurring cycles
    this.cycleTimer = setInterval(() => {
      this.runCycle().catch(err => {
        console.error('[Agent] Cycle failed:', err);
      });
    }, this.config.cycleIntervalMs);
  }

  /**
   * Stop the agent runtime.
   */
  stop(): void {
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
    this.running = false;
    console.log('[Agent] Runtime stopped');
  }

  /**
   * Get current agent state.
   */
  getState(): AgentState {
    return { ...this.state };
  }

  /**
   * Get the latest intelligence brief.
   */
  getLatestBrief(): IntelligenceBrief | null {
    return this.lastBrief;
  }

  /**
   * Get the memory store for external queries.
   */
  getMemory(): MemoryStore {
    return this.memory;
  }

  /**
   * Get the pipeline runner for verification reports.
   */
  getPipeline(): PipelineRunner {
    return this.pipeline;
  }

  /**
   * Get the latest synthesized report (AI-readable document).
   */
  getLatestReport(): import('../corpus/synthesizer').SynthesizedReport | null {
    return this.lastReport;
  }

  // ──────────────────────────────────────────────────────────────────────
  // CORE LOOP: Observe → Plan → Act → Reflect
  // ──────────────────────────────────────────────────────────────────────

  async runCycle(): Promise<PipelineRunResult | null> {
    if (this.state.phase !== 'idle') {
      console.log('[Agent] Cycle skipped — already running');
      return null;
    }

    const cycleStart = Date.now();
    this.state.cycleCount++;
    console.log(`[Agent] Cycle ${this.state.cycleCount} starting`);

    try {
      // ── OBSERVE ──────────────────────────────────────────
      this.state.phase = 'observe';
      agentBus.emit('agent:observe', { cycle: this.state.cycleCount }, 'agent');
      const observations = this.observe();

      // ── PLAN ─────────────────────────────────────────────
      this.state.phase = 'plan';
      agentBus.emit('agent:plan', { observations: observations.length }, 'agent');
      this.plan(observations);

      // ── ACT ──────────────────────────────────────────────
      this.state.phase = 'act';
      agentBus.emit('agent:act', { goals: this.planner.getActiveGoals().length }, 'agent');
      const signals = await this.act();

      // ── PIPELINE ─────────────────────────────────────────
      // Run accumulated signals through the pipeline
      let pipelineResult: PipelineRunResult | null = null;
      if (signals.length > 0) {
        const ingestInputs = this.groupSignalsByDomain(signals);
        pipelineResult = await this.pipeline.run(ingestInputs);

        if (pipelineResult.success && pipelineResult.brief) {
          this.lastBrief = pipelineResult.brief;
          agentBus.emit('signal:emitted', pipelineResult.brief, 'agent');
        }
      }

      // ── REFLECT ──────────────────────────────────────────
      this.state.phase = 'reflect';
      agentBus.emit('agent:reflect', {
        signalCount: signals.length,
        pipelineSuccess: pipelineResult?.success,
      }, 'agent');
      this.reflect(pipelineResult);

      this.state.lastCycleAt = Date.now();
      console.log(`[Agent] Cycle ${this.state.cycleCount} complete in ${Date.now() - cycleStart}ms`);

      return pipelineResult;

    } catch (err) {
      console.error(`[Agent] Cycle ${this.state.cycleCount} error:`, err);
      return null;
    } finally {
      this.state.phase = 'idle';
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // PHASE IMPLEMENTATIONS
  // ──────────────────────────────────────────────────────────────────────

  /**
   * OBSERVE: Assess current state, check memory, detect anomalies.
   */
  private observe(): Observation[] {
    const observations: Observation[] = [];

    // Check accumulated signals for high-salience patterns
    if (this.accumulatedSignals.length > 0) {
      const regionCounts = new Map<string, number>();
      const highSeverity = this.accumulatedSignals.filter(s =>
        s.severity === 'critical' || s.severity === 'high'
      );

      for (const s of this.accumulatedSignals) {
        for (const r of s.regions) {
          regionCounts.set(r, (regionCounts.get(r) ?? 0) + 1);
        }
      }

      // Observation: high severity signals present
      if (highSeverity.length > 0) {
        observations.push({
          id: `obs-${Date.now()}-severity`,
          timestamp: Date.now(),
          summary: `${highSeverity.length} high/critical severity signals detected`,
          signals: [], // Will be populated after collapse
          salience: Math.min(100, highSeverity.length * 20),
          actionable: highSeverity.length >= 3,
        });
      }

      // Observation: regional concentration
      for (const [region, count] of regionCounts) {
        if (count >= 5) {
          observations.push({
            id: `obs-${Date.now()}-region-${region}`,
            timestamp: Date.now(),
            summary: `${count} signals concentrated in ${region}`,
            signals: [],
            salience: Math.min(100, count * 15),
            actionable: count >= 8,
          });
        }
      }

      // Clear accumulated after processing
      this.accumulatedSignals = [];
    }

    // Check memory for recurring high-severity patterns
    const recentMemory = this.memory.queryByTags(['critical', 'high'], 'session');
    if (recentMemory.length >= 3) {
      observations.push({
        id: `obs-${Date.now()}-memory-pattern`,
        timestamp: Date.now(),
        summary: `Recurring escalation pattern: ${recentMemory.length} recent memory entries`,
        signals: [],
        salience: 70,
        actionable: true,
      });
    }

    this.state.observations = observations;
    return observations;
  }

  /**
   * PLAN: Create or adjust goals based on observations.
   */
  private plan(observations: Observation[]): void {
    // Create goals from actionable observations
    for (const obs of observations) {
      if (obs.actionable && obs.salience >= this.config.salienceThreshold) {
        const goal = this.planner.createFromObservation(obs);
        if (goal) {
          this.state.activeGoals = this.planner.getActiveGoals();
        }
      }
    }

    // Ensure there's always at least one active goal
    if (this.planner.getActiveGoals().length === 0 && this.state.cycleCount > 1) {
      this.planner.createFromTemplate('gt-full-sweep', {
        rationale: 'Maintenance sweep — no active goals',
      });
    }
  }

  /**
   * ACT: Execute tasks from the planner, collect signals.
   */
  private async act(): Promise<Signal[]> {
    const allSignals: Signal[] = [];
    let tasksExecuted = 0;

    while (tasksExecuted < this.config.maxTasksPerCycle) {
      const next = this.planner.getNextTask();
      if (!next) break;

      const { task } = next;
      task.status = 'running';
      task.startedAt = Date.now();

      agentBus.emit('task:started', { taskId: task.id, toolId: task.toolId }, 'agent');

      try {
        const signals = await executeTool(task.toolId, task.toolInput);
        allSignals.push(...signals);

        const result: TaskResult = {
          success: true,
          output: { signalCount: signals.length },
          duration: Date.now() - task.startedAt,
        };

        this.planner.completeTask(task.id, result);
      } catch (err) {
        const result: TaskResult = {
          success: false,
          output: null,
          error: err instanceof Error ? err.message : String(err),
          duration: Date.now() - (task.startedAt ?? Date.now()),
        };

        this.planner.completeTask(task.id, result);

        // Try to retry
        this.planner.retryTask(task.id);
      }

      tasksExecuted++;
    }

    return allSignals;
  }

  /**
   * REFLECT: Learn from the cycle, update memory, adjust strategy.
   */
  private reflect(pipelineResult: PipelineRunResult | null): void {
    const reflections: Reflection[] = [];

    if (pipelineResult?.success && pipelineResult.brief) {
      const brief = pipelineResult.brief;

      // Store key findings in session memory
      for (const finding of brief.findings.slice(0, 5)) {
        this.memory.store('session', finding.summary, {
          data: {
            severity: finding.severity,
            regions: finding.regions,
            domains: finding.domains,
          },
          tags: [finding.severity, ...finding.regions, ...finding.domains],
          regions: finding.regions,
          importance: finding.severity === 'critical' ? 90
            : finding.severity === 'high' ? 70
            : finding.severity === 'medium' ? 50
            : 30,
        });
      }

      // Store focal points
      for (const fp of brief.focalPoints.slice(0, 3)) {
        this.memory.store('session', fp.narrative, {
          data: {
            entity: fp.entity,
            convergenceScore: fp.convergenceScore,
            trend: fp.trend,
          },
          tags: ['focal-point', fp.entity, fp.trend],
          regions: [fp.entity],
          importance: Math.min(100, fp.convergenceScore),
        });
      }

      // Synthesize structured report + sitrep for AI consumption
      this.lastReport = synthesizeReport(brief);
      const sitrep = synthesizeSitRep(brief);

      // Store sitrep in memory for cross-cycle context
      this.memory.store('session', sitrep, {
        tags: ['sitrep', brief.threatLevel, ...brief.domainsCovered],
        regions: [...new Set(brief.findings.flatMap(f => f.regions))],
        importance: brief.threatLevel === 'critical' ? 95 : brief.threatLevel === 'high' ? 80 : 50,
      });

      reflections.push({
        id: `reflect-${Date.now()}-pipeline`,
        timestamp: Date.now(),
        insight: `Pipeline produced ${brief.findings.length} findings, ${brief.focalPoints.length} focal points. Threat level: ${brief.threatLevel}. Report: ${this.lastReport.id}`,
        context: [pipelineResult.runId, this.lastReport.id],
        persist: brief.threatLevel === 'critical' || brief.threatLevel === 'high',
      });
    }

    // Check invariant violations
    if (pipelineResult?.verificationReports) {
      const totalViolations = pipelineResult.verificationReports.reduce(
        (sum, r) => sum + r.failed, 0
      );
      if (totalViolations > 0) {
        reflections.push({
          id: `reflect-${Date.now()}-invariants`,
          timestamp: Date.now(),
          insight: `${totalViolations} invariant violation(s) detected across pipeline stages`,
          context: [pipelineResult.runId],
          persist: totalViolations > 3,
        });
      }
    }

    // Promote memories
    const { promoted, demoted } = this.memory.promote();
    if (promoted > 0 || demoted > 0) {
      reflections.push({
        id: `reflect-${Date.now()}-memory`,
        timestamp: Date.now(),
        insight: `Memory maintenance: ${promoted} promoted, ${demoted} demoted`,
        context: [],
        persist: false,
      });
    }

    // Store persistent reflections
    for (const r of reflections) {
      if (r.persist) {
        this.memory.store('episodic', r.insight, {
          tags: ['reflection', ...r.context],
          importance: 60,
        });
      }
    }

    this.state.reflections = reflections;
  }

  // ──────────────────────────────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Group signals by domain for pipeline ingestion.
   */
  private groupSignalsByDomain(signals: Signal[]): IngestInput[] {
    const groups = new Map<string, Signal[]>();
    for (const s of signals) {
      if (!groups.has(s.domain)) groups.set(s.domain, []);
      groups.get(s.domain)!.push(s);
    }

    return [...groups.entries()].map(([domain, sigs]) => ({
      domain: domain as import('../types').SignalDomain,
      rawItems: sigs,
    }));
  }

  /**
   * Accept external signals (e.g., from existing services).
   */
  injectSignals(signals: Signal[]): void {
    this.accumulatedSignals.push(...signals);
  }

  private setupEventListeners(): void {
    // Log pipeline events
    agentBus.on('pipeline:complete', (event) => {
      const data = event.payload as Record<string, unknown>;
      console.log(`[Agent] Pipeline complete: ${data.findings} findings, threat=${data.threatLevel}, ${(data.duration as number)?.toFixed(0)}ms`);
    });

    agentBus.on('invariant:violation', (event) => {
      const v = event.payload as import('../types').InvariantViolation;
      if (v.severity === 'fatal' || v.severity === 'error') {
        console.warn(`[Agent] Invariant ${v.invariantId}: ${v.message}`);
      }
    });

    agentBus.on('goal:completed', (event) => {
      const data = event.payload as Record<string, unknown>;
      console.log(`[Agent] Goal completed: ${data.goalId}`);
    });
  }
}
