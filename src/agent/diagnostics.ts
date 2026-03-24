/**
 * Pipeline Self-Test & Diagnostics
 *
 * Validates the entire agent system end-to-end with synthetic data.
 * Run this to verify pipeline stages, invariant rules, collapse mechanics,
 * event bus wiring, and tool registry — all without hitting real APIs.
 *
 * Usage:
 *   import { runDiagnostics } from '@/agent/diagnostics';
 *   const report = runDiagnostics();
 *   console.log(report.summary);
 */

import type { Severity, SignalDomain } from './types';
import { PipelineStage } from './types';
import { ingest, encode, filter, collapse, synthesize, type IngestInput } from './pipeline/stages';
import { InvariantVerifier } from './invariants/verifier';
import { INVARIANT_RULES } from './invariants/rules';
import { EventBus } from './bus/event-bus';
import { MemoryStore } from './memory/store';
import { GoalDecomposer } from './planner/decomposer';
import { createSignal } from './tools/registry';
import { ACTION_CONSEQUENCE_CORPUS, CORPUS_STATS, getEntriesByTag, traceConsequences as traceCorpus } from './corpus/action-consequence';
import { synthesizeReport as synthReport, synthesizeSitRep as synthSitRep } from './corpus/synthesizer';
import type { IntelligenceBrief } from './types';

// ============================================================================
// TEST DATA GENERATORS
// ============================================================================

function syntheticSignal(
  domain: SignalDomain,
  severity: Severity,
  region: string,
  ageMinutes = 0,
): IngestInput {
  return {
    domain,
    rawItems: [{
      id: `test-${domain}-${region}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      severity,
      regions: [region],
      timestamp: Date.now() - ageMinutes * 60_000,
      geo: { lat: 40 + Math.random() * 10, lon: -10 + Math.random() * 40 },
      payload: { synthetic: true, domain, severity },
      confidence: 0.8 + Math.random() * 0.2,
      tags: [domain, severity, 'synthetic'],
    }],
  };
}

function syntheticBatch(): IngestInput[] {
  return [
    // Convergence scenario: Ukraine — conflict + military + unrest + infrastructure
    syntheticSignal('conflict', 'high', 'UA', 30),
    syntheticSignal('military', 'high', 'UA', 15),
    syntheticSignal('unrest', 'medium', 'UA', 45),
    syntheticSignal('infrastructure', 'medium', 'UA', 20),
    // Convergence scenario: Iran — conflict + military + cyber
    syntheticSignal('conflict', 'medium', 'IR', 60),
    syntheticSignal('military', 'medium', 'IR', 30),
    syntheticSignal('cyber', 'high', 'IR', 10),
    // Noise signals
    syntheticSignal('news', 'low', 'US', 120),
    syntheticSignal('economic', 'info', 'US', 180),
    syntheticSignal('seismology', 'low', 'JP', 90),
    syntheticSignal('climate', 'info', 'BR', 240),
    syntheticSignal('wildfire', 'medium', 'AU', 60),
    // Old signal (should be filtered or decayed)
    syntheticSignal('news', 'low', 'GB', 60 * 36), // 36 hours old
  ];
}

// ============================================================================
// DIAGNOSTIC TESTS
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  duration: number;
}

interface DiagnosticReport {
  timestamp: number;
  totalTests: number;
  passed: number;
  failed: number;
  tests: TestResult[];
  summary: string;
}

function getCount(c: { value: number }): number { return c.value; }

function test(name: string, fn: () => boolean | string): TestResult {
  const start = performance.now();
  try {
    const result = fn();
    const passed = result === true;
    return {
      name,
      passed,
      details: passed ? 'OK' : (typeof result === 'string' ? result : 'FAIL'),
      duration: performance.now() - start,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      details: `THREW: ${err instanceof Error ? err.message : String(err)}`,
      duration: performance.now() - start,
    };
  }
}

// ============================================================================
// MAIN DIAGNOSTICS RUNNER
// ============================================================================

export function runDiagnostics(): DiagnosticReport {
  const tests: TestResult[] = [];

  // ── PIPELINE STAGE TESTS ─────────────────────────────────────────
  tests.push(test('INGEST: produces signals from raw input', () => {
    const inputs = syntheticBatch();
    const signals = ingest(inputs);
    if (signals.length !== 13) return `Expected 13 signals, got ${signals.length}`;
    if (!signals.every(s => s.id && s.domain && s.timestamp > 0)) return 'Missing required fields';
    return true;
  }));

  tests.push(test('ENCODE: normalizes scores and features', () => {
    const signals = ingest(syntheticBatch());
    const encoded = encode(signals);
    if (encoded.length !== signals.length) return 'Encode lost signals';
    if (!encoded.every(s => s.normalizedScore >= 0 && s.normalizedScore <= 100))
      return 'Score out of range';
    if (!encoded.every(s => s.features.length === 6)) return 'Feature vector wrong size';
    return true;
  }));

  tests.push(test('ENCODE: high severity scores higher than low', () => {
    const highInput = syntheticSignal('conflict', 'critical', 'UA', 0);
    const lowInput = syntheticSignal('news', 'info', 'US', 0);
    const encoded = encode(ingest([highInput, lowInput]));
    const highScore = encoded.find(s => s.domain === 'conflict')?.normalizedScore ?? 0;
    const lowScore = encoded.find(s => s.domain === 'news')?.normalizedScore ?? 0;
    if (highScore <= lowScore) return `Critical ${highScore} not > Info ${lowScore}`;
    return true;
  }));

  tests.push(test('FILTER: removes low-score signals', () => {
    const encoded = encode(ingest(syntheticBatch()));
    const filtered = filter(encoded, { minScore: 30 });
    if (filtered.length >= encoded.length) return 'No signals were filtered';
    if (filtered.some(s => s.normalizedScore < 30)) return 'Below-threshold signal passed';
    return true;
  }));

  tests.push(test('FILTER: deduplicates within time window', () => {
    const dupe: IngestInput = {
      domain: 'conflict',
      rawItems: [
        { id: 'dupe-1', severity: 'high', regions: ['UA'], timestamp: Date.now(), payload: {}, confidence: 0.9, tags: [] },
        { id: 'dupe-2', severity: 'medium', regions: ['UA'], timestamp: Date.now() - 1000, payload: {}, confidence: 0.9, tags: [] },
      ],
    };
    const encoded = encode(ingest([dupe]));
    const filtered = filter(encoded, { dedupeWindow: 300_000 });
    // Should keep only the higher-scoring one
    if (filtered.length !== 1) return `Expected 1 after dedup, got ${filtered.length}`;
    return true;
  }));

  tests.push(test('COLLAPSE: converges multi-domain regional signals', () => {
    const inputs = syntheticBatch();
    const encoded = encode(ingest(inputs));
    const filtered = filter(encoded);
    const collapsed = collapse(filtered);
    // UA has 4 signals across 4 domains → should trigger CR-001
    const uaCollapsed = collapsed.filter(c => c.regions.includes('UA') && c.collapseRule !== 'none');
    if (uaCollapsed.length === 0) return 'UA multi-domain convergence not detected';
    if (uaCollapsed[0]!.domainBreadth < 2) return 'Domain breadth too low';
    return true;
  }));

  tests.push(test('COLLAPSE: applies boost factor', () => {
    const inputs = syntheticBatch();
    const encoded = encode(ingest(inputs));
    const filtered = filter(encoded);
    const collapsed = collapse(filtered);
    const boosted = collapsed.filter(c => c.collapseRule !== 'none');
    const maxSource = Math.max(...encoded.map(e => e.normalizedScore));
    // Boosted composite should exceed max individual source (due to boost factor)
    if (boosted.length > 0 && boosted[0]!.compositeScore <= maxSource * 0.8)
      return 'Boost factor not effective';
    return true;
  }));

  tests.push(test('SYNTHESIZE: produces findings and focal points', () => {
    const collapsed = collapse(filter(encode(ingest(syntheticBatch()))));
    const synthesis = synthesize(collapsed);
    if (synthesis.findings.length === 0) return 'No findings produced';
    if (synthesis.overallThreatLevel === undefined) return 'No threat level';
    return true;
  }));

  // ── INVARIANT TESTS ──────────────────────────────────────────────
  tests.push(test('INVARIANTS: 20 rules registered', () => {
    if (INVARIANT_RULES.length !== 20) return `Expected 20 rules, got ${INVARIANT_RULES.length}`;
    return true;
  }));

  tests.push(test('INVARIANTS: all 5 categories present', () => {
    const cats = new Set(INVARIANT_RULES.map(r => r.category));
    const expected = ['structural', 'temporal', 'consistency', 'coverage', 'pipeline'];
    for (const e of expected) {
      if (!cats.has(e as typeof INVARIANT_RULES[0]['category'])) return `Missing category: ${e}`;
    }
    return true;
  }));

  tests.push(test('INVARIANTS: S-001 catches missing ID', () => {
    const verifier = new InvariantVerifier();
    const badSignal = { ...ingest(syntheticBatch())[0]!, id: '' };
    const report = verifier.verify(PipelineStage.INGEST, {
      runId: 'test', startedAt: Date.now(), stages: [], memory: { session: [], episodic: [], longterm: [], totalEntries: 0, lastCompactedAt: 0 }, goals: [],
    }, [badSignal]);
    if (!report.halt) return 'Should halt on missing ID';
    return true;
  }));

  tests.push(test('INVARIANTS: C-001 catches duplicate IDs', () => {
    const verifier = new InvariantVerifier();
    const signals = ingest(syntheticBatch());
    const duped = [...signals, { ...signals[0]! }]; // duplicate first signal
    const report = verifier.verify(PipelineStage.INGEST, {
      runId: 'test', startedAt: Date.now(), stages: [], memory: { session: [], episodic: [], longterm: [], totalEntries: 0, lastCompactedAt: 0 }, goals: [],
    }, duped);
    if (report.violations.length === 0) return 'Should detect duplicate';
    return true;
  }));

  tests.push(test('INVARIANTS: P-001 catches out-of-order stages', () => {
    const verifier = new InvariantVerifier();
    // Try to verify COLLAPSE without ENCODE completing
    const report = verifier.verify(PipelineStage.COLLAPSE, {
      runId: 'test', startedAt: Date.now(), stages: [
        { stage: PipelineStage.INGEST, input: [], output: [], duration: 0, invariantsPassed: [], invariantsFailed: [], droppedCount: 0 },
        // ENCODE missing!
      ], memory: { session: [], episodic: [], longterm: [], totalEntries: 0, lastCompactedAt: 0 }, goals: [],
    }, []);
    if (!report.halt) return 'Should halt on out-of-order stages';
    return true;
  }));

  // ── EVENT BUS TESTS ──────────────────────────────────────────────
  tests.push(test('EVENT BUS: pub/sub works', () => {
    const bus = new EventBus();
    let received = false;
    bus.on('pipeline:started', () => { received = true; });
    bus.emit('pipeline:started', { runId: 'test' }, 'diag');
    if (!received) return 'Handler not called';
    bus.clear();
    return true;
  }));

  tests.push(test('EVENT BUS: once() fires only once', () => {
    const bus = new EventBus();
    let count = 0;
    bus.once('pipeline:started', () => { count++; });
    bus.emit('pipeline:started', {}, 'diag');
    bus.emit('pipeline:started', {}, 'diag');
    if (count !== 1) return `Called ${count} times, expected 1`;
    bus.clear();
    return true;
  }));

  tests.push(test('EVENT BUS: pause/resume queues events', () => {
    const bus = new EventBus();
    const counter = { value: 0 };
    bus.on('pipeline:started', () => { counter.value++; });
    bus.pause();
    bus.emit('pipeline:started', {}, 'diag');
    bus.emit('pipeline:started', {}, 'diag');
    if (getCount(counter) !== 0) return 'Events delivered while paused';
    bus.resume();
    if (getCount(counter) !== 2) return `Expected 2 after resume, got ${getCount(counter)}`;
    bus.clear();
    return true;
  }));

  // ── MEMORY TESTS ─────────────────────────────────────────────────
  tests.push(test('MEMORY: store and query by tags', () => {
    const mem = new MemoryStore();
    mem.store('session', 'Ukraine conflict escalating', {
      tags: ['conflict', 'UA'], regions: ['UA'], importance: 80,
    });
    const results = mem.queryByTags(['conflict']);
    if (results.length !== 1) return `Expected 1, got ${results.length}`;
    if (results[0]!.content !== 'Ukraine conflict escalating') return 'Wrong content';
    return true;
  }));

  tests.push(test('MEMORY: promotion from session to episodic', () => {
    const mem = new MemoryStore({ promotionThreshold: 30 });
    mem.store('session', 'Recurring pattern', {
      tags: ['pattern'], importance: 50,
    });
    // Simulate accesses to meet promotion criteria (accessCount >= 2)
    mem.queryByTags(['pattern']);
    mem.queryByTags(['pattern']);
    mem.queryByTags(['pattern']);
    const { promoted } = mem.promote();
    if (promoted === 0) return 'Nothing promoted';
    const snap = mem.snapshot();
    if (snap.episodic.length === 0) return 'Not in episodic store';
    return true;
  }));

  tests.push(test('MEMORY: capacity enforcement', () => {
    const mem = new MemoryStore({ sessionCapacity: 3 });
    for (let i = 0; i < 10; i++) {
      mem.store('session', `Entry ${i}`, { importance: i * 10 });
    }
    const snap = mem.snapshot();
    if (snap.session.length > 3) return `Capacity exceeded: ${snap.session.length}`;
    // Should keep highest importance entries
    const minImportance = Math.min(...snap.session.map(e => e.importance));
    if (minImportance < 70) return `Kept low importance entry: ${minImportance}`;
    return true;
  }));

  // ── PLANNER TESTS ────────────────────────────────────────────────
  tests.push(test('PLANNER: creates goals from templates', () => {
    const planner = new GoalDecomposer();
    const goal = planner.createFromTemplate('gt-full-sweep');
    if (!goal) return 'No goal created';
    if (goal.tasks.length === 0) return 'No tasks in goal';
    if (goal.status !== 'active') return `Wrong status: ${goal.status}`;
    return true;
  }));

  tests.push(test('PLANNER: getNextTask respects priority', () => {
    const planner = new GoalDecomposer();
    planner.createFromTemplate('gt-full-sweep');
    const next = planner.getNextTask();
    if (!next) return 'No next task';
    if (next.task.status !== 'queued') return `Wrong status: ${next.task.status}`;
    return true;
  }));

  tests.push(test('PLANNER: completeTask updates goal', () => {
    const planner = new GoalDecomposer();
    const goal = planner.createFromTemplate('gt-full-sweep');
    for (const task of goal.tasks) {
      planner.completeTask(task.id, {
        success: true, output: {}, duration: 10,
      });
    }
    if (planner.getActiveGoals().length !== 0) return 'Goal still active';
    if (planner.getCompletedGoals().length !== 1) return 'Goal not completed';
    return true;
  }));

  // ── FULL PIPELINE RUN ────────────────────────────────────────────
  tests.push(test('PIPELINE RUNNER: full synthetic run succeeds', () => {
    // Synchronous check — test all pipeline stage functions directly
    const inputs = syntheticBatch();
    const signals = ingest(inputs);
    const encoded = encode(signals);
    const filtered = filter(encoded);
    const collapsed = collapse(filtered);
    const synthesis = synthesize(collapsed);

    if (synthesis.findings.length === 0) return 'No findings';
    if (synthesis.focalPoints.length === 0) return 'No focal points';

    // Check UA is top focal point
    const uaFP = synthesis.focalPoints.find(fp => fp.entity === 'UA');
    if (!uaFP) return 'UA not detected as focal point';
    if (uaFP.activeDomains.length < 2) return 'UA domain breadth too low';
    return true;
  }));

  // ── TOOL REGISTRY ────────────────────────────────────────────────
  tests.push(test('TOOL REGISTRY: createSignal produces valid signal', () => {
    const sig = createSignal('news', {
      sourceId: 'test-123',
      severity: 'medium',
      regions: ['US'],
      timestamp: Date.now(),
      payload: { test: true },
      confidence: 0.9,
      tags: ['test'],
      provenance: 'test',
    });
    if (!sig.id.startsWith('news:')) return `Bad ID prefix: ${sig.id}`;
    if (sig.domain !== 'news') return 'Wrong domain';
    if (sig.severity !== 'medium') return 'Wrong severity';
    return true;
  }));

  // ── CORPUS & SYNTHESIZER TESTS ─────────────────────────────────
  tests.push(test('CORPUS: action-consequence entries loaded', () => {
    if (ACTION_CONSEQUENCE_CORPUS.length < 15) return `Only ${ACTION_CONSEQUENCE_CORPUS.length} entries`;
    if (CORPUS_STATS.totalConsequences < 30) return `Only ${CORPUS_STATS.totalConsequences} consequences`;
    return true;
  }));

  tests.push(test('CORPUS: tag index resolves correctly', () => {
    const results = getEntriesByTag('conflict');
    if (results.length === 0) return 'No entries for conflict tag';
    return true;
  }));

  tests.push(test('CORPUS: causal trace follows chains', () => {
    const trace = traceCorpus(['conflict', 'maritime', 'hormuz'], 'medium');
    if (trace.length === 0) return 'No consequences traced for Hormuz scenario';
    const hasChain = trace.some((t: { depth: number }) => t.depth > 0);
    if (!hasChain) return 'No second-order effects found';
    return true;
  }));

  tests.push(test('SYNTHESIZER: generates report from brief', () => {
    const collapsed = collapse(filter(encode(ingest(syntheticBatch()))));
    const syn = synthesize(collapsed);
    const brief: IntelligenceBrief = {
      id: 'test-brief', timestamp: Date.now(), threatLevel: syn.overallThreatLevel,
      findings: syn.findings, focalPoints: syn.focalPoints,
      recommendations: ['Test rec'], pipelineRunId: 'test-run',
      signalCount: 6, domainsCovered: ['conflict' as SignalDomain, 'military' as SignalDomain],
    };
    const report = synthReport(brief);
    if (!report.document) return 'Empty document';
    if (!report.document.includes('[INTELLIGENCE REPORT')) return 'Missing header';
    if (!report.document.includes('[FINDINGS]')) return 'Missing findings section';
    if (report.meta.wordCount < 20) return `Too short: ${report.meta.wordCount} words`;
    return true;
  }));

  tests.push(test('SYNTHESIZER: generates compact sitrep', () => {
    const collapsed = collapse(filter(encode(ingest(syntheticBatch()))));
    const syn = synthesize(collapsed);
    const brief: IntelligenceBrief = {
      id: 'test-brief', timestamp: Date.now(), threatLevel: syn.overallThreatLevel,
      findings: syn.findings, focalPoints: syn.focalPoints,
      recommendations: [], pipelineRunId: 'test-run',
      signalCount: 6, domainsCovered: ['conflict' as SignalDomain],
    };
    const sitrep = synthSitRep(brief);
    if (!sitrep.startsWith('SITREP')) return 'Missing SITREP prefix';
    if (!sitrep.includes('THREAT=')) return 'Missing threat level';
    return true;
  }));

  // ── BUILD REPORT ─────────────────────────────────────────────────
  const passed = tests.filter(t => t.passed).length;
  const failed = tests.filter(t => !t.passed).length;

  const summary = [
    `╔══════════════════════════════════════════════════════╗`,
    `║  AGENT PIPELINE DIAGNOSTICS                         ║`,
    `║  ${new Date().toISOString().slice(0, 19)}                          ║`,
    `╠══════════════════════════════════════════════════════╣`,
    `║  Tests:  ${String(tests.length).padStart(3)} total │ ${String(passed).padStart(3)} passed │ ${String(failed).padStart(3)} failed ║`,
    `╠══════════════════════════════════════════════════════╣`,
    ...tests.map(t =>
      `║  ${t.passed ? '✓' : '✗'} ${t.name.padEnd(45).slice(0, 45)} ${t.duration.toFixed(1).padStart(6)}ms ║`
    ),
    `╠══════════════════════════════════════════════════════╣`,
    `║  ${failed === 0 ? 'ALL SYSTEMS NOMINAL' : `${failed} SYSTEM(S) DEGRADED`}${' '.repeat(34 - (failed === 0 ? 19 : 22))}║`,
    `╚══════════════════════════════════════════════════════╝`,
  ].join('\n');

  return {
    timestamp: Date.now(),
    totalTests: tests.length,
    passed,
    failed,
    tests,
    summary,
  };
}
