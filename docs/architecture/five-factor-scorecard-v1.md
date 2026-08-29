# Five-factor scorecard v1 architecture

## Context

Issue #6441 adds five absolute country capability scores without changing the
Country Resilience Index (CRI). The scorecard must support reproducible country
and bloc calculations, show the source observation behind every component, and
return explicit unavailable reasons instead of inferred values.

The refreshed Step 0 audit is the architecture contract. In particular:

- scorecard inputs do not enter the CRI `INDICATOR_REGISTRY`;
- CRI dimensions, memberships, scorers, keys, and versions do not change;
- food and energy bloc scores aggregate physical quantities before scoring;
- demographics, technology, and defense bloc scores population-weight the
  unrounded continuous country sub-scores;
- all public reads use one frozen input cohort.

## Options considered

### Full source-safe evidence ledger

Store a closed, scorecard-specific evidence record beside each derived country
result. Compute bloc results on request from this evidence.

This makes every stored country score reproducible and keeps country and bloc
results on one atomic source cohort. Its cost is a larger Redis value.

### Minimum bloc aggregation basis

Store each derived country result plus only the physical totals, population,
and continuous scores needed by the current bloc formulas.

This is smaller, but it couples the stored shape to methodology 1.0.0 and loses
the evidence needed to recompute a result after a formula correction. Once
source, year, unit, availability, and provenance are added, it becomes a less
clear form of the evidence ledger.

## Decision

Use one atomic, source-safe evidence ledger plus derived country results:

```text
upstream Redis snapshots
  -> pure source adapters
  -> closed SCORECARD_INPUT_REGISTRY evidence
  -> pure country scorer
  -> scorecard:five-factor:v1 (evidence + results)
  -> country/list responses or pure on-demand bloc scorer
```

The canonical snapshot is internal and versioned independently from the public
sebuf contract:

```ts
interface FiveFactorSnapshotV1 {
  schemaVersion: 1;
  methodologyVersion: '1.0.0';
  inputRegistryVersion: '1.0.0';
  computedAt: string;
  sourceStates: Record<string, SourceState>;
  countries: Record<string, {
    evidence: CountryScorecardEvidenceV1;
    result: CountryScorecardResultV1;
  }>;
}
```

`CountryScorecardEvidenceV1` is not a copy of upstream payloads. It contains
only formula-relevant, redistribution-safe observations declared in
`SCORECARD_INPUT_REGISTRY`: numeric value, year, unit, source, source key, and a
tagged availability state. It also contains the physical food and energy
quantities and population required for bloc aggregation. Raw SIPRI transfer
rows and undeclared upstream fields are forbidden.

The scorecard API reads only this snapshot. It does not fan out to source keys.
Country and list methods return stored results. Bloc methods use adjacent
evidence from the same snapshot, aggregate physical values or population-weight
continuous scores as the methodology specifies, and then apply the absolute
bands.

## Module boundary

The implementation lives under `server/worldmonitor/scorecard/v1/`:

- `_types.ts`: evidence, result, snapshot, and scorer types.
- `_input-registry.ts`: the closed `SCORECARD_INPUT_REGISTRY`.
- `_methodology.ts`: version, goalposts, weights, floors, bands, and rounding.
- `_source-adapters.ts`: upstream snapshots to declared evidence.
- `_score-country.ts`: pure country scoring.
- `_score-bloc.ts`: pure physical and population-weighted bloc scoring.
- `_bloc-presets.ts`: versioned preset membership and custom-member validation.
- `_snapshot.ts`: snapshot validation and canonical read.
- `_response.ts`: internal result to generated response conversion.
- handler modules: country, list, and bloc RPC methods.

The seeder batch-reads the upstream Redis keys and publishes the complete next
snapshot with one canonical `SET` through `runSeed`. A read, adaptation,
validation, or publish failure leaves the previous canonical snapshot intact.
Health uses `seed-meta:scorecard:five-factor`.

## Invariants

- The input registry is closed and complete at compile time.
- Available evidence always has a finite value, observation year, unit, source,
  and source key.
- Unavailable evidence has no value and always has a machine-readable reason.
- Every stored result equals a fresh pure-scorer result from its adjacent
  evidence.
- The serialized snapshot remains below the repository's 5 MB seed limit.
- The persistence schema is never exposed directly through protobuf or MCP.
- Unsupported snapshot, registry, or methodology versions fail explicitly.
- CRI seeded inputs and output bytes are not modified by this feature.

## Compatibility with #6507

Issue #6507 can later add indicator-level CRI evidence without changing this
scorecard. This feature does not widen `GetResilienceScoreResponse`, reuse the
CRI `INDICATOR_REGISTRY`, or claim the CRI indicator-evidence namespace. Its
`ScorecardEvidence` message and internal evidence ledger are scorecard-specific.
The two surfaces can share source observations in a future version, but neither
one depends on the other for v1 delivery.

## Consequences

The snapshot duplicates the small set of adapted evidence beside derived
results. This is deliberate: a single value is auditable, supports arbitrary
blocs without live source fan-out, and is an atomic rollback unit. If measured
payload size later exceeds the hard limit, a versioned pointer transaction can
split evidence and results. V1 does not add that complexity without evidence.
