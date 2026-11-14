# scripts

Applies to Railway seeders and relays under `scripts/`. Root `AGENTS.md` still applies (seed-meta, `loadEnvFile()`, `User-Agent`).

- Seeders (`seed-*.mjs`) use `runSeed(domain, resource, canonicalKey, fetchFn, opts)` from `_seed-utils.mjs`. Set `ttlSeconds` to at least 3x the seed's cron interval so one missed run does not expire the key.
- To add a new seeder or data source end to end, load the `add-data-source` skill.
