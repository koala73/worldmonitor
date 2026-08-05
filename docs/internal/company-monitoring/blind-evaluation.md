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
- the digest of the frozen corpus supplied independently of that corpus file.

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
2. Build an untouched draft gate corpus. Before locking it, the curator runs the
   forecast against the locked pilot. The engine rejects any overlap by
   occurrence, content fingerprint, corporate family, or source origin, and it
   rejects predictions for the candidate gate as forecast input.
3. Inspect the aggregate candidate strata. The Stage 3 candidate should be
   roughly half publication-eligible with enough eligible positive, negative,
   and mixed rows to make all frozen denominator floors feasible. Because
   "roughly" is not a frozen numeric threshold, the engine reports the exact
   rate and counts instead of inventing a local gate.
4. A weak forecast is `forecast_warning`. It is non-gating and includes every
   simultaneous denominator gap plus deterministic untouched-growth guidance.
5. Freeze 100 real blind examples for tracer development and at least 200 for
   the Stage 3 gate. Bind the aggregate forecast digest, sealed-label digest,
   versions, lock timestamp, and optional precommitted expansion manifest.
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
   unchanged policy, model, query, and protocol versions. Dropped or changed
   prior rows, an uncommitted expansion, or a fresh-corpus retry is rejected.

## Offline commands

The CLI writes canonical JSON to stdout and errors to stderr. It never writes a
corpus or report file itself.

```bash
npm run company-monitoring:blind-evaluation -- forecast \
  --protocol tests/fixtures/company-monitoring-evaluation/protocol.json \
  --approved-threshold-digest "$APPROVED_DIGEST" \
  --pilot-corpus /private/path/pilot-corpus.json \
  --pilot-gold /private/path/pilot-gold.json \
  --pilot-predictions /private/path/pilot-predictions.json \
  --target-corpus /private/path/draft-stage3-corpus.json \
  --target-gold /private/path/stage3-gold.json
```

Use `score` with explicit `--corpus`, `--expected-corpus-digest`, `--gold`,
`--predictions`, and `--forecast` paths. A cumulative run must also provide all
four `--previous-*` inputs. Digest-only commands are available for corpus, gold,
prediction, forecast, and expansion manifests so custody tooling can seal each
artifact before it crosses an access boundary.

## Stage 4 exclusion

The post-v1 Stage 4 input is a separate 500-example blind corpus plus refreshed
Stage 3 evidence. This v1 engine reports that exclusion and rejects a Stage 4
corpus. Stage 4 does not block this epic and cannot be smuggled in as an
`incomplete` continuation.
