# server

Applies to RPC handlers and shared server code under `server/`. Root `AGENTS.md` still applies.

- RPC handlers read seeded data from Redis with `getCachedJson(key, true)` (`_shared/redis.ts`) and return the typed proto response. Use `cachedFetchJson()` for on-demand upstream fetches; it coalesces concurrent cache misses.
- To add or change an RPC, load the `add-rpc-endpoint` skill.
