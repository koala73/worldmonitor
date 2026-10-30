---
title: "Intel-history embedding migration runbook"
description: "Operator procedure for changing the embedding model or dimension behind the intelHistory vector index without mixing vector spaces. Public Mintlify docs never publish this procedure."
---

# Intel-history embedding migration runbook

Use this when the embedding model or its dimension behind `intelHistory`
has to change: a provider retires `text-embedding-3-small`, a better model is
adopted, or the dimension is tuned. **This is a table migration, not an edit
of a number.** Follow-up to #5694 / #5737; written for #5742.

Related: [Account deletion runbook](./account-deletion-runbook.md) for the
trusted-checkout conventions used below.

## The hazard, stated plainly

Every stored vector was produced by one model at one dimension. A vector
search ranks the query vector against stored vectors by cosine similarity,
and that number only means something when both come from the same space.
Mixing vectors from two models in one index is worse than a hard failure:
`search` keeps returning results, ranked against a scale that no longer
applies, and nothing errors.

A dimension change cannot even reach that state: Convex rejects a vector whose
length differs from the index's `dimensions`, so every insert fails after
deploy. A same-dimension model swap is the dangerous case, because every
insert succeeds.

## What pins the current space

Six places must agree. The parity suite `tests/intel-history-endpoints.test.mts`
pins the first four together; the last two are caches that self-invalidate.

| Literal | Where | Value today |
|---|---|---|
| `EMBED_MODEL`, `EMBED_DIMS` | `scripts/lib/brief-dedup-consts.mjs` | `openai/text-embedding-3-small`, `512` |
| `INTEL_HISTORY_EMBED_DIMS` | `convex/intelHistory.ts` | `512` |
| `INTEL_HISTORY_EMBED_MODEL` | `convex/intelHistory.ts` (#9885) | `openai/text-embedding-3-small@512`, stamped on every row |
| `dimensions` of `by_embedding` | `convex/schema.ts`, table `intelHistory` | `512` |
| `CACHE_VERSION` | `scripts/lib/brief-dedup-consts.mjs` | seeder-side embedding cache namespace; bump on any model or dimension change |
| `EMBED_CACHE_PREFIX` | `server/_shared/intel-history-embed.ts` | query-vector cache; derived from `EMBED_MODEL` and `EMBED_DIMS`, so it moves by itself |

Producers: `scripts/_seed-history.mjs` (`appendSeedHistory`, at most 150 rows
per run in chunks of 50) from `seed-conflict-intel`, `seed-energy-intelligence`
and `seed-cross-strait-activity`, through the secret-guarded relay route
`/relay/intel-history` in `convex/http.ts` into `internal.intelHistory.append`.
Readers: `search` (vector) and `timeline` (chronological), consumed by the
`get-similar-events`, `search-intel-history` and `get-intel-timeline` edge
handlers and the MCP tools that wrap them. Retention: `prune` ages rows out
180 days after `ingestedAt`, daily at 04:30 UTC.

## Read the inventory first

Use the paginated inventory from #9885 after that change is available in the
target deployment. From a trusted checkout with the production deploy key:

```sh
npx convex run intelHistory:embeddingModelInventory '{"limit": 200}'
```

Add each page's `models` counts to the census. If `partial` is true, pass its
`nextCursor` as `cursor` in the next call. Continue until `partial` is false.
The byte limit can end a page before `limit` rows. Do not raise the row limit
to bypass pagination or treat one page as the full table.

Expect the current model stamp plus `unstamped` for legacy rows. Unstamped
rows always belong to `openai/text-embedding-3-small@512`, even after the
current model changes. Any other stamp needs investigation before migration.
Use `scripts/measure-intel-history.mjs` to measure retained rows and bytes for
the cost estimate. It does not measure which deployments read the table.

## Cutover policy

Use a versioned table for both same-dimension model changes and dimension
changes. Keep the old vectors intact. Search serves the complete old space
until the new one passes validation, then all readers switch in one deploy.
Never put vectors from different models into one ranked result list.

The dual-write path, table-specific queries, retraction changes and backfill
helper below do not exist yet. Implement and test them in the migration PR
before starting this procedure. Changing only the shared constants is unsafe.

## Prepare two independent vector spaces

1. Record the old and new model IDs and dimensions in the migration PR.
   Estimate the embedding cost from the retained row count, plus new events
   during the backfill. Budget calls for both models during dual-write.
2. Add `intelHistoryV2` with the same event fields and secondary indexes as
   `intelHistory`. Give its `by_embedding` index the new dimension. Keep the
   old table, index, model constants and query cache namespace unchanged.
3. Give each space its own model, dimension, row stamp and embedding-cache
   namespace. Keep the existing `EMBED_MODEL`, `EMBED_DIMS`,
   `INTEL_HISTORY_EMBED_MODEL` and query-vector cache on the old space until
   the read flip. Add separate new-space configuration for the migration.
   Even two models with 512 dimensions need separate vectors and caches.
4. Generate two embeddings for each new event from the same input text.
   Send both vectors with explicit model identities through a versioned,
   secret-guarded relay contract. Validate each vector against its own model
   and dimension. Write the old vector only to `intelHistory` and the new
   vector only to `intelHistoryV2`. Do not copy one vector into both tables.
   Reject an incomplete pair so a retry can complete the event atomically.
5. Serialize dual append, backfill and retraction with the same append-lock
   document. Keep the existing append lock and dedupe checks in the write
   transaction. Check `intelHistoryRetractions` before every target insert.
   A tombstone must prevent both a live append and a delayed backfill from
   recreating a retracted event.
6. Update `retract` to delete matching `dedupeKey` rows from both tables in
   the same transaction that writes the tombstone. A tombstone alone does
   not hide a row already copied to V2. Keep `restore` explicit. It removes
   the tombstone but does not restore previously deleted rows by itself.
7. Apply the 180-day retention policy to both tables. Preserve each event's
   original `ingestedAt` and `occurredAt` during backfill. Copying a row must
   not restart its retention window.
8. Deploy dual-write with all reads still on the old table. Verify a new
   event appears with different, correctly stamped vectors in both tables.
   Verify retraction deletes it from both tables and blocks reinsertion.

## Backfill and validate

The helper must live in `scripts/`, load credentials with `loadEnvFile`, and
use only packages allowed by the Railway boundary. It must page source rows
in bounded batches and save a resumable cursor. Follow the pagination pattern
in `scripts/measure-intel-history.mjs`; do not load the table into one query.

For each source row, generate the new-space vector from the same text used
by the producer. Submit the full event record and new vector to a dedicated
secret-guarded migration route. Its mutation must insert a complete,
validated V2 row, keyed by `dedupeKey`. Patching only `embedding` and
`embeddingModel` in the source row is not this migration.

The target mutation must check retention eligibility and the retraction
tombstone under the append lock before insertion. Skip a target row already
present with the expected model and dimension. Stop on a conflicting row.
Advance the saved cursor only after the chunk commits. A retry must not
rewrite vectors already accepted in V2 or recreate deleted source rows.

Before the read flip:

- Complete the paginated inventory of each table. Every target row must
  have the new stamp and dimension. No unstamped row belongs in V2.
- Compare eligible `dedupeKey` sets and event fields in bounded pages.
  Matching totals alone do not prove completeness. Account for concurrent
  appends, retractions and retention expiry before accepting the comparison.
- Test `search`, `timeline` and hydration against V2 through a separate
  validation path. Generate validation queries with the new model. Check
  known historical answers and foreign-model rejection.
- Test a retraction during backfill, a retry after a committed chunk, and
  pruning. Confirm no deleted or expired event becomes visible in V2.

## Flip readers and retain rollback

1. Switch `search`, `timeline` and `getByIds` to V2 in one deploy. Switch
   query embedding configuration and its cache namespace to the new space
   in that same deploy. Update the parity tests to pin each table's own
   producer, validator, query model and index dimensions.
2. Keep dual-write and pruning active for both tables during the rollback
   window. Keep retraction deletion active for both tables too. Stopping old
   writes at the flip would make a later rollback omit new events.
3. Verify the edge handlers and MCP consumers read V2 and produce expected
   historical results. Record the deployed revision and observed checks.
4. If validation fails, switch all readers and query configuration back to
   the old space. The old table still contains its original vectors and
   events written during the rollback window. No reverse re-embedding is
   needed because this procedure never overwrites the old space.
5. Close rollback only after explicit operator acceptance. Record that
   choice before stopping old-space embedding and writes. After old writes
   stop, a later rollback requires reconciliation of missing events and
   retractions; reverting constants alone is no longer sufficient.
6. Before retiring the old table, take and verify a recoverable backup.
   Audit deployed readers, workers, relay routes, scheduled functions and
   clients for old-table references. Observe access telemetry over the
   agreed drain window and remove old read paths. The storage measure
   script cannot prove that no reader remains. Retain the table for the
   planned 180-day window unless an operator separately approves earlier
   retirement with this evidence.
7. After retirement, keep `retract`, `restore`, append and prune on V2 and
   keep the shared tombstones. Remove obsolete dual-write code and old
   configuration in the retirement change.

## Drill

This procedure has not been exercised against a live deployment. Do not
start a production model swap until the migration code and helper exist.
Run a dev-deployment drill for both a same-dimension model change and a
dimension change. Record the revisions, row reconciliation, retraction race,
read-flip results, rollback results, elapsed time and embedding spend here.
Unit tests of model stamps and inventory pagination do not prove this drill.
