---
name: add-rpc-endpoint
description: Add a WorldMonitor JSON API endpoint as a sebuf RPC — proto definition, make generate, handler, gateway, client wrapper, and contract checks. Use when adding or changing an RPC method or service, or when tempted to add a standalone api/*.js or api/*.ts data endpoint.
metadata:
  internal: true
---

# Add an RPC endpoint

Full walkthrough with examples: [docs/adding-endpoints.mdx](../../../docs/adding-endpoints.mdx). Framework notes: [CONTRIBUTING.md#working-with-sebuf-rpc-framework](../../../CONTRIBUTING.md#working-with-sebuf-rpc-framework).

## Rules

- Every JSON data API uses sebuf. Do not add standalone `api/*.js` or `api/*.ts` data endpoints. `npm run lint:api-contract` rejects any `api/` file that is neither a sebuf gateway nor listed in `api/api-route-exceptions.json`; that manifest is only for OAuth callbacks, binary responses, upstream proxies, and operator plumbing, and is CODEOWNERS-pinned.
- Never hand-edit `src/generated/` or `docs/api/`. Edit the proto and regenerate.
- Time fields are `int64` Unix epoch milliseconds with `[(sebuf.http.int64_encoding) = INT64_ENCODING_NUMBER]`, not `google.protobuf.Timestamp`.
- Every RPC needs `option (sebuf.http.config) = { path: "...", method: POST }` (or the method the neighbouring RPCs use).

## Steps

1. Add messages and the RPC in `proto/worldmonitor/{domain}/v1/`.
2. `make generate` (needs Go, buf, and sebuf plugins pinned by `SEBUF_VERSION` in the `Makefile`; `make install-buf install-plugins`). If the toolchain is unavailable, say so; CI's proto job appends a `chore(proto): update generated artifacts` commit for same-repo branches.
3. Implement the handler in `server/worldmonitor/{domain}/v1/`. Read seeded data from Redis with `getCachedJson(key, true)` (`server/_shared/redis.ts`); use `cachedFetchJson()` for on-demand upstream fetches, with every request-varying parameter in the cache key.
4. A new service also needs its gateway `api/{domain}/v1/[rpc].ts` and the dev-server handler import in `vite.config.ts`.
5. Wrap the generated client in `src/services/{domain}/`.
6. Decide access: premium paths in `PREMIUM_RPC_PATHS` (`src/shared/premium-paths.ts`), unauthenticated ones in `PUBLIC_NO_AUTH_RPC_PATHS` (`server/gateway.ts`).

## Verify

- `make lint` and `make breaking` for proto changes.
- `npm run lint:api-contract`, `npm run typecheck:api`, a focused handler test, then `npm run test:related`.
- Confirm the generated diff matches the proto change only.
