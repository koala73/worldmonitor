# Company Monitoring viability decision

- Decision date: 2026-08-18
- Protocol: `cm_eval_v1`
- Owner: Elie Habib, WorldMonitor product owner
- Machine-readable contract:
  `tests/fixtures/company-monitoring-evaluation/protocol.json`
- Machine verdict: **STOP**

Company Monitoring must not proceed to paid-provider runtime or customer-visible
behavior. Only fixtures and dark contracts are permitted. The `cm_eval_v1`
base-rate and provider-independent rediscovery results remain `not_run`. The
2026-08-16 and 2026-08-18 attempts are inadmissible audit material, not scored
results. Historical usefulness has not run (execution is Stage 1A, #6919), and
provider-policy runtime evidence remains blocked. Missing, invalid, or
incomplete evidence is a stop, not a zero and not a provisional pass.

## Stage 0 gate record

| Gate | Frozen requirement | Current evidence | Outcome |
|---|---|---|---|
| Base-rate viability | At least 150 US/UK company-years, at least 0.30 material events per company-year, exact one-sided 90% lower bound at least 0.20 | `not_run`; both attempts are inadmissible and the later audit measured binary news hits, not material events per company-year | Stop |
| Provider-independent rediscovery | At least 100 frozen pairs, point estimate at least 0.60, exact one-sided 90% Clopper-Pearson lower bound at least 0.50 | `not_run`; both attempts reused a burned pair-set version without a new approved precommitment | Stop |
| Historical usefulness | Same ten admitted impacts for two external target customers, including one independent customer; positive, negative, and mixed coverage; at least seven of ten useful from each | Protocol frozen; no external customer judgments recorded. Execution is #6919 | Stop |
| Admission quality | Every metric, denominator, bound method, calibration method, seed, and approver frozen before scoring | Frozen and integrity-bound to the named approval | Pass for Stage 0 contract freeze |
| Provider policy | Official API access, bounded retention, enforced X offline-content lifecycle controls, and enforced model ZDR, no-training, no-reasoning, and pinned routing | Runtime policy controls are incomplete; paid-provider runtime remains dark | Stop |
| 500-company economics | Exactly one account-level shared-discovery workload of 500 companies; modeled monthly cost no more than $125 before paid beta | $110.8659375 including allocated infrastructure and 25% contingency | Pass as a model only |

The provider-policy row is an operational summary. The linked `cm_eval_v1`
machine contract remains authoritative for current stop reasons; changing this
documentation does not revise that frozen contract.

The machine test recomputes this table's decisive arithmetic and requires the
recorded stop reasons to equal the computed reasons. Editing the prose cannot
promote the product.

## Machine verdict vs product-owner sign-off

- Machine verdict against frozen `cm_eval_v1` thresholds: **STOP**.
- Reasons: `base_rate_not_complete`, `rediscovery_not_complete`,
  `historical_usefulness_not_complete`, and `provider_policy_not_approved`.
- Named product-owner approval of the 2026-08-05 threshold freeze remains on
  file (`approverName`: Elie Habib). It does not approve either invalid attempt
  or authorize reuse of the frozen sample and pair-set IDs.

## Inadmissible-attempt audit

Private manifests, company identities, SEC accession records, query URLs, and
raw responses remain outside the repository with file mode `0600`. The committed
`stage0-aggregates.json` file is classified `inadmissible_audit_only` and
`eligibleForViabilityDecision: false`. It binds the recorded query metadata and
private-evidence digests for audit continuity, but repository self-consistency
does not prove the private observations or make either attempt admissible.

The 2026-08-18 audit uses new attempt IDs rather than claiming a second score
under the burned `cm_base_rate_001` and `cm_rediscovery_001` IDs. It remains
inadmissible for four independent reasons:

- the same protocol version and sample/pair-set IDs had already been burned by
  the invalid 2026-08-16 attempts;
- the base-rate audit counted whether Google News returned any item for Form D
  issuers, which is binary news coverage rather than a Poisson count of admitted
  material events per company-year;
- the Google News query metadata was not bound to an independently timestamped
  pre-score commitment; and
- the private observations cannot be replayed in this repository, so their
  counts remain unverified.

The audit recorded 150 company-years with 35 binary news hits and 100
rediscovery pairs with 15 hits. Those values are descriptive only. No point
estimate or confidence bound from them enters `protocol.json`.

| Artifact | Time (UTC) | SHA-256 |
|---|---|---|
| 2026-08-18 base-rate private selection manifest | 12:50 | `1fa728eb15a03ef74579e964bf08a2929a7fa7790f56ebd7a6ca53b0d95de900` |
| 2026-08-18 base-rate private evidence | 12:59 | `fc7faafb532ad0e4722de6815be342cac5dbc16cbb7ad3ae07a6db046a7a5132` |
| 2026-08-18 base-rate canonical audit record | 13:03 | `b0c32244293f9231723572ba22bc9f42703ef798e29b94fdb0d930983c17092b` |
| 2026-08-18 rediscovery private pair manifest | 12:50 | `233930de14ee413856833d850881f228eed335325476d6b200af165cb6fa5965` |
| 2026-08-18 rediscovery private evidence | 13:03 | `468d9eab2c0cc7ee2ef7cefed2738f9c5218e805d908f873f990c75e2e7476a1` |
| 2026-08-18 rediscovery canonical audit record | 13:03 | `b376056a7f3ebecf95d74ff22a67ea709c34f1961872ae7786e8846687c69717` |
| Invalid base-rate private selection manifest | 2026-08-16 10:00:07.155 | `e2711a5ba8234517e4cc627ef0684222fe8de2cbb29e8d079a8e340ce6425a15` |
| Invalid base-rate private evidence output | 2026-08-16 10:00:30.667 | `bc01813f857f217b7e69fb108157735591c15f0f6f25de372d61c11161408a48` |
| Invalid rediscovery private pair manifest | 2026-08-16 10:03:14.869 | `45b4789941e46186591b5720d323e4dfaa085a6b4ce67c239f4b27a90aa2055b` |
| Invalid rediscovery private checkpoint | 2026-08-16 10:09:41.097 | `27dc9bfa23e6080a55314cd07aaea6a1a305f136b82fca99ab979c7d462c9b8f` |

The 2026-08-16 base-rate attempt had 19 of 150 first-sale dates outside
2024. The rediscovery attempt had 16 of 100 outside 2025, and three GDELT
requests had already reached the fixed unavailable outcome. Those failures and
the 2026-08-18 audit do not create a valid numerator, denominator, point
estimate, or lower bound.

The attempted `cm_base_rate_001` and `cm_rediscovery_001` evidence cannot be
recreated or replaced under the same version. A new run requires product-owner
approval of a new protocol version, new sample and pair-set IDs, an explicit
first-sale date-window check, a metric that matches the frozen estimand, and an
independently anchored precommitment before any scoring or provider query.
Until then, the machine-readable `cm_eval_v1` results stay `not_run`.

## Base-rate sample protocol

The frozen sample ID is `cm_base_rate_001`. Before any query tuning, the operator
must select a US/UK private-company cohort spanning at least 150 company-years
and preserve the private manifest outside the repository. The mutable result
record, which is excluded from the approved threshold digest, contains only:

- the opaque sample ID;
- the manifest's SHA-256 digest;
- aggregate company-years and admitted material-event count;
- the recomputed point estimate; and
- the exact one-sided 90% Garwood lower bound for the Poisson event rate.

The manifest is private because it is the only artifact that can reveal the
sampled companies. A complete result requires a 64-hex private-manifest digest,
a separate 64-hex aggregate-evidence digest, and non-null recorded point and
lower-bound values that match independent recomputation. A digest without the
private manifest is not evidence. A result with fewer than 150 company-years, a
passing point estimate without the required lower bound, or arithmetic that does
not recompute is not a pass.

## Provider-independent rediscovery protocol

The frozen pair-set ID is `cm_rediscovery_001`. Reference opportunities and the
rediscovery run must be provider-independent. The discovery provider may not
supply its own reference set, the reference and rediscovery query families must
be disjoint, and pair selection must be frozen before query tuning.

Only the opaque pair-set ID, 64-hex private-manifest and aggregate-evidence
digests, aggregate pair count, rediscovered count, recorded point estimate, and
recorded exact bound may enter the repository. Both recorded values must match
independent recomputation. At least 100 pairs are required. An insufficient
denominator is incomplete even when the observed rate is above 0.60.

## Historical usefulness protocol

Stage 0 freezes the protocol and remains stopped until the mutable result record
contains the external judgments. Stage 1A (#6919) may collect them only after
the tracer can produce the frozen ten-impact set. This Stage 0 run did not
recruit customers and did not execute Stage 1A.

- Exactly two external target customers judge the same ten admitted impacts.
- At least one customer is independent of the initiating design-partner context.
- The set contains at least one positive, one negative, and one mixed impact.
- Each customer must independently mark at least seven of ten useful.
- Missing and unable-to-judge labels count against the denominator.
- WorldMonitor staff and internal analysts cannot substitute for either customer.
- Customer identities and portfolio content remain outside the repository;
  labels use opaque impact and customer IDs, and external-target qualification
  is bound by an out-of-repository evidence digest.

One customer's pass cannot offset the other's fail. A missing result, fewer than
two qualified external target customers, a different impact set, missing
direction coverage, or either customer scoring below seven useful impacts keeps
the decision stopped.

The exact external inputs still required are:

1. Two customer-held qualification records that prove each respondent is an
   external target customer, plus a SHA-256 digest for each record. Identities,
   organization names, portfolios, and raw qualification records stay outside
   the repository.
2. An independence attestation for at least one of those two customers. That
   customer must be independent of the initiating design-partner context.
3. One frozen set of exactly ten admitted impacts, with opaque impact IDs and at
   least one positive, one negative, and one mixed direction. Both customers
   must judge this same set.
4. Ten `true`, `false`, or `null` usefulness labels from each customer, keyed by
   the same opaque impact IDs. A `null` label means missing or unable to judge
   and counts against the denominator.
5. One aggregate usefulness-evidence artifact and its SHA-256 digest. The
   repository receives only opaque IDs, directions, labels, qualification
   digests, independence flags, and the aggregate digest.

The tracer has not yet produced the frozen ten-impact set, and neither customer's
qualification record or judgment set is available. Therefore no truthful
historical-usefulness score exists.

## Frozen admission-quality contract

Rate metrics use exact one-sided 90% Clopper-Pearson lower bounds. A rate passes
only when its minimum denominator, point floor, and lower-bound floor all pass.

| Metric | Minimum denominator | Point floor | Lower-bound floor |
|---|---:|---:|---:|
| Published material-impact precision | 100 published decisions | 0.92 | 0.85 |
| Published company-attribution precision | 100 published decisions | 0.99 | 0.95 |
| Direction accuracy overall | 75 correctly attributed material impacts | 0.92 | 0.85 |
| Direction accuracy, positive | 25 positive impacts | 0.88 | 0.75 |
| Direction accuracy, negative | 25 negative impacts | 0.88 | 0.75 |
| Direction accuracy, mixed | 25 mixed impacts | 0.88 | 0.75 |

Confidence calibration uses adaptive expected calibration error over every blind
example: 200 at Stage 3 and 500 at the separate post-v1 Stage 4. Ten
equal-frequency bins are ordered by confidence and then opaque example ID. The
point estimate must be at most 0.10 and the one-sided 90% stratified-bootstrap
upper bound at most 0.15. Bootstrap strata are gold materiality and gold
direction; the run uses 10,000 iterations and seed `6003`.

The committed protocol also includes an explicitly synthetic, arithmetic-only
verification set. Machine tests independently recompute its Poisson and
Clopper-Pearson point and lower bounds, adaptive ECE, and the seed-`6003`
stratified-bootstrap upper bound. Those opaque examples are test vectors and are
ineligible as empirical viability evidence.

An underfilled scored corpus is `incomplete`, not a pass. A later run may not
change these defaults locally or reinterpret an incomplete gate.

## Approval and change control

The approved threshold digest is stored beside the named product-owner approval.
Machine tests recompute it from the frozen protocol and compare both values with
an independent literal in the test source. Mutable result records are excluded,
so honest evidence cannot rewrite the approved contract. Changing a threshold,
denominator, metric definition, confidence method, provider requirement,
calibration method, or the 500-company workload requires a new protocol or cost
package and approval. Any such change after scoring also requires a new
blind-corpus version and cannot rescue the current score.

`approvedAt` must be a valid RFC 3339 timestamp. Once any empirical result is
complete, `firstScoredRunStartedAt` must also be valid and strictly later than
approval. Missing, invalid, or equal timestamps stop promotion.

Every JSON file in the evaluation-fixture directory must be registered with a
deliberate schema validator. Empirical result schemas allow only aggregate
counts, opaque IDs, labels over opaque IDs, and SHA-256 digests; raw company or
customer identity, prompts, content, domains, handles, and source URLs are
forbidden.

## Promotion boundary

While the decision is `stop`, the only permitted implementation is:

- fixtures; and
- dark contracts with no paid-provider calls or customer-visible behavior.

The following remain forbidden: paid-provider runtime, event publication, public
REST writes, the Company Monitoring workspace, and alerts. Stage 0 may change to
`continue` only after the base-rate and rediscovery aggregate records pass, the
two-customer usefulness result passes, provider policy has separately approved
runtime evidence, runtime enforces the frozen X and model policies, and the
machine test recomputes every gate without a stop reason.
