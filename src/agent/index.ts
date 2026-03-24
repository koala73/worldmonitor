/**
 * Agent Planning System — Public API
 *
 * This module exports the complete agent system for the WorldMonitor
 * intelligence platform. It replaces monolithic service orchestration
 * with a typed pipeline, invariant verification, cascade collapse,
 * and an Observe→Plan→Act→Reflect agent loop.
 *
 * Architecture:
 *   INGEST → ENCODE → FILTER → COLLAPSE → SYNTHESIZE → EMIT
 *
 * Usage:
 *   import { initAgent, startAgent, onBriefUpdate } from '@/agent';
 *
 *   const agent = initAgent({ cycleIntervalMs: 300_000 });
 *   startAgent();
 *   onBriefUpdate(brief => renderDashboard(brief));
 */

// Core types
export type {
  Signal,
  EncodedSignal,
  CollapsedSignal,
  SignalDomain,
  Severity,
  TrendDirection,
  PipelineContext,
  StageResult,
  Invariant,
  InvariantViolation,
  InvariantCheckContext,
  InvariantCategory,
  InvariantSeverity,
  CollapseRule,
  BusEvent,
  BusEventType,
  BusHandler,
  AgentState,
  AgentPhase,
  Observation,
  Reflection,
  Goal,
  GoalStatus,
  Task,
  TaskStatus,
  TaskPriority,
  TaskResult,
  ToolDefinition,
  MemoryEntry,
  MemorySnapshot,
  MemoryType,
  IntelligenceBrief,
  Finding,
  FocalPointBrief,
} from './types';

export { PipelineStage } from './types';

// Event bus
export { EventBus, agentBus } from './bus/event-bus';

// Pipeline
export { PipelineRunner } from './pipeline/runner';
export type { PipelineRunResult, PipelineRunConfig } from './pipeline/runner';
export {
  ingest,
  encode,
  filter,
  collapse,
  synthesize,
  DEFAULT_COLLAPSE_RULES,
} from './pipeline/stages';
export type { IngestInput, FilterConfig, SynthesisOutput } from './pipeline/stages';

// Invariants
export { INVARIANT_RULES, getInvariantsForStage } from './invariants/rules';
export { InvariantVerifier } from './invariants/verifier';
export type { VerificationReport } from './invariants/verifier';

// Memory
export { MemoryStore } from './memory/store';

// Tools
export {
  registerTool,
  getTool,
  getAllTools,
  getToolsByDomain,
  executeTool,
  createSignal,
} from './tools/registry';

// LLM tools are registered via side-effect import in bridge.ts
// (llm.classify, llm.brief, llm.synthesize)

// SP500 & Earnings
export { SP500_SECTORS, ALL_SP500_HOLDINGS, matchSectors } from './tools/sp500-sectors';
export type { SectorDefinition } from './tools/sp500-sectors';
export type { EarningsEvent, SectorEarningsMomentum } from './tools/earnings-capture';

// Planner
export { GoalDecomposer, GOAL_TEMPLATES } from './planner/decomposer';
export type { GoalTemplate, TaskSpec } from './planner/decomposer';

// Agent runtime
export { AgentRuntime } from './runtime/agent';
export type { AgentConfig } from './runtime/agent';

// Status & HUD
export {
  captureStatus,
  renderTerminalHUD,
  renderStatusLine,
  renderFindingsFeed,
  renderFocalPoints,
  renderBrief,
  severityClass,
  phaseClass,
  domainClass,
} from './runtime/status';
export type { StatusSnapshot } from './runtime/status';

// Action-Consequence Corpus
export {
  ACTION_CONSEQUENCE_CORPUS,
  getEntryById,
  getEntriesByTag,
  getEntriesByTags,
  traceConsequences,
  CORPUS_STATS,
} from './corpus/action-consequence';
export type { CausalEntry, Consequence } from './corpus/action-consequence';

// Corpus Synthesizer
export {
  synthesizeReport,
  synthesizeSitRep,
  synthesizeCausalTrace,
} from './corpus/synthesizer';
export type { SynthesizedReport, ReportMeta } from './corpus/synthesizer';

// Meteorological Supply Chain (registered via side-effect import in bridge.ts)
export { SHIPPING_LANES, AGRI_ZONES, ENERGY_NODES } from './tools/meteo-supply-chain';

// Diagnostics
export { runDiagnostics } from './diagnostics';

// Bridge (App.ts integration)
export {
  initAgent,
  startAgent,
  stopAgent,
  getLatestBrief,
  getAgentState,
  onBriefUpdate,
  onPhaseChange,
  injectNewsSignals,
  injectMilitarySignals,
  injectOutageSignals,
  injectUnrestSignals,
  destroyAgent,
} from './bridge';
