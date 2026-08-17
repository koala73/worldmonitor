# Company Monitoring blind evaluation

This is the private, offline evaluation lane for issue #6006. It implements the
progressive corpus, forecast, continuation, and scorer contracts without adding
provider ingestion, classifier runtime, portfolio persistence, publication, or
customer-visible behavior.

The current `cm_eval_v1` Stage 0 decision remains **STOP**. No empirical company
corpus, sealed gold labels, predictions, or passing score is committed in this
repository. The implementation and its generated test data are synthetic
contract proof only.

As of 2026-08-12, sealed external custody contains 400 genuine public-source
candidates: a 100-example pilot, a disjoint 100-example tracer, and a disjoint
200-example Stage 3 candidate set. The three sets pass the occurrence, content,
corporate-family, and source-origin disjointness audit. They remain draft corpus
inputs. No gold labels or predictions exist, and the current protocol does not
permit provider capture or classifier inference. These external artifacts do not
change the Stage 0 decision.

## Authority and failure boundary

Every forecast and score must receive:

- the approved `tests/fixtures/company-monitoring-evaluation/protocol.json`;
- the independently held approved-threshold SHA-256 anchor;
- explicit corpus, policy, model, and query versions; and
- the digest of every frozen corpus supplied independently of its corpus file:
  `--expected-pilot-corpus-digest` for forecast, `--expected-corpus-digest`
  for score, and `--expected-previous-corpus-digest` for a continuation parent.

The engine recomputes the protocol threshold digest and fails before scoring if
the protocol is missing, changed, unapproved, or not frozen. It reads all metric
denominators, floors, ceilings, confidence methods, calibration settings, seed,
and iteration counts from that approved protocol. There are no scoring defaults
or locally reinterpreted thresholds.

## Custody and blindness

Corpus rows contain only opaque example IDs and SHA-256 identities for the
canonical occurrence, content fingerprint, corporate family, and source origin.
Gold labels live in a separate sealed input with its own version and a versioned
curator-access contract. The corpus binds the sealed-label digest.

Only the curator process may combine corpus rows and gold labels before the
release decision. Forecast output is aggregate-only: it contains candidate
eligibility and direction strata, realized pilot rates, simultaneous denominator
forecasts, gaps, and recommended untouched-example growth. It never contains an
example ID or an individual gold label. Classifier and policy authors receive
that aggregate forecast, not the curator input.

Private manifests, gold labels, predictions, customer information, source URLs,
and raw content must remain outside the repository. Only aggregate forecasts,
score reports, and their digests are eligible to be recorded here after the
applicable approval.

## Public-evidence curation

The curation compiler validates genuine public-source provenance before it is
reduced to the opaque blind-corpus format. It performs no web requests and writes
no files. Keep its inputs and redirected outputs in a sealed path outside the
repository. Invalid or unreadable inputs emit only stable error codes; the CLI
does not echo sealed source text or paths to stderr.

Each `cm_public_evidence_curation_v1` manifest records the collection, corpus,
protocol, policy, model, query, and curator-access versions. Its custody block
records the collector tool, model, run, `sealed_external` storage class, and the
false `labelsVisibleToPolicyAuthors` boundary. Every researched candidate records:

- its included or excluded disposition and a machine-readable exclusion reason;
- exact legal, stable company, and corporate-family identities, US or GB
  geography, and public proof that the company is private;
- an exact occurrence identity, time, and geography; and
- one or more sources with the exact URL, publisher and matching hostname,
  title, bounded excerpt of at most 600 characters, published/observed/retrieved
  timestamps, evidence authority, and syndication relationship. Publication and
  occurrence timestamps declare `day` or `second` precision, so an official
  date-only record is never padded with an invented time. Official government
  records have their own evidence-authority value and are not represented as
  company-authored evidence.

Included candidates also have an opaque `cm_example_` ID and a declared primary
source. The compiler rejects missing provenance, time travel, duplicate
occurrences or primary content, source-URL reuse, raw schema additions, and a
custody block that exposes labels to policy authors. Its output has only opaque
IDs and domain-separated SHA-256 identities. `audit-split` rejects overlap among
pilot, tracer, and Stage 3 inputs by opaque ID, occurrence, content, corporate
family, or primary source origin.

The separate `cm_gold_curation_v1` input contains only the opaque ID,
publication eligibility, materiality, direction, and an optional real customer
judgment. Use `null` for `customerUseful` unless a genuine external customer
provided that judgment. The compiler derives the corporate-family digest from
the evidence manifest and requires one label for every included row. It does not
make or infer a label.

```bash
npm run --silent company-monitoring:curation -- audit-manifest \
  /private/path/pilot-curation.json \
  > /private/path/pilot-curation-audit.json

npm run --silent company-monitoring:curation -- audit-split \
  /private/path/pilot-curation.json \
  /private/path/tracer-curation.json \
  /private/path/stage3-curation.json

npm run --silent company-monitoring:curation -- compile-corpus \
  /private/path/pilot-curation.json \
  > /private/path/pilot-corpus.json

npm run --silent company-monitoring:curation -- compile-gold \
  /private/path/pilot-curation.json \
  /private/path/pilot-gold-curation.json \
  > /private/path/pilot-gold.json
```

Create classifier predictions while the evidence manifest is frozen and before
the policy author can inspect the sealed gold input. The merged admission policy
must remain unchanged for the complete pilot, tracer, and Stage 3 sequence.

## Sealed provider capture and predictions

Provider capture and classifier predictions use a second external manifest. A
`cm_offline_provider_observations_v1` artifact binds every opaque example to:

- the exact corpus digest, protocol, policy, model, and query versions;
- one frozen Exa query version and one frozen X query version;
- the requested classifier model, exact provider route, and expected resolved
  provider identity;
- complete or not-applicable coverage, latency, and cost for each provider;
- provider result locators, receipt digests, published/observed/expiry times,
  bounded content, authority, and verified-account status; and
- the `sealed_external` custody boundary with labels hidden from the runtime and
  curator reference evidence hidden from providers.

The validator rejects missing examples, incomplete Exa coverage, reused provider
results, query drift, observations after the capture timestamp, and runtime
model or route drift. The retained curation manifest binds the exact requested
model, configured route, and expected resolved provider through
`classifierRuntimeSha256`; a self-consistent observation manifest cannot change
that triple while keeping the frozen model version. The classifier receives the company identity required for
attribution and only the captured provider observations. It does not receive
curator reference URLs, reference excerpts, occurrence identities, or gold
labels. Output contains only opaque prediction rows.

The dedicated client also pins one OpenRouter provider route, disables fallback
and reasoning, requests zero-data-retention and no data collection, requires
supported parameters, and validates router metadata, resolved model, direct
single-attempt routing, absence of transformations, and request cost.

Run protocol preflight before provider capture or prediction work:

```bash
npm run --silent company-monitoring:offline-predictions -- preflight \
  --protocol tests/fixtures/company-monitoring-evaluation/protocol.json \
  --approved-threshold-digest "$APPROVED_DIGEST"
```

The checked-in protocol currently exits `1` with
`offline_runtime_protocol_stop`. This happens before credentials are loaded and
before a provider request is possible.

After an approved protocol continuation and independent provider capture, keep
all inputs and redirected output in the sealed path:

```bash
npm run --silent company-monitoring:offline-predictions -- \
  digest-observations \
  --corpus /private/path/pilot-corpus.json \
  --observations /private/path/pilot-provider-observations.json \
  > /private/path/pilot-provider-observations.sha256

npm run --silent company-monitoring:offline-predictions -- run \
  --protocol tests/fixtures/company-monitoring-evaluation/protocol.json \
  --approved-threshold-digest "$APPROVED_DIGEST" \
  --curation /private/path/pilot-curation.json \
  --expected-curation-digest "$(jq -r '.manifestSha256' /private/path/pilot-curation-audit.json)" \
  --corpus /private/path/pilot-corpus.json \
  --observations /private/path/pilot-provider-observations.json \
  --expected-observations-digest "$(tr -d '\n' < /private/path/pilot-provider-observations.sha256)" \
  --checkpoint-directory /private/path/pilot-prediction-checkpoints \
  --output /private/path/pilot-prediction-bundle.json

npm run --silent company-monitoring:offline-predictions -- \
  extract-predictions \
  --bundle /private/path/pilot-prediction-bundle.json \
  --bundle-verification-public-key /private/path/offline-bundle-signing-public.pem \
  --protocol tests/fixtures/company-monitoring-evaluation/protocol.json \
  --approved-threshold-digest "$APPROVED_DIGEST" \
  --curation /private/path/pilot-curation.json \
  --expected-curation-digest "$(jq -r '.manifestSha256' /private/path/pilot-curation-audit.json)" \
  --corpus /private/path/pilot-corpus.json \
  --observations /private/path/pilot-provider-observations.json \
  --expected-observations-digest "$(tr -d '\n' < /private/path/pilot-provider-observations.sha256)" \
  --output /private/path/pilot-predictions.json
```

The runtime requires `OPENROUTER_API_KEY`,
`COMPANY_MONITORING_CLASSIFIER_MODEL`, and
`COMPANY_MONITORING_CLASSIFIER_PROVIDER_ROUTE`. The independent runtime custodian
must also supply `COMPANY_MONITORING_OFFLINE_CHECKPOINT_HMAC_KEY` as canonical
base64 for at least 32 random bytes; do not share it with the curator or policy
author. The runtime custodian must also supply an
Ed25519 `COMPANY_MONITORING_OFFLINE_BUNDLE_SIGNING_PRIVATE_KEY` and retain its
public key separately for the extraction command. The signed bundle binds every
prediction and the complete run receipt; editing either makes extraction fail
closed. Never give the private signing key to the curator, scorer, or policy
author. A continuation additionally requires
`COMPANY_MONITORING_CONTINUATION_PUBLIC_KEY` and a signed
`cm_offline_continuation_authorization_v1` file from scoring custody. That signed
file binds the reproducible incomplete report, parent corpus/prediction/gold
digests, approved threshold anchor, child corpus, and precommitted expansion;
the prediction runtime receives only the public verification key. Do not put
these values, provider
observations, gold labels, or predictions in Git.

The provider-observation manifest binds the retained curation digest and one
capture-receipt digest per provider and example. A genuine zero-result search is
still `complete` only when its provider receipt exists; `not_applicable` requires
a null receipt. Each observation also retains its provider-owned publisher
origin, official-company-domain binding when applicable, and syndication
relationship, upstream URL, and group identity. Rewritten copies from one
syndication group therefore do not count as independent corroboration. Each run
checks every claimed official domain or verified X account against the separate
identity bindings retained in the curation manifest. It then
checks the retained curation and observation digests before it schedules
classifier work. The command creates one sealed `0600`
bundle without overwriting an existing artifact. The bundle contains the
prediction set and its versioned receipt, which binds the corpus, curation,
provider observations, prediction digest, capture version, and attested model
route. Its runtime-custody signature is verified with the independently retained
public key before extraction.
Each completed opaque prediction also has an immutable, anchor-validated
checkpoint in the sealed checkpoint directory. A retry loads those checkpoints
and calls the provider only for missing IDs; one late provider failure therefore
does not repeat successful paid classifications. An unmatched `.started.json`
contains an authenticated attempt ID that is also sent as OpenRouter request
and trace metadata. The retry stops with
`offline_checkpoint_reconciliation_required` before any new call. Retrieve the
retained response for that attempt, create a sealed reconciliation, and supply
its directory to the resumed run:

```bash
npm run --silent company-monitoring:offline-predictions -- reconcile \
  --checkpoint /private/path/pilot-prediction-checkpoints/cm_example_000001.started.json \
  --retained-provider-response /private/path/openrouter-attempt-response.json \
  --expected-provider-response-digest "$RETAINED_RESPONSE_SHA256" \
  --output /private/path/pilot-prediction-reconciliations/cm_example_000001.reconciliation.json

# Add this option to the resumed `run` command.
--reconciliation-directory /private/path/pilot-prediction-reconciliations
```

The retained response wrapper includes the authenticated attempt ID, provider
response ID, original provider latency, and raw provider response. The runtime
custodian must retain and approve its digest independently. The reconcile
command authenticates the started checkpoint, verifies the retained digest and
attempt/response-ID binding, validates the recovered response against the
checkpoint's pinned model and provider, and HMAC-authenticates the complete
reconciliation. The resumed run preserves the original provider latency and
creates the completed checkpoint without a second paid request. Never delete
the started marker merely to force a retry.
Completed checkpoints are authenticated with the separate runtime-custody key;
editing their prediction bytes or copied anchors makes the retry fail closed.
A started and completed checkpoint for one opaque example must carry the same
attempt ID.

## Progressive lifecycle

1. Lock a pilot corpus and its prediction set to the approved protocol and the
   exact policy, model, and query versions.
2. Build an untouched draft gate corpus, seal its gold labels, and bind that
   sealed-label digest to the draft. Before locking the corpus, the curator runs
   the forecast against the locked pilot and its independently retained digest.
   If the draft precommits an expansion, the curator must supply those actual
   rows to forecast too. The engine verifies their count and manifest, checks
   combined occurrence/content/opaque-ID uniqueness, and rejects
   target-or-expansion overlap with the pilot by occurrence, content fingerprint,
   corporate family, or source origin. It rejects predictions for the candidate
   gate as forecast input.
3. Inspect the aggregate candidate strata. The Stage 3 candidate should be
   roughly half publication-eligible with enough eligible positive, negative,
   and mixed rows to make all frozen denominator floors feasible. Because
   "roughly" is not a frozen numeric threshold, the engine reports the exact
   rate and counts instead of inventing a local gate.
4. A weak forecast is `forecast_warning`. It is non-gating and includes every
   simultaneous denominator gap plus deterministic untouched-growth guidance.
5. Freeze 100 real blind examples for tracer development and at least 200 for
   the Stage 3 gate. Retain the sealed-label digest already bound before forecast,
   then bind the aggregate forecast digest, versions, lock timestamp, and optional
   precommitted expansion manifest.
6. Score every frozen example. The report includes discovery, materiality,
   attribution, direction, customer usefulness, exact rate bounds, adaptive
   calibration and its frozen bootstrap, confusion matrices, latency, cost, all
   observed denominators, and the forecast.
7. Any denominator shortfall makes the result `incomplete`, even if another
   metric also misses a floor. A fully populated score is `pass` or `fail` from
   the approved metrics.
8. An `incomplete` run may continue only by retaining every prior corpus row,
   gold label, and prediction, then appending the exact untouched expansion
   precommitted in the parent corpus. The cumulative corpus is rescored under the
   unchanged policy, model, query, and protocol versions, the unchanged corpus
   purpose, and the unchanged curator-access version. Dropped or changed prior
   rows, an uncommitted expansion, or a fresh-corpus retry is rejected.
9. The parent's `incomplete` is **recomputed, never read**. A score report seals
   itself with an unsalted digest over its own contents, so that digest proves
   the file is internally consistent and nothing more — anyone holding the report
   can edit a field and re-seal it. The engine therefore replays the scoring core
   over the retained parent corpus, gold labels, and predictions and rejects the
   continuation unless the re-derived outcome and reasons match what the parent
   report claims, and unless the parent was scored under this same approved
   protocol and threshold anchor. The parent is independently digest-anchored,
   must itself be a valid locked corpus, and must have locked strictly before the
   child.

## Offline commands

The CLI writes canonical JSON to stdout and errors to stderr. It never writes a
corpus or report file itself.

```bash
npm run --silent company-monitoring:blind-evaluation -- forecast \
  --protocol tests/fixtures/company-monitoring-evaluation/protocol.json \
  --approved-threshold-digest "$APPROVED_DIGEST" \
  --pilot-corpus /private/path/pilot-corpus.json \
  --expected-pilot-corpus-digest "$FROZEN_PILOT_CORPUS_DIGEST" \
  --pilot-gold /private/path/pilot-gold.json \
  --pilot-predictions /private/path/pilot-predictions.json \
  --target-corpus /private/path/draft-stage3-corpus.json \
  --target-gold /private/path/stage3-gold.json \
  --target-expansion /private/path/precommitted-expansion.json
```

Omit `--target-expansion` when the target corpus has
`precommittedExpansion: null`; supplying it in that case is an error. A target
with a non-null precommit requires the matching rows.

`score` takes the same `--protocol` and `--approved-threshold-digest` authority
inputs as `forecast`, plus explicit `--corpus`, `--expected-corpus-digest`,
`--gold`, `--predictions`, and `--forecast` paths. A cumulative score must also
provide the previous corpus, its independently retained digest, gold labels,
predictions, and report.

```bash
npm run --silent company-monitoring:blind-evaluation -- score \
  --protocol tests/fixtures/company-monitoring-evaluation/protocol.json \
  --approved-threshold-digest "$APPROVED_DIGEST" \
  --corpus /private/path/stage3-corpus.json \
  --expected-corpus-digest "$FROZEN_CORPUS_DIGEST" \
  --gold /private/path/stage3-gold.json \
  --predictions /private/path/stage3-predictions.json \
  --forecast /private/path/stage3-forecast.json
```

A cumulative invocation adds:

```bash
  --previous-corpus /private/path/parent-corpus.json \
  --expected-previous-corpus-digest "$FROZEN_PARENT_CORPUS_DIGEST" \
  --previous-gold /private/path/parent-gold.json \
  --previous-predictions /private/path/parent-predictions.json \
  --previous-report /private/path/parent-report.json
```

Exit codes are part of the contract, so a wrapper can never read a rejected gate
as success:

| Code | Meaning |
|------|---------|
| `0` | `score` ran and the outcome is `pass` |
| `1` | the engine refused to score: bad input, tampered evidence, or a usage error |
| `2` | the engine scored and the outcome is `fail` or `incomplete` |

Engine refusals are machine-readable: a `BlindEvaluationError` writes its exact
`code` to stderr and exits `1`. Stable code families identify the rejected
contract surface, including `protocol_*` and `approved_threshold_*`, `corpus_*`,
`gold_*`, `prediction_*`, `forecast_*`, and `continuation_*` /
`previous_*`. Callers should branch on the complete code, not a substring; the
module's `fail(...)` sites and contract tests are the authoritative catalog.
Usage and file/JSON I/O errors remain human-readable stderr with exit `1`.

Digest-only commands first apply a closed-world syntactic schema: every object
and nested row must have exactly the declared keys, required literal and
primitive types must be valid, and corpus, gold, prediction, forecast, and
expansion rows cannot carry undeclared raw evidence. Only then is the artifact
sealed. Each command maps to the corpus field that consumes its digest:

| Command | Produces | Consumed by |
|---------|----------|-------------|
| `digest-corpus` | the frozen corpus digest | forecast's pilot anchor, score's target/parent anchor, and `continuation.parentCorpusSha256` on a child |
| `digest-gold` | the sealed gold-label digest | `corpus.sealedGoldLabelsSha256` |
| `digest-forecast` | the aggregate forecast digest | `corpus.forecastSha256` |
| `digest-expansion` | the precommitted expansion manifest digest | `corpus.precommittedExpansion.manifestSha256` |
| `digest-predictions` | the prediction-set digest | parent-evidence checks on a continuation |

So locking a pilot needs `digest-gold`. For a gate, first run `digest-gold` and
place that digest on the still-draft corpus; forecast validates that binding and
produces the aggregate artifact. Then run `digest-forecast`, place its digest on
the corpus, set the lock timestamp and status, and finally run `digest-corpus` to
retain the independent frozen-corpus anchor. Run `digest-expansion` before
forecast too when a continuation is to remain possible. A corpus frozen with
`precommittedExpansion: null` cannot be continued even if it scores `incomplete`.

## Stage 4 exclusion

The post-v1 Stage 4 input is a separate 500-example blind corpus plus refreshed
Stage 3 evidence. This v1 engine reports that exclusion and rejects a Stage 4
corpus. Stage 4 does not block this epic and cannot be smuggled in as an
`incomplete` continuation.
