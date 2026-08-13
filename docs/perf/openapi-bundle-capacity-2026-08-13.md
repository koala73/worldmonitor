# Unified OpenAPI bundle — capacity baseline and reduction plan

Measured 2026-08-13 against `docs/api/worldmonitor.openapi.yaml` at `27690f1`. Issue [#6558](https://github.com/koala73/worldmonitor/issues/6558).

Regenerate every number here with:

```bash
node scripts/openapi-capacity-report.mjs --json
```

## Why there is a budget at all

`public/openapi.json` is the machine copy of the API contract. Agent-readiness scanners fetch it and cap the body they will analyse at roughly 1 MB. When the spec crossed that cap on 2026-07-05, ora.ai/orank's function-calling compatibility check flipped from a computed verdict — "192/192 with typed schemas" — to "API spec found but couldn't validate function calling compatibility", the same failure elevenlabs' 1.8 MB and openrouter's 1.5 MB specs get. Sub-800 KB specs get computed verdicts. See [#4852](https://github.com/koala73/worldmonitor/issues/4852).

The guard is `tests/openapi-json-dedup.test.mjs`, which fails when the served artifact exceeds **950,000 bytes**.

**Raising the budget is not a remedy.** The cap belongs to the scanner, not to us; moving our number does not move theirs. The value is pinned by a literal assertion in that test so a raise cannot pass as a one-line edit, and it may only change if scanner behaviour is re-verified empirically first.

## Baseline

| | Before #6558 | After #6558 |
| --- | --- | --- |
| Served bytes | 946,682 | 853,100 |
| Headroom under 950,000 | 3,318 (0.35%) | 96,900 (10.2%) |
| Operations | 218 | 218 |
| Mean bytes per operation | 4,343 | 3,913 |
| Room for | 0 more operations | ~24 more operations |

The "before" column is the state the issue was filed from: less than one operation's worth of headroom. [#6531](https://github.com/koala73/worldmonitor/pull/6531) landed the food-stocks operation into 1.7 KB of headroom and had to find the bytes to pay for it inside that same PR.

Two measurement corrections landed with this baseline:

- **Bytes, not code units.** The guard measured `JSON.stringify(spec).length`, which counts UTF-16 code units. The cap is a body-size cap in bytes and the descriptions carry non-ASCII punctuation, so the guard was reading 264 bytes low. It now measures UTF-8 bytes through `buildBundle()` — the same call that writes the artifact — so the gate cannot guard a document the build does not emit.
- **The report runs on every PR.** `unit` publishes `openapi-capacity.json` as a CI artifact plus a job summary, and the `changes` filter now routes `docs/api/worldmonitor.openapi.yaml` into that job. The bundle lives under `docs/`, which the filter excluded wholesale, so a PR that only regenerated it previously skipped the one gate that measures it.

## Where the bytes go

Sections of the served document:

| Section | Bytes | Share | Entries |
| --- | --- | --- | --- |
| `components.schemas` | 485,959 | 57.0% | 634 |
| `paths` | 348,722 | 40.9% | 216 |
| `components.parameters` | 9,450 | 1.1% | 39 |
| `components.responses` | 4,490 | 0.5% | 11 |
| `webhooks` | 3,539 | 0.4% | 1 |

Inside `paths`, cost by Operation Object field — this is where generated pressure shows up, because a field with a high per-operation cost is one an injector stamps fleet-wide:

| Field | Bytes | Per operation |
| --- | --- | --- |
| `responses` | 195,129 | 895 |
| `parameters` | 83,692 | 384 |
| `description` | 32,320 | 148 |
| `operationId` | 7,706 | 35 |
| `summary` | 6,853 | 31 |
| `requestBody` | 6,290 | 29 |
| `tags` | 6,196 | 28 |
| `security` | 2,790 | 13 |

## What is already collapsed

Four emit-time transforms run in `scripts/build-openapi-json.mjs`. None of them touch `docs/api/worldmonitor.openapi.yaml`, so Mintlify, the injectors and the contract tests still see the complete generated document.

| Transform | Effect on this bundle |
| --- | --- |
| `dedupeErrorResponses` | 11 repeated non-2xx bodies hoisted into 1,311 `$ref`s |
| `dedupeSharedParameters` | 39 fleet-wide parameters hoisted into 323 `$ref`s |
| `dedupeSharedChinaProvenanceSchemas` | 17 of 17 shared provenance value schemas reused |
| `dropUnreachableSchemas` | 210 schemas removed, 93,582 bytes |

2xx responses are never hoisted: orank credits only the inline `responses["200"]` schema, verified 2026-07-05.

`dropUnreachableSchemas` is new in #6558. The generator emits one component schema per RPC message, but a GET operation spends its request message as `parameters` and never points at the request schema, so 210 of 844 definitions were served while unreachable from every operation, response, parameter, header and sibling schema. A Schema Object documents something only through the `$ref` that reaches it, so removing one with no inbound pointer removes no documentation a client, agent or scanner could arrive at. `tests/openapi-unreachable-schemas.test.mjs` proves the served document has no dangling `$ref`, that every retained schema is byte-identical, and that nothing outside `components.schemas` changes.

## Reduction plan

77 repeated subtrees are still inline, worth about **31,130 bytes** if all were collapsed. Two rules keep that number honest, and both matter because it is what the next capacity decision will be sized from:

- **Non-overlapping.** A repeated parent and the repeated child inside it can only be spent once. The report attributes the bytes to whichever is hoisted first and excludes the other in both directions — the copies that sit inside a selection and the copies that wrap one.
- **Referenceable positions only.** A subtree is counted only where OpenAPI 3.1 actually permits a Reference Object. `responses.200.headers` is a `Map[string, Header | Reference]`, so its entries can be hoisted while the map cannot; a Media Type Object and an `example` payload cannot be hoisted at all; and a 2xx response is excluded by project rule because scanners credit only the inline one. Counting those positions would offer bytes no edit can take.

Ranked by yield against risk. Take them in order; each is independent.

### 1. Generalise the repeated-schema-subtree hoist — about 26.8 KB

`dedupeSharedChinaProvenanceSchemas` hoists exactly one hand-named family. The same shape repeats across unrelated services, because every service's generator emits the same optional-timestamp and unavailability unions:

| Repeated subtree | Copies | Unit | Recoverable |
| --- | --- | --- | --- |
| China decision-signal timestamp union | 9 | 698 | 5,232 |
| Climate `measuredAt` / `fetchedAt` | 33 | 107 | 2,016 |
| Provenance `content_freshness` value | 8 | 324 | 1,960 |
| Supply-chain war-risk tier enum | 5 | 467 | 1,692 |
| Provenance claims block | 2 | 1,424 | 1,380 |
| Economic `unavailable` envelope | 10 | 170 | 1,134 |
| Provenance confidence arm | 17 | 96 | 832 |
| Aviation `updatedAt` | 8 | 153 | 763 |

Replace the hand-named pass with a generic one: canonicalise every schema subtree, hoist any that repeats and exceeds a byte floor, keep the byte floor above the `$ref` cost. Safe by the same reasoning the parameter dedup already relies on — Schema Objects reached by `$ref` are not scanner-credited the way an inline 2xx response is, and only byte-identical subtrees group, so a definition whose description legitimately differs never collapses with another.

**Do this first.** It is the largest remaining block and needs no new empirical verification.

### 2. Hoist the repeated idempotency headers — about 4.3 KB

`Idempotent-Replayed` (17 copies, 217 bytes) and `Idempotency-Key` (17 copies, 142 bytes) are stamped verbatim onto the 200 responses of every idempotent operation. `components.headers` collapses them.

**Requires scanner re-verification before landing.** The response object stays inline, but a `$ref` would appear inside a 2xx body, and the rule that 2xx responses stay inline was established empirically against orank rather than from the spec. Re-run that check before spending this. Note the unit of work is the individual header entries, not the enclosing `headers` map — the map is not a referenceable position.

### 3. Per-operation `description` — 32,320 bytes, last resort

The largest single hand-written block. This is documentation, not repetition, and trimming it makes the spec worse for the agents it exists to serve. Only ever trim boilerplate prefixes that repeat verbatim across operations, and only after 1 and 2 are spent.

### Not on the table

- Raising the 950,000-byte budget.
- Removing operations, request bodies, or response schemas.
- Hoisting a 2xx response, or anything inside an `example` payload.
- `operationId`, `summary`, `tags` (20,755 bytes combined) — scanner-credited metadata.

## Triggers

`scripts/openapi-capacity-report.mjs` classifies the artifact on every `unit` run:

| Status | Condition | CI behaviour |
| --- | --- | --- |
| `ok` | headroom of at least 3 mean operations | `::notice::` with the numbers |
| `reserve-breached` | positive headroom below that reserve | `::warning::`, step still passes |
| `over-budget` | headroom below zero | `::error::`, step fails |
| `unmeasured` | zero operations or zero bytes | `::error::`, step fails |

The reserve is derived from the bundle's own mean cost per operation rather than being a fixed number, so it always means "room for three more operations like the ones already here". At this baseline that is 11,739 bytes.

`reserve-breached` warns rather than fails on purpose. The ceiling already has a hard gate; a second hard failure at the same wall would just be the same red build one commit earlier. The warning is the lead time — when it appears, take step 1.

`unmeasured` is deliberately not a pass. A bundle that generated nothing has enormous headroom, and reporting that as healthy is the exact failure this report exists to replace.
