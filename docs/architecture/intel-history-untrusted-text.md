# Untrusted feed text in the intel-history store

The settled decision on how the durable historical intelligence store
(`convex/intelHistory.ts`, shipped in #5694 / #5737) handles third-party feed
text that reaches LLM agents, and the supported way to retract a record.

Resolves #5743. Read this before re-opening the question.

---

## The problem, stated precisely

The three retrieval tools — `search_intel_history`, `get_intel_timeline`,
`get_similar_events` — return `title`, `summary` and `sourceUrl` exactly as the
producing seeder received them from an upstream feed. The energy collector, for
instance, maps RSS `title` and `summary` straight through. An LLM agent reading
a tool result cannot tell feed text from instructions unless something tells it,
so a headline reading *"Ignore previous instructions and…"* is an
indirect-prompt-injection payload.

**This is not a new channel.** The existing news tools have exactly the same
one, and every WorldMonitor surface that feeds third-party text into an LLM has
had it since #3724.

**What is new is the exposure window.** Live seed keys in Redis overwrite
themselves every cycle, so a poisoned item was reachable for hours. History is
durable and queryable for the full 180-day retention period, and semantic
search will surface an old record whenever it is the best match for someone's
query. A single bad feed item becomes a long-lived retrievable payload instead
of a transient one — and, being the best semantic match for a narrow query, it
can be *more* reachable than it ever was live.

That difference in duration is why the inherited default needed to become an
explicit decision rather than being carried over silently.

---

## Decision 1 — Ingest stores verbatim. Retrieval marks provenance.

**We do not sanitize, strip, or neutralize instruction-shaped text at ingest.**

Three reasons, in order of weight:

1. **It is an archive.** A record whose text was silently edited on the way in
   is no longer evidence of what the source published. "What did this outlet
   actually say on the 14th" is a question this store exists to answer, and a
   blocklist pass destroys the answer irreversibly — there is no original to
   fall back to.
2. **It desynchronizes the vector.** The stored embedding is computed from the
   title and summary (`buildHistoryEmbeddingText` in `scripts/_seed-history.mjs`).
   Sanitizing the text after embedding leaves a row whose vector describes text
   that is no longer in the row; sanitizing before it changes what the record
   is findable by. Neither is a property we want a retrieval store to have.
3. **An ingest-time blocklist cannot be improved retroactively.** Injection
   patterns evolve. A filter applied 180 days ago is frozen; anything it missed
   is permanently in the store as clean text, and anything it over-matched is
   permanently damaged. Controls at the read boundary apply to every row on
   every read, including rows stored before the control existed.

**What ingest does enforce is structural, not semantic:** length caps on every
field, a required finite `occurredAt`, a 512-dimension all-finite embedding,
and `sourceUrl` restricted to `http(s)` at *both* boundaries (the seeder drops
the field, the relay route rejects the record — #5740). Those are cheap,
decidable, and have no false positives on legitimate content. Semantic
"does this text look like an instruction" judgements are none of those things.

**At retrieval we mark provenance instead** — on the surfaces that actually
reach the consumer, which is a narrower set than it first appears.

> **The trap, learned the hard way.** The obvious place to put this is the
> `outputSchema` field descriptions, and that was the first implementation.
> It does not work on its own: many MCP hosts hand the model only the tool's
> compressed `description` and `inputSchema` and **drop `outputSchema`
> entirely**. Verified against a live claude.ai session — the flagship host —
> where the tool arrived with no `outputSchema` at all. An agent could read
> every marked field and never see one word of the marking. If you are adding
> a warning to an agent-facing tool, confirm the channel delivers before
> counting it as a control.

| Surface | Where the marking lives | Reaches an LLM agent? |
|---|---|---|
| **MCP server instructions** | The `Content safety:` stanza in `SERVER_INSTRUCTIONS` (`api/mcp/constants.ts`), returned in `initialize.result.instructions`, which the MCP lifecycle spec has clients surface to the model. | **Yes — this is the primary channel.** Delivered verbatim, once per session, to every agent regardless of host. |
| MCP tool description | A content-safety clause at the end of every affected tool description. `tools/list` compresses to the first sentence, so this arrives via `describe_tool`, which the instructions tell agents to call. | Partially — only if the agent asks for the full definition. |
| MCP `outputSchema` | `INTEL_HISTORY_RECORD_SCHEMA` in `api/mcp/registry/rpc-tools.ts` — `title`, `summary`, `sourceUrl` and `resource`. | **Host-dependent; assume no.** Kept because it is the contract REST clients and `describe_tool` read. |
| REST / OpenAPI | The `UNTRUSTED CONTENT` note and per-field comments on `IntelHistoryRecord` in `proto/worldmonitor/intelligence/v1/intel_history_record.proto`, which flow into the generated specs. | N/A — human and client-generator surface. |
| Docs | The Historical intelligence sections of `docs/mcp-tools-reference.mdx` and `docs/mcp-overview.mdx`, plus their `docs/zh` mirrors. | N/A — human surface. |
| Structured provenance | `resource` names the producing feed and `sourceUrl` the underlying report, so a consumer that wants to weight records by source already can. | Yes — in every response body. |

`tests/intel-history-untrusted-content.test.mjs` pins all of them, and treats
the `SERVER_INSTRUCTIONS` stanza as the load-bearing one.

This matches what the repo already does everywhere else it hands untrusted text
to a model: the `SECURITY:` guardrail in `chat-analyst-prompt.ts` and
`deduction-prompt.ts` marks live context as untrusted DATA, and every published
agent skill carries a `## Content safety` section enforced by
`tests/agent-skills-index.test.mjs`. Marking, not mutation, is the house style —
because the consumer is the party that can actually act on the knowledge.

### What this knowingly accepts

A consuming agent that ignores the marking is still injectable. Provenance
marking reduces the risk; it is not a boundary. We accept that, for the same
reason we accept it on the news tools: the alternative — mutating an
intelligence archive on a bypassable blocklist heuristic — costs the product's
core property and does not close the hole either. `server/_shared/llm-sanitize.js`
says the same thing about itself in its own header.

What makes the durable case *different from* the news case, and therefore
acceptable, is the retraction path below. A poisoned news item ages out on its
own within hours. A poisoned history record would not, so it needed a way out.

---

## Decision 2 — Retraction is a first-class, tested operation

Before #5743 there was no way to remove a single record short of a hand-run
Convex console operation. There is now.

```bash
# Retract: delete the rows and keep the seeder from re-adding them.
node scripts/retract-intel-history.mjs \
  --dedupe-key energy:intelligence:oilprice-9f3a-1780000000000 \
  --reason "instruction-shaped headline, #5743"

# Identifiers are repeatable and may be mixed. Every retrieval path
# projects `id`, so a search result is enough to act from.
node scripts/retract-intel-history.mjs --id <doc-id> --id <doc-id> --reason "…"

# Review what is currently suppressed.
node scripts/retract-intel-history.mjs --list

# Lift a retraction made in error.
node scripts/retract-intel-history.mjs --restore --dedupe-key <key>
```

`--dry-run` prints the resolved request without sending it. The tool reads
`.env.local` exactly as the seeders do, so a normal checkout needs no extra
setup. Behind it are three secret-guarded relay routes
(`/relay/intel-history/retract`, `/restore`, `/retractions`).

### Credentials — set `RELAY_RETRACT_SECRET`

`RELAY_SHARED_SECRET` is held by every Railway seeder that appends history.
That wide distribution was acceptable when the worst a leak could do was write
false intelligence, because the real rows survived alongside it. Retraction
deletes rows and permanently suppresses their identities, and that direction
does not undo — `restore` cannot resurrect a row whose embedding is gone.

The three retraction routes require `RELAY_RETRACT_SECRET` exclusively. There
is no `RELAY_SHARED_SECRET` fallback: if the dedicated credential is absent,
the routes fail closed rather than granting the seeder fleet deletion
authority. Set it on the Convex deployment and in the operator's environment;
do **not** put it on the seeder services, which is the entire point. Ingest
continues to require `RELAY_SHARED_SECRET`.

### Why deletion alone would not have worked

`append` decides "have I seen this event?" by looking for an existing row with
the same `dedupeKey`. The seeders republish a rolling window on every run, and a
retraction does not change what the upstream feed is serving. So a bare delete —
exactly what a console operation performs — is undone by the next seed tick,
usually within the hour.

Every retraction therefore writes a **tombstone** on the `dedupeKey`
(`intelHistoryRetractions`), which `append` consults before inserting. That is
what makes a retraction hold. `convex/__tests__/intelHistory.test.ts` pins both
halves, including a characterization test that a bare row delete *is* resurrected
by the next append — so if the tombstone ever stops being consulted, the
retraction path fails loudly instead of quietly becoming theatre.

### Properties worth knowing

- **Explicit identifiers only.** No pattern, prefix, or scope arguments, and at
  most 100 identifiers per call. Retraction erases evidence from an intelligence
  archive; "delete everything matching this substring" is the wrong amount of
  power to reach through a shared relay secret.
- **`--reason` is mandatory.** A tombstone outlives the incident by up to 180
  days. "Why is this key suppressed?" has to be answerable from the record the
  operator left behind, and it is also written to a `intel_history_retracted`
  breadcrumb in the Convex logs.
- **Retracting an identity that was never stored works,** and is the way to
  pre-emptively suppress a known-bad upstream id.
- **A `--id` that no longer resolves is an error, not a quiet success.** A row
  that was already pruned or retracted has no document id left, so there is no
  `dedupeKey` to tombstone. When *no* identifier resolves the call is rejected
  outright; when only some fail, the CLI names them and tells you to re-run
  with `--dedupe-key`. Reporting `deleted: 0` as success here would be the
  worst possible outcome — it reads as "already clean" while the next seed tick
  re-adds the record.
- **`--restore` lifts the tombstone; it does not resurrect the row.** The
  embedding is gone and nothing here can recompute one. If the event is still
  inside the seeder's live window it reappears on the next tick; if it is not,
  the deletion stands.
- **Tombstones expire 180 days after the producer stops offering the item,**
  not 180 days after the operator acted. Every append the tombstone suppresses
  refreshes its `retractedAt`, so a feed that keeps serving a poisoned item
  keeps the suppression alive by construction; expiry only starts running once
  the item stops appearing. Re-running `retract` refreshes it too. Once the
  producer does stop, the tombstone drains in the existing
  `intel-history-prune` cron and a much-later re-publish would be stored again
  — pinned by a test, so it is a documented behaviour rather than a surprise.
- **One upstream item can be several records.** The tombstone keys on the
  seeder's `dedupeKey`, and two producers deliberately mint more than one per
  source item: a GDELT article that is a location hit for three countries is
  stored as three rows (`gdelt-<cc>-<hash>`, one per country), and cross-strait
  observations are revised in place under a stable id, so retracting one
  suppresses every later corrected vintage of it too. **Retract every id the
  search returned, not just the first**, and re-search by title or `sourceUrl`
  afterwards to confirm no sibling survived.
- **An upstream edit can mint a new identity.** Suppression binds to the
  `dedupeKey`, which the producers derive from properties of the source item —
  so an item whose identity-bearing properties change comes back under a key no
  tombstone covers. The known case is energy: the id is
  `<source>-<hash(url)>-<publishedAt>`, and `publishedAt` falls back to an Atom
  `<updated>` timestamp when the feed has no `pubDate`, which a publisher can
  move by editing the entry. `tests/seed-history-wiring.test.mjs` pins that the
  keys are *stable* run-to-run (no clock, no run id), which is what makes
  retraction work at all; it cannot pin that an upstream publisher never edits.
  After retracting, re-search once on the next seed cycle. Tracked separately:
  the ACLED id collapses every event missing `event_id_cnty` onto
  `acled-undefined` (#5782), which makes a tombstone on that key far broader
  than intended.
- **Ingest reports suppression.** `append` returns a `retracted` count that the
  seeder logs as `[intel-history] <domain>/<resource> appended N, deduped M,
  retracted R`. A nonzero `R` in the Railway logs is the signal that a tombstone
  is still doing work.

### Propagation: a retracted record can still be served for about an hour

The retraction is immediate at the store. Two read caches in front of it are
not, and neither can be purged for one record:

| Layer | TTL | Why it cannot be targeted |
|---|---|---|
| Redis success cache (`cacheSuccessfulHistoryRead`) | 30 min | Keys are SHA-256 hashes of the normalized *request*, so there is no way to ask "which cached responses contained this record". Only a blanket prefix flush would work. |
| CDN, `get-intel-timeline` only | `s-maxage=3600` on Vercel, `1800` on Cloudflare, plus `stale-while-revalidate` | Same problem, one layer further out, and the two POST routes are not CDN-cached at all. |

So budget **roughly an hour** before a retracted record stops appearing
anywhere, and re-check rather than assuming. That tail is bounded and known;
it is a different order of magnitude from the 180 days this whole decision is
about, which is why it is documented rather than engineered around. If a
retraction is ever urgent enough that an hour matters, flush the
`intel-history:read:v1:*` Redis prefix and purge the CDN by hand — but that is
an incident call, not the routine path.

---

### Rollback

Reverting this change is safe for the store but **does not lift the
retractions**. Removing `intelHistoryRetractions` from `convex/schema.ts`
stops the table being validated; it does not delete the rows, which sit there
inert. What *does* change is that `append` stops consulting them, so every
retracted identity becomes re-insertable on the next seed tick — a revert
silently un-suppresses everything an operator ever retracted.

If that matters, `--list` the tombstones and record them before reverting, then
re-apply the suppression by hand (or re-land this change) afterwards. Reverting
before any retraction has happened is unconditionally safe.

## If you are here to re-litigate this

The two questions that are settled: **ingest does not mutate text**, and
**retrieval marks provenance rather than rewriting**. Both are argued above.

The question that stays open on purpose is whether provenance marking is enough
for a given consumer. It is a floor, not a ceiling — a downstream surface that
needs a stronger guarantee should apply its own control at *its* boundary, where
it knows what it is protecting, rather than asking the archive to lie about what
a source published.
