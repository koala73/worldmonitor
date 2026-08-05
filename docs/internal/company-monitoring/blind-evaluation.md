# Company Monitoring blind evaluation

This is the private, offline evaluation lane for issue #6006. It implements the
progressive corpus, forecast, continuation, and scorer contracts without adding
provider ingestion, classifier runtime, portfolio persistence, publication, or
customer-visible behavior.

The current `cm_eval_v1` Stage 0 decision remains **STOP**. No empirical company
corpus, sealed gold labels, pilot predictions, or passing score is committed in
this repository. The implementation and its generated test data are synthetic
contract proof only. A real 100-example tracer corpus and a real Stage 3 corpus
of at least 200 examples remain external evidence gates.

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
npm run company-monitoring:blind-evaluation -- forecast \
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
npm run company-monitoring:blind-evaluation -- score \
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
