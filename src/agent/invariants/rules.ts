/**
 * Invariant Verification Framework
 *
 * 20 validation rules organized in 5 categories, each with severity levels.
 * Every pipeline stage is verified against applicable invariants.
 * Fatal violations halt the pipeline. Errors are logged and degrade gracefully.
 *
 * Categories:
 *   S — Structural  (data shape, required fields)
 *   T — Temporal     (time ordering, freshness, staleness)
 *   C — Consistency  (cross-signal logic, domain coherence)
 *   V — Coverage     (minimum domain breadth, geographic spread)
 *   P — Pipeline     (stage ordering, completeness, throughput)
 */

import {
  type Invariant,
  type InvariantViolation,
  type InvariantSeverity,
  PipelineStage,
} from '../types';

// ============================================================================
// HELPERS
// ============================================================================

function violation(
  id: string,
  severity: InvariantSeverity,
  message: string,
  details?: Record<string, unknown>
): InvariantViolation {
  return { invariantId: id, severity, message, details, halt: severity === 'fatal' };
}

// ============================================================================
// STRUCTURAL INVARIANTS (S-001 through S-004)
// ============================================================================

const S001_SignalHasId: Invariant = {
  id: 'S-001',
  name: 'Signal ID Required',
  category: 'structural',
  severity: 'fatal',
  stages: [PipelineStage.INGEST, PipelineStage.ENCODE],
  check: (ctx) => {
    const missing = ctx.signals.filter(s => !s.id || typeof s.id !== 'string');
    if (missing.length > 0) {
      return violation('S-001', 'fatal', `${missing.length} signal(s) missing ID`, {
        count: missing.length,
      });
    }
    return null;
  },
};

const S002_SignalHasDomain: Invariant = {
  id: 'S-002',
  name: 'Signal Domain Required',
  category: 'structural',
  severity: 'fatal',
  stages: [PipelineStage.INGEST],
  check: (ctx) => {
    const missing = ctx.signals.filter(s => !s.domain);
    if (missing.length > 0) {
      return violation('S-002', 'fatal', `${missing.length} signal(s) missing domain`, {
        ids: missing.map(s => s.id),
      });
    }
    return null;
  },
};

const S003_SignalHasTimestamp: Invariant = {
  id: 'S-003',
  name: 'Signal Timestamp Required',
  category: 'structural',
  severity: 'error',
  stages: [PipelineStage.INGEST],
  check: (ctx) => {
    const missing = ctx.signals.filter(s => !s.timestamp || s.timestamp <= 0);
    if (missing.length > 0) {
      return violation('S-003', 'error', `${missing.length} signal(s) with invalid timestamp`, {
        ids: missing.map(s => s.id),
      });
    }
    return null;
  },
};

const S004_EncodedHasScore: Invariant = {
  id: 'S-004',
  name: 'Encoded Signal Score Required',
  category: 'structural',
  severity: 'error',
  stages: [PipelineStage.ENCODE],
  check: (ctx) => {
    if (!ctx.encoded) return null;
    const bad = ctx.encoded.filter(
      s => typeof s.normalizedScore !== 'number' || s.normalizedScore < 0 || s.normalizedScore > 100
    );
    if (bad.length > 0) {
      return violation('S-004', 'error', `${bad.length} encoded signal(s) with invalid score`, {
        ids: bad.map(s => s.id),
      });
    }
    return null;
  },
};

// ============================================================================
// TEMPORAL INVARIANTS (T-001 through T-004)
// ============================================================================

const T001_NoFutureSignals: Invariant = {
  id: 'T-001',
  name: 'No Future Timestamps',
  category: 'temporal',
  severity: 'warning',
  stages: [PipelineStage.INGEST],
  check: (ctx) => {
    const now = Date.now() + 60_000; // 1 minute tolerance
    const future = ctx.signals.filter(s => s.timestamp > now);
    if (future.length > 0) {
      return violation('T-001', 'warning', `${future.length} signal(s) have future timestamps`, {
        ids: future.map(s => s.id),
        maxDrift: Math.max(...future.map(s => s.timestamp - now)),
      });
    }
    return null;
  },
};

const T002_Freshness: Invariant = {
  id: 'T-002',
  name: 'Signal Freshness Check',
  category: 'temporal',
  severity: 'warning',
  stages: [PipelineStage.FILTER],
  check: (ctx) => {
    const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    const stale = ctx.signals.filter(s => now - s.timestamp > staleThreshold);
    const ratio = ctx.signals.length > 0 ? stale.length / ctx.signals.length : 0;
    if (ratio > 0.5) {
      return violation('T-002', 'warning',
        `${(ratio * 100).toFixed(0)}% of signals are stale (>24h old)`, {
          staleCount: stale.length,
          totalCount: ctx.signals.length,
        });
    }
    return null;
  },
};

const T003_MonotonicIngestion: Invariant = {
  id: 'T-003',
  name: 'Monotonic Ingestion Order',
  category: 'temporal',
  severity: 'info',
  stages: [PipelineStage.INGEST],
  check: (ctx) => {
    for (let i = 1; i < ctx.signals.length; i++) {
      if (ctx.signals[i]!.ingestedAt < ctx.signals[i - 1]!.ingestedAt) {
        return violation('T-003', 'info', 'Ingestion timestamps are not monotonically increasing', {
          indexA: i - 1,
          indexB: i,
        });
      }
    }
    return null;
  },
};

const T004_PipelineDuration: Invariant = {
  id: 'T-004',
  name: 'Pipeline Duration Bound',
  category: 'temporal',
  severity: 'warning',
  stages: [PipelineStage.EMIT],
  check: (ctx) => {
    const elapsed = Date.now() - ctx.pipeline.startedAt;
    if (elapsed > 30_000) { // 30 seconds
      return violation('T-004', 'warning',
        `Pipeline run took ${(elapsed / 1000).toFixed(1)}s (>30s budget)`, {
          elapsed,
          runId: ctx.pipeline.runId,
        });
    }
    return null;
  },
};

// ============================================================================
// CONSISTENCY INVARIANTS (C-001 through C-004)
// ============================================================================

const C001_NoDuplicateIds: Invariant = {
  id: 'C-001',
  name: 'No Duplicate Signal IDs',
  category: 'consistency',
  severity: 'error',
  stages: [PipelineStage.INGEST, PipelineStage.ENCODE],
  check: (ctx) => {
    const ids = new Set<string>();
    const dupes: string[] = [];
    for (const s of ctx.signals) {
      if (ids.has(s.id)) dupes.push(s.id);
      ids.add(s.id);
    }
    if (dupes.length > 0) {
      return violation('C-001', 'error', `${dupes.length} duplicate signal ID(s)`, {
        duplicates: dupes.slice(0, 10),
      });
    }
    return null;
  },
};

const C002_SeverityConsistency: Invariant = {
  id: 'C-002',
  name: 'Severity-Score Consistency',
  category: 'consistency',
  severity: 'warning',
  stages: [PipelineStage.ENCODE],
  check: (ctx) => {
    if (!ctx.encoded) return null;
    const inconsistent = ctx.encoded.filter(s => {
      if (s.severity === 'critical' && s.normalizedScore < 50) return true;
      if (s.severity === 'info' && s.normalizedScore > 60) return true;
      return false;
    });
    if (inconsistent.length > 0) {
      return violation('C-002', 'warning',
        `${inconsistent.length} signal(s) have severity/score mismatch`, {
          ids: inconsistent.map(s => s.id),
        });
    }
    return null;
  },
};

const C003_RegionValidation: Invariant = {
  id: 'C-003',
  name: 'Region Code Validity',
  category: 'consistency',
  severity: 'warning',
  stages: [PipelineStage.INGEST],
  check: (ctx) => {
    const isoPattern = /^[A-Z]{2}$/;
    const invalid = ctx.signals.filter(
      s => s.regions.length > 0 && s.regions.some(r => !isoPattern.test(r))
    );
    if (invalid.length > 0) {
      return violation('C-003', 'warning',
        `${invalid.length} signal(s) with non-ISO region codes`, {
          examples: invalid.slice(0, 5).map(s => ({ id: s.id, regions: s.regions })),
        });
    }
    return null;
  },
};

const C004_CollapseSourceIntegrity: Invariant = {
  id: 'C-004',
  name: 'Collapse Source Integrity',
  category: 'consistency',
  severity: 'error',
  stages: [PipelineStage.COLLAPSE],
  check: (ctx) => {
    if (!ctx.collapsed) return null;
    const broken = ctx.collapsed.filter(c => c.sources.length === 0);
    if (broken.length > 0) {
      return violation('C-004', 'error',
        `${broken.length} collapsed signal(s) with empty sources`, {
          ids: broken.map(c => c.id),
        });
    }
    return null;
  },
};

// ============================================================================
// COVERAGE INVARIANTS (V-001 through V-004)
// ============================================================================

const V001_MinimumDomainBreadth: Invariant = {
  id: 'V-001',
  name: 'Minimum Domain Breadth',
  category: 'coverage',
  severity: 'warning',
  stages: [PipelineStage.FILTER],
  check: (ctx) => {
    const domains = new Set(ctx.signals.map(s => s.domain));
    if (domains.size < 3) {
      return violation('V-001', 'warning',
        `Only ${domains.size} domain(s) represented (minimum 3 recommended)`, {
          domains: [...domains],
        });
    }
    return null;
  },
};

const V002_MinimumSignalCount: Invariant = {
  id: 'V-002',
  name: 'Minimum Signal Count',
  category: 'coverage',
  severity: 'info',
  stages: [PipelineStage.FILTER],
  check: (ctx) => {
    if (ctx.signals.length < 5) {
      return violation('V-002', 'info',
        `Only ${ctx.signals.length} signal(s) — analysis may be sparse`, {
          count: ctx.signals.length,
        });
    }
    return null;
  },
};

const V003_GeographicSpread: Invariant = {
  id: 'V-003',
  name: 'Geographic Spread',
  category: 'coverage',
  severity: 'info',
  stages: [PipelineStage.FILTER],
  check: (ctx) => {
    const regions = new Set(ctx.signals.flatMap(s => s.regions));
    if (ctx.signals.length > 10 && regions.size < 2) {
      return violation('V-003', 'info',
        `${ctx.signals.length} signals but only ${regions.size} region(s)`, {
          regions: [...regions],
        });
    }
    return null;
  },
};

const V004_CriticalDomainPresence: Invariant = {
  id: 'V-004',
  name: 'Critical Domain Presence',
  category: 'coverage',
  severity: 'warning',
  stages: [PipelineStage.SYNTHESIZE],
  check: (ctx) => {
    const domains = new Set(ctx.signals.map(s => s.domain));
    const critical = ['news', 'conflict', 'military'] as const;
    const missing = critical.filter(d => !domains.has(d));
    if (missing.length > 0) {
      return violation('V-004', 'warning',
        `Missing critical domain(s): ${missing.join(', ')}`, {
          missingDomains: missing,
        });
    }
    return null;
  },
};

// ============================================================================
// PIPELINE INVARIANTS (P-001 through P-004)
// ============================================================================

const P001_StageOrdering: Invariant = {
  id: 'P-001',
  name: 'Stage Ordering',
  category: 'pipeline',
  severity: 'fatal',
  stages: [
    PipelineStage.ENCODE,
    PipelineStage.FILTER,
    PipelineStage.COLLAPSE,
    PipelineStage.SYNTHESIZE,
    PipelineStage.EMIT,
  ],
  check: (ctx) => {
    const order = [
      PipelineStage.INGEST,
      PipelineStage.ENCODE,
      PipelineStage.FILTER,
      PipelineStage.COLLAPSE,
      PipelineStage.SYNTHESIZE,
      PipelineStage.EMIT,
    ];
    const completed = ctx.pipeline.stages.map(s => s.stage);
    const currentIdx = order.indexOf(ctx.stage);
    const expectedPrevious = order.slice(0, currentIdx);

    for (const expected of expectedPrevious) {
      if (!completed.includes(expected)) {
        return violation('P-001', 'fatal',
          `Stage ${ctx.stage} requires ${expected} to complete first`, {
            currentStage: ctx.stage,
            missingStage: expected,
            completedStages: completed,
          });
      }
    }
    return null;
  },
};

const P002_NoSignalLoss: Invariant = {
  id: 'P-002',
  name: 'No Unexplained Signal Loss',
  category: 'pipeline',
  severity: 'warning',
  stages: [PipelineStage.FILTER],
  check: (ctx) => {
    const prevStage = ctx.pipeline.stages.find(s => s.stage === PipelineStage.ENCODE);
    if (!prevStage) return null;

    const prevCount = Array.isArray(prevStage.output) ? (prevStage.output as unknown[]).length : 0;
    const currentCount = ctx.signals.length;
    const dropRatio = prevCount > 0 ? 1 - currentCount / prevCount : 0;

    if (dropRatio > 0.9) {
      return violation('P-002', 'warning',
        `${(dropRatio * 100).toFixed(0)}% of signals dropped in FILTER stage`, {
          inputCount: prevCount,
          outputCount: currentCount,
          dropRatio,
        });
    }
    return null;
  },
};

const P003_CollapseReduction: Invariant = {
  id: 'P-003',
  name: 'Collapse Produces Reduction',
  category: 'pipeline',
  severity: 'info',
  stages: [PipelineStage.COLLAPSE],
  check: (ctx) => {
    if (!ctx.encoded || !ctx.collapsed) return null;
    if (ctx.collapsed.length >= ctx.encoded.length && ctx.encoded.length > 1) {
      return violation('P-003', 'info',
        'COLLAPSE stage produced no reduction — signals may lack convergence', {
          inputCount: ctx.encoded.length,
          outputCount: ctx.collapsed.length,
        });
    }
    return null;
  },
};

const P004_EmitNonEmpty: Invariant = {
  id: 'P-004',
  name: 'Emit Non-Empty',
  category: 'pipeline',
  severity: 'warning',
  stages: [PipelineStage.EMIT],
  check: (ctx) => {
    if (!ctx.collapsed || ctx.collapsed.length === 0) {
      return violation('P-004', 'warning',
        'Pipeline produced no output signals', {
          totalInput: ctx.signals.length,
        });
    }
    return null;
  },
};

// ============================================================================
// RULE REGISTRY
// ============================================================================

export const INVARIANT_RULES: Invariant[] = [
  // Structural (S)
  S001_SignalHasId,
  S002_SignalHasDomain,
  S003_SignalHasTimestamp,
  S004_EncodedHasScore,
  // Temporal (T)
  T001_NoFutureSignals,
  T002_Freshness,
  T003_MonotonicIngestion,
  T004_PipelineDuration,
  // Consistency (C)
  C001_NoDuplicateIds,
  C002_SeverityConsistency,
  C003_RegionValidation,
  C004_CollapseSourceIntegrity,
  // Coverage (V)
  V001_MinimumDomainBreadth,
  V002_MinimumSignalCount,
  V003_GeographicSpread,
  V004_CriticalDomainPresence,
  // Pipeline (P)
  P001_StageOrdering,
  P002_NoSignalLoss,
  P003_CollapseReduction,
  P004_EmitNonEmpty,
];

/**
 * Get all invariants applicable to a given stage.
 */
export function getInvariantsForStage(stage: PipelineStage): Invariant[] {
  return INVARIANT_RULES.filter(r => r.stages.includes(stage));
}
