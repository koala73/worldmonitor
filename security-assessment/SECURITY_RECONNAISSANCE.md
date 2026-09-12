# World Monitor Security Reconnaissance

## 1. Technology Stack

A comprehensive static reconnaissance was conducted against the target codebase `worldmonitor-main/` located at `..\SIH 26163\worldmonitor\worldmonitor-main`.

### Discovered Core Technologies
- **Frontend Framework**: Preact (`preact` v10.25) with Vite 6 build system, MapLibre GL, Deck.gl, Globe.gl, D3.js, i18next, DOMPurify, and Tailwind CSS.
- **Desktop Runtime**: Tauri v2 desktop shell (`@tauri-apps/cli` v2.10) for cross-platform desktop execution.
- **Serverless / Edge Backend**: Vercel Edge Functions (`@vercel/functions` v3.7).
- **Backend Database / BaaS**: Convex (`convex` v1.32) serverless real-time database with schema validation (`convex/schema.ts`).
- **Caching & Rate Limiting**: Upstash Redis (`@upstash/redis` v1.36, `@upstash/ratelimit` v2.0) accessed via HTTP REST endpoints.
- **Object Storage**: Cloudflare R2 / AWS S3 (`aws4fetch` v1.0, `@aws-sdk/client-s3` v3.1009).
- **Payment Processing**: Dodo Payments (`@dodopayments/convex` v0.2, `dodopayments-checkout` v1.8).
- **Authentication**: Clerk (`@clerk/clerk-js` v6.13, `server/auth-session.ts` using `jose` v6.2 RS256 JWKS validation), Passkeys/WebAuthn, and `wms_` HttpOnly session cookies.
- **API Architecture**: Vercel Serverless API endpoints (`/api/*`), custom Sebuf (Protobuf over HTTP) RPC Gateway (`server/gateway.ts`), and Model Context Protocol (MCP) tool endpoints (`/api/mcp/*`).
- **Package Manager**: npm with lockfile `package-lock.json`.

---

## 2. Attack Surface Summary

The attack surface of `worldmonitor-main` consists of three primary entry tiers:
1. **Public Web & Edge API Surface**: Exposed via Vercel Edge routing (`api/`, `middleware.ts`, `vercel.json`). Accepts HTTP GET, POST, and OPTIONS requests.
2. **Sebuf RPC Subsystem Gateway**: Routed via `server/gateway.ts` to ~17 domain RPC modules handling geopolitical, military, financial, and environmental data telemetry.
3. **Desktop Tauri Sidecar Surface**: Local RPC/API server (`src-tauri/sidecar/`) binding to localhost for desktop application integration.

---

## 3. API Inventory

`worldmonitor-main` implements ~100+ serverless and RPC route handlers. Below is an inventory of key functional categories:

### A. Core Edge Public & Meta Endpoints
- `GET /api/version` — Public version info (Unauthenticated).
- `GET /api/health` — Service health probe (Unauthenticated).
- `GET /api/product-catalog` — Product pricing metadata (Unauthenticated, Redis-cached).
- `GET /api/llms.txt` — AI agent discovery document (Unauthenticated).
- `GET /api/download.md` — Curated static markdown export (Unauthenticated).

### B. Session, Auth & OAuth Endpoints
- `GET/POST /api/wm-session` — Session management (`wms_` HttpOnly session cookie creation/validation).
- `POST /api/oauth/token` — OAuth token exchange (Rate limited via Upstash).
- `GET /api/oauth/authorize-pro` — Pro tier OAuth authorization flow.
- `POST /api/user/passkey-offer` — WebAuthn / Passkey registration offer.

### C. Sebuf RPC Gateway Subsystems (`/api/<subsystem>/v1/[rpc].ts`)
All subsystem requests are dispatched through `server/gateway.ts`:
- `military` — Military asset and activity telemetry.
- `news` — News intelligence feeds and AI summarization.
- `sanctions` — Global sanctions and watchlist tracking.
- `natural` — Disasters and natural hazard events.
- `trade` — Global trade and shipping flows.
- `unrest` — Civil unrest and event monitoring.
- `prediction` — Geopolitical prediction market feeds.
- `research` — Deep research reports and corpus data.
- `resilience` — National resilience indicators.
- `supply-chain` — Supply chain cost shock and chokepoint models.
- `seismology` / `thermal` / `radiation` / `webcam` / `wildfire` — Physical sensor telemetry.
- `scenario` — Scenario simulation runner (`/api/scenario/v1/run.ts`, `/api/scenario/v1/status.ts`).

### D. AI & Model Context Protocol (MCP) Endpoints
- `POST /api/mcp/*` — Model Context Protocol tool execution for AI assistants.
- `GET/POST /api/user/mcp-quota` — User MCP daily usage quota check.
- `POST /api/user/mcp-revoke` — Revoke active MCP integration keys.

### E. Webhook Integration Endpoints
- `POST /api/v2/shipping/webhooks/[subscriberId]` — Shipping event webhooks.
- `POST /convex/payments/webhookMutations` — Dodo payment status updates.
- `POST /convex/resendWebhookHandler` — Resend email event webhooks.

---

## 4. Authentication Architecture

### JWT / Clerk Session Flow (`server/auth-session.ts`)
- **Bearer Token Verification**: Requests carrying `Authorization: Bearer <token>` are verified at the Vercel edge runtime using `jose`'s `jwtVerify()` and remote JWKS key fetching from `process.env.CLERK_JWT_ISSUER_DOMAIN`.
- **Key Rotation & Caching**: JWKS public keys are memoized in `_jwks` (`createRemoteJWKSet`) across warm edge invocations.
- **Fail-Safe Contract**: Authentication failures return `null` and log warnings; the gateway cleanly falls back to keyless or API-key authentication policies without unhandled crashes.

### Internal Service HMAC Signing (`server/_shared/mcp-internal-hmac.ts`)
- **Header Verification**: Internal sub-requests (e.g. between Vercel edge workers and internal MCP services) use SHA-256 HMAC signatures passed in `X-WM-MCP-Internal`, `X-WM-MCP-Nonce`, `X-WM-MCP-User-Id`.
- **Replay Protection**: Nonces are checked against a Redis replay cache with a 300-second TTL.

### API Keys (`server/_shared/usage-identity.ts`, `api/_api-key.js`)
- API keys are hashed synchronously using SHA-256 (`hashKeySync`) and looked up against Upstash Redis / Convex entitlement tables.

---

## 5. Authorization Architecture

- **Tiered Entitlements (`server/_shared/entitlement-check.ts`)**:
  - Distinguishes `free` and `pro` tiers based on user session claims or validated API key capabilities.
  - Pro-only endpoints (e.g. advanced AI scenario runs or detailed MCP tools) call `checkProMcpAccess()` or `getRequiredTier()`, returning HTTP 403 / `X-Billing-Verification` denial headers when entitlements are missing.
- **Convex Data Operations (`convex/`)**:
  - Every Convex query and mutation inspects `ctx.auth.getUserIdentity()` to verify caller identity before modifying user preferences (`userPreferences.ts`), followed countries (`followedCountries.ts`), or alert rules (`alertRules.ts`).

---

## 6. Input / Data Flow & Handling

- **Schema Validation**:
  - Request payloads are validated using Zod (`zod`), Ajv (`ajv`), and Convex field validators (`v.object()`, `v.string()`).
- **DOM / Markup Sanitization**:
  - User-generated or feed-provided HTML/Markdown is sanitized with DOMPurify (`dompurify`) before client rendering.
- **Response Projection & Privacy (`server/_shared/response-projection.ts`)**:
  - Response projection limits enforce payload size constraints and strip sensitive internal fields before returning JSON responses.

---

## 7. Security Configuration

### CORS Configuration (`server/cors.ts` & `api/_cors.js`)
- Enforces an explicit regex origin allowlist (`ALLOWED_ORIGIN_PATTERNS`):
  - Production: `^https:\/\/(.*\.)?worldmonitor\.app$`, scoped Vercel preview domains (`^https:\/\/worldmonitor-[a-z0-9-]+-eliewm\.vercel\.app$`), and Tauri desktop origins (`tauri://localhost`).
  - Development: `localhost` / `127.0.0.1` are appended only when `process.env.NODE_ENV !== 'production'`.
- Dynamic Origin Echo: Validated origins are echoed back in `Access-Control-Allow-Origin` with `Access-Control-Allow-Credentials: true`.
- Public Asset CORS: `getPublicCorsHeaders()` emits `Access-Control-Allow-Origin: *` **without** credentials for static cacheable data.

### HTTP Security Headers (`vercel.json`)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN` / `DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Content-Security-Policy` directives configured.

### Error Handling & Sanitization (`server/error-mapper.ts`)
- Errors of status >= 500 return generic `{"message": "Internal server error"}` to HTTP callers. Stack traces (`err.stack`) and internal context are logged to server-side stderr only.

---

## 8. Dependency Inventory

Inspection of `package.json` confirms modern, actively maintained dependencies with explicit security overrides:

### Security Overrides in `package.json`
`package.json` declares strict dependency overrides to patch upstream vulnerabilities:
- `fast-xml-parser`: `^5.8.0`
- `serialize-javascript`: `^7.0.4`
- `node-forge`: `^1.4.0`
- `protobufjs`: `^7.6.2`
- `shell-quote`: `^1.8.4`
- `ip-address`: `^10.3.1`
- `postcss`: `8.5.23`

---

## 9. Storage & Data Handling

- **Persistent Database**: Convex real-time database engine (`convex/schema.ts` defining tables: `users`, `apiKeys`, `entitlements`, `followedCountries`, `intelHistory`, `alertRules`, `companyMonitoring`).
- **Key-Value Cache & Limiting**: Upstash Redis (`server/_shared/redis.ts`).
- **Object / Blob Storage**: Cloudflare R2 / AWS S3 (`@aws-sdk/client-s3`).

---

## 10. Client-Side Security

- **Frontend Sanitization**: HTML content rendered in news feeds and research reports is filtered through `DOMPurify.sanitize()`.
- **Desktop Tauri IPC Boundary**: Sidecar server in `src-tauri/sidecar/` restricts local RPC execution to authenticated desktop session tokens and local localhost bindings.

---

## 11. Potential Security Review Targets

Below is a list of candidate areas identified during reconnaissance for future controlled security review:

### TARGET-001: External Feed & RSS Fetching (`api/rss-proxy.ts`)
- **Classification**: `POTENTIAL RISK` / `REQUIRES VALIDATION`
- **File**: `api/rss-proxy.ts`
- **Evidence**: Route proxies external RSS feeds requested by clients.
- **Security Control**: URL parsing and protocol checks are implemented.
- **Recommended Validation**: Verify that SSRF protection prevents fetching private IP ranges (`127.0.0.1`, `169.254.169.254`, internal RFC1918 subnets).

### TARGET-002: Webhook Signature Verification (`api/v2/shipping/webhooks/`, `convex/resendWebhookHandler.ts`)
- **Classification**: `OBSERVATION` / `REQUIRES VALIDATION`
- **File**: `convex/resendWebhookHandler.ts`, `api/v2/shipping/webhooks/[subscriberId].ts`
- **Evidence**: Endpoint processes external webhook callbacks.
- **Security Control**: Uses HMAC signature header checking.
- **Recommended Validation**: Verify timing-safe comparison (`timingSafeEqualSecret`) is used on all webhook signature verification branches.

### TARGET-003: Internal MCP HMAC Replay Cache (`server/_shared/mcp-internal-hmac.ts`)
- **Classification**: `OBSERVATION` / `REQUIRES VALIDATION`
- **File**: `server/_shared/mcp-internal-hmac.ts`
- **Evidence**: `verifyInternalMcpRequest()` validates nonces with a 300s Redis TTL cache.
- **Security Control**: `getInternalMcpVerifiedNonce()` checks duplicate nonces in Redis.
- **Recommended Validation**: Verify fallback behavior when Redis is temporarily unreachable.

### TARGET-004: Tauri Desktop Local Sidecar Binding (`src-tauri/sidecar/local-api-server.ts`)
- **Classification**: `OBSERVATION` / `REQUIRES VALIDATION`
- **File**: `src-tauri/sidecar/local-api-server.ts`
- **Evidence**: Binds a local HTTP API server for desktop application IPC.
- **Security Control**: Requires desktop session authorization token.
- **Recommended Validation**: Confirm that non-browser processes or unauthorized local users cannot interact with the sidecar API.

---

## Target Integrity Verification

- **Target Repository**: `..\SIH 26163\worldmonitor\worldmonitor-main`
- **Modification Audit**: `0` target files modified.
- **Status**: The target repository remains 100% untouched.
