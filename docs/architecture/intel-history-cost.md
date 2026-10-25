# Intel-history cost measurements

Issue [#5745](https://github.com/koala73/worldmonitor/issues/5745) requires a measured storage and embedding-cost baseline before adding collectors. This telemetry prepares that baseline. It does not enable a collector, run a backfill, or establish production acceptance before deployment and observation.

## Embedding accounting

`appendSeedHistory` records each configured append attempt under its domain, resource, model, and UTC start day. This includes the batches used by Cross-Strait recovery. Repeating an append counts as a new attempt because it can incur new embedding spend. Relay retries do not repeat embedding.

The shared embedding client reports cache hits, cache misses, and provider response usage through a synchronous observer. Other embedding consumers keep their existing return values and do not write the history ledger. The collector whose request misses the shared cache receives the spend attribution. A later collector can reuse the cached vector at zero additional embedding spend.

| Counter | Meaning |
| --- | --- |
| `runs`, `failedRuns` | Configured append attempts, and attempts that threw an error. Partial relay failures are also visible through `failedChunks` and `abandoned`. |
| `inputTexts`, `uniqueTexts`, `cacheHitTexts` | Normalized history inputs after the existing cap, distinct embedding texts, and distinct texts served from Redis. |
| `providerInputs`, `providerRequests` | Texts sent to the embedding provider and requests attempted. A failed transport still counts as an attempted request. |
| `knownCostUsd` | Sum of valid, nonnegative provider-reported `usage.cost` values. This is a lower bound when requests have unknown cost. No token-price estimate is substituted. |
| `unknownCostRequests` | Provider requests without valid reported cost, including transport errors and malformed response bodies. |
| `knownPromptTokens`, `unknownTokenRequests` | Reported `usage.prompt_tokens` and requests without a valid token count. |
| `unknownEmbeddingRuns` | Attempts with candidate records whose embedder did not report usage. This indicates an accounting gap. |
| `inserted`, `deduped`, `retracted` | Confirmed relay outcomes. A lost relay response can leave committed records unconfirmed. |
| `failedChunks`, `abandoned` | Rejected chunks and records not sent because the append budget expired. |
| `firstObservedAt`, `lastObservedAt` | Earliest and latest attempt start times in the recorded UTC day. |

A completely cached batch has known zero additional spend. Missing provider cost is unknown, even when its known-cost subtotal is zero. Usage is captured before vector validation, so a paid response with invalid vectors is still accounted for. Relay failure does not erase embedding spend.

The [OpenRouter embedding response](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request) includes usage statistics. Cost is accepted only when the actual response supplies a finite, nonnegative numeric `usage.cost`. The implementation adds no provider requests for telemetry.

## Durable daily totals

The Redis hash key is:

```text
intel-history:cost:v1:<encoded-domain>:<encoded-resource>:<encoded-model>:YYYY-MM-DD
```

Each scope component uses `encodeURIComponent`. The model is currently `openai/text-embedding-3-small`. One Lua command validates the existing counters before atomically adding the observation. Concurrent collectors cannot overwrite totals. The hash expires at midnight UTC after the recorded day plus 200 days. Expiry does not move when a delayed observation arrives.

The self-hosted Redis REST proxy pins the exact update script. Script changes must update both copies; the command-gate test checks the actual command emitted by the writer and rejects modified Lua.

The canonical key, its seed-meta, and ingestion-health semantics are unchanged. The default 30-second append budget reserves two seconds for the ledger write, leaving 28 seconds for embedding and relay requests. The ledger request has no retry. If a write response is lost, its commit status is unknown; retrying could double-count paid work.

Every configured attempt emits an `[intel-history-cost]` JSON log with `recorded: true` only after Redis confirms the update. A missing credential, rejected update, or timeout emits `recorded: false`. A telemetry failure cannot replace the append result or error. Logs contain counters and collector identity, not feed text, vectors, credentials, or provider response bodies.

These totals are observed spend, not an exactly-once billing ledger. A process crash before persistence can lose an observation. A missing provider response can hide a charge. Check `recorded: false` logs and run coverage before using a daily subtotal as a complete baseline. Both unknown-cost counters must be zero, and token coverage must be checked separately when reporting tokens.

## Read measurements

Run these commands from the intended checkout. They use `loadEnvFile` and print aggregate JSON to stdout. Neither command writes production state.

```sh
node scripts/measure-intel-history.mjs --cost \
  --domain energy --resource intelligence --day 2026-10-19

node scripts/measure-intel-history.mjs --storage --max-rows 100000 > before.json
```

The cost command requires the Upstash URL and token. A missing hash returns `status: "not_observed"`, with no fabricated zero counters. `reportedUsageComplete` means the stored observations have no unknown embedding usage or cost. It does not assert that every scheduled attempt was persisted.

The storage command requires `CONVEX_URL` and `CONVEX_DEPLOY_KEY`. It reads `intelHistory` through the same system query used by `convex data`, in pages of at most 500 rows. Each request has a 15-second timeout. The scan stops at `--max-rows`, which must be between 1 and 1,000,000. A row-limited scan reports `complete: false` and exits with code 2. An API or validation failure exits with code 1. A fully read empty table is a complete zero.

Per-domain/resource storage results include:

- Retained row count.
- `documentBytes`, calculated from the complete stored documents with Convex's `getDocumentSize`, including system fields.
- `rawVectorBytes`, the number of stored vector components multiplied by eight bytes per float64.

`rawVectorBytes` is included in document storage and must not be added to `documentBytes`. Neither field measures vector-index overhead, read bandwidth charges, or billed index storage. `vectorIndexBilledBytes` stays `null`. Read the actual index-storage measurement and billing rate from the Convex deployment dashboard and record its timestamp separately.

The command discards each page after aggregation and does not print or save record content. It scans a live table rather than an atomic snapshot. Inserts, pruning, or retractions during a scan can affect comparisons; the output records its start and finish times. Compare complete scans taken at the same UTC time, note concurrent maintenance, and retain the original JSON with the measurement report.

## Observe before widening

After a separately authorized deployment:

1. Confirm cost hashes for conflict/acled-intel, military/cross-strait-activity, and energy/intelligence after their next natural runs. Compare daily `runs` with collector logs. Search for `[intel-history-cost]` and `"recorded":false`.
2. Collect complete UTC days across several natural collector cycles and record the observation window. Keep provider-reported spend, unknown requests, cache volume, and inserted-row volume separate.
3. Capture complete storage snapshots before and after that window. Record document growth per scope and deployment-level vector-index storage separately. Label any retention or price projection as an estimate.
4. Check the growth against the 180-day retention window and agree on the next collectors and budget before adding them. A healthy ingestion record alone cannot satisfy this gate.

If telemetry failures persist for two collector cycles, treat that window as incomplete and investigate the ledger logs and Redis permissions. Canonical seed publication must remain healthy. Revert the telemetry change if it disrupts publication or materially increases failure rates; a green ledger does not replace existing ingestion-health checks.

Do not run historical backfill while the cost baseline remains incomplete. This preserves the existing organic accumulation policy and avoids additional unmeasured spend.
