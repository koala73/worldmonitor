# Company Monitoring viability decision

- Decision date: 2026-08-05
- Protocol: `cm_eval_v1`
- Owner: Elie Habib, WorldMonitor product owner
- Machine-readable contract:
  `tests/fixtures/company-monitoring-evaluation/protocol.json`
- Decision: **STOP**

Company Monitoring must not proceed to paid-provider runtime or customer-visible
behavior. Only fixtures and dark contracts are permitted. The base-rate,
provider-independent rediscovery, and external-customer usefulness studies have
not run, and the provider policy package is not approved for runtime. Missing
evidence is a stop, not a zero and not a provisional pass.

## Stage 0 gate record

| Gate | Frozen requirement | Current evidence | Outcome |
|---|---|---|---|
| Base-rate viability | At least 150 US/UK company-years, at least 0.30 material events per company-year, exact one-sided 90% lower bound at least 0.20 | Selection protocol preregistered; private manifest and aggregate result absent | Stop |
| Provider-independent rediscovery | At least 100 frozen pairs, point estimate at least 0.60, exact one-sided 90% Clopper-Pearson lower bound at least 0.50 | Pair protocol preregistered; private manifest and aggregate result absent | Stop |
| Historical usefulness | Same ten admitted impacts for two external target customers, including one independent customer; positive, negative, and mixed coverage; at least seven of ten useful from each | Protocol frozen; no external customer judgments recorded | Stop |
| Admission quality | Every metric, denominator, bound method, calibration method, seed, and approver frozen before scoring | Frozen and integrity-bound to the named approval | Pass for Stage 0 contract freeze |
| Provider policy | Separate paid-runtime approval for Exa; written X commercial-use evidence and enforced compliance; enforced model ZDR, no-training, no-reasoning, and pinned routing | Exa is approved only for evaluation; every paid-runtime result remains blocked | Stop |
| 500-company economics | Exactly one account-level shared-discovery workload of 500 companies; modeled monthly cost no more than $125 before paid beta | $110.8659375 including allocated infrastructure and 25% contingency | Pass as a model only |

The machine test recomputes this table's decisive arithmetic and requires the
recorded stop reasons to equal the computed reasons. Editing the prose cannot
promote the product.

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
contains the external judgments. Stage 1A may collect them only after the tracer
can produce the frozen ten-impact set.

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
