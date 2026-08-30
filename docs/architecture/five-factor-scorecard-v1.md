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
  -> staged hash read model, atomically renamed into place
  -> country/compact-list responses or pure on-demand bloc scorer
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

The scorecard API never fans out to source keys. Normal reads use the atomic
Redis hash read model: one country field for a country request, requested
country fields for a bloc, and a precomputed summary field for the list. A
missing or malformed read model falls back to the full canonical snapshot.
Bloc methods use adjacent evidence from the same cohort, aggregate physical
values or population-weight continuous scores as the methodology specifies,
and then apply the absolute bands.

## Module boundary

The canonical scoring core lives under `scripts/scorecard/v1/`, inside the
measured scripts-root Railway package:

- `_types.mts`: evidence, result, snapshot, and scorer types.
- `_input-registry.mts`: the closed `SCORECARD_INPUT_REGISTRY`.
- `_methodology.mts`: version, goalposts, weights, floors, bands, and rounding.
- `_source-adapters.mts`: upstream snapshots to declared evidence.
- `_score-country.mts`: pure country scoring.
- `_source-registry.mts`: the authoritative Redis source-key map.

Vercel Edge Functions cannot import that scripts-only tree. The
`generate-scorecard-edge-mirrors.mjs` generator therefore emits concrete `.ts`
mirrors under `server/worldmonitor/scorecard/v1/`, rewrites local `.mts`
specifiers, and leaves the measured Railway placement unchanged. `make
generate`, the no-write mirror check, and the Edge packaging test keep the
manifest complete and the emitted modules byte-current with the canonical
sources. Do not edit the generated mirrors.

The server surface also contains runtime-only modules:

- `_score-bloc.ts`: pure physical and population-weighted bloc scoring.
- `_bloc-presets.ts`: versioned preset membership and custom-member validation.
- `_read-snapshot.ts`: bounded read-model reads and canonical fallback.
- `_response.ts`: internal result to generated response conversion.
- handler modules: country, list, and bloc RPC methods.

The Railway service watches and packages only its canonical scripts-root
closure. Edge handlers import only the generated server copies, so neither
runtime crosses its deployment boundary.

The seeder batch-reads the upstream Redis keys and validates the complete next
snapshot. Before canonical publish it writes a unique, expiring staging hash.
One idempotent Lua command sets the canonical envelope, renames the staged hash,
and applies both TTLs. No reader can observe a canonical cohort and serving
projection from different runs. A read, adaptation, validation, staging, or
atomic-switch failure leaves the previous canonical and read model intact.
Failure preservation extends both keys. Hash readers fall back to canonical if
any requested field declared by the cohort metadata is missing or malformed.
That multi-megabyte fallback uses the bounded five-second Redis body-read path
and one five-minute in-process last-good slot instead of the generic 1.5-second
small-value deadline. Read-model metadata is validated as a sorted, unique
ISO-2 cohort list.
Health uses population-evidence, scoreable-country, and per-pillar coverage floors from
`seed-meta:scorecard:five-factor` and directly checks that the live read-model
hash still has its metadata field; the full canonical value remains the last-good fallback.

## Invariants

- The input registry is closed and complete at compile time.
- Available evidence always has a finite value, observation year, unit, source,
  and source key.
- Unavailable evidence has no value and always has a machine-readable reason.
- Every stored result equals a fresh pure-scorer result from its adjacent
  evidence.
- The serialized snapshot remains below the repository's 5 MB seed limit.
- Observation freshness and scoreable-country publication floors are frozen
  parts of methodology 1.0.0.
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
blocs without live source fan-out, and is an atomic rollback unit. The measured
3.7 MB cohort made full-value reads too expensive for country and compact-list
requests, so the hash read model provides narrow fields without weakening the
canonical last-good unit.
