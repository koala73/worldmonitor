---
name: add-data-source
description: Add a new WorldMonitor data source or map layer end to end — Railway seeder, Redis seed-meta and health registration, RPC, service, layer toggle, source attribution, and docs. Use when integrating a new API or dataset, adding a seed-*.mjs worker, or adding a map layer.
metadata:
  internal: true
---

# Add a data source

Source: [CONTRIBUTING.md#adding-data-sources](../../../CONTRIBUTING.md#adding-data-sources). Health contracts: [docs/health-endpoints.mdx](../../../docs/health-endpoints.mdx).

## Requirements

- Freely accessible (no paid-only API for core functionality), permissive license or public government data, updates at least daily, geo-locatable.

## Steps

1. Seeder (if the data is cached): a `scripts/seed-*.mjs` built on `runSeed(domain, resource, canonicalKey, fetchFn, opts)` from `scripts/_seed-utils.mjs`. Set `ttlSeconds` to at least 3x the cron interval. Load credentials with `loadEnvFile()` only. The seed must write `seed-meta:<key>`. Send a `User-Agent`. Follow a neighbouring seeder's Railway registration in `scripts/railway-services.json`.
2. Health: register the key in `api/health.js` (`BOOTSTRAP_KEYS`, `STANDALONE_KEYS`, `SEED_META`, or `ON_DEMAND_KEYS`). Datasets with no dashboard consumer are standalone health keys.
3. Shared startup data goes through `api/bootstrap.js`; opt-in panels stay on the on-demand path.
4. RPC: follow the `add-rpc-endpoint` skill (proto, `make generate`, handler in `server/worldmonitor/{domain}/v1/`, gateway, `vite.config.ts`). Non-JSON payloads (XML, binary, HTML embeds) may use a standalone Edge function listed in `api/api-route-exceptions.json`.
5. Service module in `src/services/{domain}/` wrapping the generated client.
6. Layer config and renderer following existing layer patterns; make it toggleable in the layer UI. Panels register in `src/config/panels.ts` and `src/app/panel-layout.ts`.
7. Every new outbound host in `scripts/`, `server/`, `api/`, or `src/` needs a row in `shared/source-attribution-manifest.json`: `npm run sources:check`, then `npm run sources:generate`. Add a manifest row only together with the code that introduces its host; after a rebase that touches attribution, re-run `sources:generate` instead of hand-merging.
8. Document the source in the data sources docs (`docs/data-sources.mdx`).

## Verify

- Producer and reader checks with fixtures (no live network in tests). Record live freshness separately when it matters.
- `npm run typecheck`, `npm run typecheck:api`, `npm run lint:boundaries`, `npm run test:related`, `npm run generate` if derived files changed.
- Browser behavior: the `verify-worldmonitor` skill.
