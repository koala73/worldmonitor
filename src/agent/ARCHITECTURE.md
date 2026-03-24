# Agent Planning System — Architecture

> Supersedes the monolithic App.ts orchestration with a typed pipeline,
> invariant verification, cascade collapse, and an agent planning loop.

## System Overview

```
                    ┌─────────────────────────────────────────────┐
                    │              AGENT RUNTIME                   │
                    │         Observe → Plan → Act → Reflect       │
                    └─────────────┬───────────────────┬───────────┘
                                  │                   │
                    ┌─────────────▼─────────┐ ┌──────▼──────────┐
                    │     GOAL DECOMPOSER   │ │  MEMORY STORE   │
                    │  Templates → Tasks    │ │ Session/Episodic │
                    └─────────────┬─────────┘ │    /Longterm     │
                                  │           └─────────────────┘
                    ┌─────────────▼─────────────────────────────┐
                    │              TOOL REGISTRY                 │
                    │  news.rss │ conflict.acled │ military.flights
                    │  cyber.threats │ economic.macro │ ...      │
                    │  market.sp500sectors │ market.earnings     │
                    └─────────────┬─────────────────────────────┘
                                  │ Signal[]
                    ┌─────────────▼─────────────────────────────┐
                    │           SIGNAL PIPELINE                  │
                    │  INGEST → ENCODE → FILTER → COLLAPSE       │
                    │                      → SYNTHESIZE → EMIT   │
                    │                                            │
                    │  ┌──────────────────────────────────┐     │
                    │  │  INVARIANT VERIFIER (20 rules)   │     │
                    │  │  Checks at every stage boundary  │     │
                    │  └──────────────────────────────────┘     │
                    └─────────────┬─────────────────────────────┘
                                  │ IntelligenceBrief
                    ┌─────────────▼─────────────────────────────┐
                    │           EVENT BUS                        │
                    │  signal:* │ pipeline:* │ goal:* │ agent:* │
                    └─────────────┬─────────────────────────────┘
                                  │
                    ┌─────────────▼─────────────────────────────┐
                    │        INTEGRATION BRIDGE                  │
                    │  App.ts ←→ Agent System                   │
                    │  inject*Signals() / onBriefUpdate()       │
                    └───────────────────────────────────────────┘
```

## Pipeline Stages

| Stage | Input | Output | Invariants |
|-------|-------|--------|------------|
| **INGEST** | Raw service data | `Signal[]` | S-001, S-002, S-003, T-001, T-003, C-001, C-003 |
| **ENCODE** | `Signal[]` | `EncodedSignal[]` | S-001, S-004, C-001, C-002 |
| **FILTER** | `EncodedSignal[]` | `EncodedSignal[]` | T-002, V-001, V-002, V-003, P-002 |
| **COLLAPSE** | `EncodedSignal[]` | `CollapsedSignal[]` | C-004, P-003 |
| **SYNTHESIZE** | `CollapsedSignal[]` | `SynthesisOutput` | V-004 |
| **EMIT** | `SynthesisOutput` | `IntelligenceBrief` | T-004, P-004 |

## Invariant Rules (20 total)

### Structural (S)
- **S-001** Signal ID Required (FATAL)
- **S-002** Signal Domain Required (FATAL)
- **S-003** Signal Timestamp Required (ERROR)
- **S-004** Encoded Signal Score Required (ERROR)

### Temporal (T)
- **T-001** No Future Timestamps (WARNING)
- **T-002** Signal Freshness Check (WARNING)
- **T-003** Monotonic Ingestion Order (INFO)
- **T-004** Pipeline Duration Bound (WARNING)

### Consistency (C)
- **C-001** No Duplicate Signal IDs (ERROR)
- **C-002** Severity-Score Consistency (WARNING)
- **C-003** Region Code Validity (WARNING)
- **C-004** Collapse Source Integrity (ERROR)

### Coverage (V)
- **V-001** Minimum Domain Breadth (WARNING)
- **V-002** Minimum Signal Count (INFO)
- **V-003** Geographic Spread (INFO)
- **V-004** Critical Domain Presence (WARNING)

### Pipeline (P)
- **P-001** Stage Ordering (FATAL)
- **P-002** No Unexplained Signal Loss (WARNING)
- **P-003** Collapse Produces Reduction (INFO)
- **P-004** Emit Non-Empty (WARNING)

## Collapse Rules

| Rule | Name | Min Signals | Time Window | Boost |
|------|------|-------------|-------------|-------|
| CR-001 | Regional Multi-Domain Convergence | 3 | 6h | 1.5x |
| CR-002 | Crisis Cascade | 2 | 2h | 2.0x |
| CR-003 | Infrastructure Threat Convergence | 2 | 4h | 1.8x |
| CR-004 | Social Instability Surge | 3 | 12h | 1.3x |
| CR-005 | Geospatial Proximity Cluster | 3 | 4h | 1.4x |

## Goal Templates

| Template | Trigger | Tasks | Priority |
|----------|---------|-------|----------|
| Full Intelligence Sweep | startup | 11 tools (all domains + meteo + LLM synthesis) | 0 (highest) |
| Market & Sector Analysis | schedule | 3 tools (sectors, earnings, macro) | 5 |
| Crisis Region Focus | observation | 5 tools (conflict, military, infra) | 1 |
| Deep Earnings Analysis | manual | 2 tools (earnings, sectors) | 3 |

## SP500 Sector Monitor

Tracks all 11 GICS sectors via ETF proxies:

| Sector | ETF | Key Holdings |
|--------|-----|-------------|
| Energy | XLE | XOM, CVX, COP |
| Materials | XLB | LIN, SHW, FCX |
| Industrials | XLI | GE, CAT, UNP |
| Consumer Disc. | XLY | AMZN, TSLA, HD |
| Consumer Staples | XLP | PG, KO, PEP |
| Health Care | XLV | UNH, JNJ, LLY |
| Financials | XLF | BRK.B, JPM, V |
| Info Tech | XLK | AAPL, MSFT, NVDA |
| Comm Services | XLC | META, GOOG, NFLX |
| Utilities | XLU | NEE, SO, DUK |
| Real Estate | XLRE | PLD, AMT, EQIX |

### Signals Produced
- Per-sector: price, change%, relative strength vs SPY, volume
- Cross-sector: defensive/cyclical rotation spread
- Earnings: beat/miss/guidance detection, sector momentum

## File Structure

```
src/agent/
├── index.ts                    # Public API barrel export
├── types.ts                    # Core type definitions
├── bridge.ts                   # App.ts integration layer
├── ARCHITECTURE.md             # This file
├── bus/
│   └── event-bus.ts            # Typed pub/sub event bus
├── pipeline/
│   ├── stages.ts               # INGEST→ENCODE→FILTER→COLLAPSE→SYNTHESIZE
│   └── runner.ts               # Pipeline orchestrator
├── invariants/
│   ├── rules.ts                # 20 validation rules in 5 categories
│   └── verifier.ts             # Rule execution engine
├── cascade/                    # (reserved for advanced collapse rules)
├── runtime/
│   ├── agent.ts                # Observe→Plan→Act→Reflect loop
│   └── status.ts               # Cyberpunk HUD renderer & status API
├── tools/
│   ├── registry.ts             # Tool registration & execution
│   ├── adapters.ts             # 9 existing service → Signal adapters
│   ├── sp500-sectors.ts        # SP500 sector monitor (11 GICS sectors)
│   ├── earnings-capture.ts     # Earnings call capture monitor
│   ├── llm-provider.ts         # LLM classification, briefs, synthesis
│   └── meteo-supply-chain.ts   # Weather + shipping + agri + energy monitor
├── corpus/
│   ├── action-consequence.ts   # 20-entry causal DAG with chain traversal
│   └── synthesizer.ts          # AI-readable report & sitrep generator
├── memory/
│   └── store.ts                # 3-tier memory with tag index
└── planner/
    └── decomposer.ts           # Goal templates & task scheduling
```

## Migration Path

1. **Phase 1 (Current)**: Bridge mode — agent runs alongside App.ts, receiving
   injected signals via `inject*Signals()` functions. UI subscribes to
   `onBriefUpdate()` for enhanced intelligence output.

2. **Phase 2**: Individual services migrated from direct App.ts calls to
   agent-managed tools. The tool registry wraps existing service clients.

3. **Phase 3**: App.ts reduced to a UI shell. All data flow managed by the
   agent runtime. Pipeline replaces the manual clustering→analysis→display chain.

4. **Phase 4**: Full agent autonomy. Goal templates drive all data collection.
   Memory system enables pattern recognition across cycles.
