# Final Security Evidence Audit

## Executive Summary

A comprehensive, read-only source evidence audit was performed for all five finding entries recorded in `security-assessment/data/findings.json` against the official target codebase `worldmonitor-main/` located at `..\SIH 26163\worldmonitor\worldmonitor-main`.

The audit evaluated whether the referenced files, functions, code structures, and technical claims in `findings.json` are supported by actual source code evidence in `worldmonitor-main/`.

### Summary of Audit Classifications

- **SOURCE-SUPPORTED**: 0
- **PARTIALLY-SUPPORTED**: 0
- **NOT-SUPPORTED**: 5
- **REQUIRES-RUNTIME-VALIDATION**: 0

### Audit Findings Key Takeaway

All 5 findings recorded in `security-assessment/data/findings.json` cite nonexistent files, functions, routes, middleware, and database frameworks relative to `worldmonitor-main/`. They appear to be synthetic demonstration templates or mock test data generated for assessment scoring platform validation, rather than actual findings derived from auditing the target `worldmonitor-main/` codebase.

---

## SEC-001: Hardcoded Default Secret Key Fallback in JWT Verification

### Referenced Details (from `findings.json`)

- **File**: `server/auth/jwt.js`
- **Function**: `verifyToken`
- **Claim**: The JWT verification module falls back to a hardcoded secret if the environment variable (`JWT_SECRET`) is missing.
- **Claimed Evidence**: `const SECRET = process.env.JWT_SECRET || 'DEFAULT_WORLDMONITOR_SECRET_KEY_2026';`

### Source Audit Verification

1. **File Existence**: `server/auth/jwt.js` does NOT exist in `worldmonitor-main/`.
2. **Function Existence**: `verifyToken` does NOT exist in `worldmonitor-main/` server auth modules. `worldmonitor-main` uses `server/auth-session.ts` and `server/gateway.ts` for authentication handling.
3. **Code Pattern Match**: The exact string `DEFAULT_WORLDMONITOR_SECRET_KEY_2026` does NOT exist anywhere in `worldmonitor-main/`.
4. **Security Controls Found**: `worldmonitor-main` uses Vercel edge functions and Sebuf TypeScript RPC gateway handlers with session token verification (`wms_` session keys, HMAC validation in `mcp-internal-hmac.ts`) rather than standard Express `jsonwebtoken` middleware in a `jwt.js` file.

### Findings Assessment

- **Status**: `NOT-SUPPORTED`
- **Confidence Assessment**: The 95% confidence score recorded in `findings.json` is **indefensible** based on source code evidence, as the file and function do not exist in the target repository.
- **Limitations**: None. The referenced file and function are completely absent.

---

## SEC-002: Missing Role-Based Access Control (RBAC) on Telemetry Export API

### Referenced Details (from `findings.json`)

- **File**: `server/routes/telemetry.js`
- **Function**: `exportAllTelemetryData` (and `exportAllTelemetry` in query spec)
- **Route**: `GET /api/v1/telemetry/export`
- **Claim**: The endpoint checks for authentication but does not enforce RBAC/authorization privileges, allowing standard users to dump system telemetry.
- **Claimed Evidence**: `router.get('/api/v1/telemetry/export', authenticateToken, (req, res) => { /* exports full DB dump */ });`

### Source Audit Verification

1. **File Existence**: `server/routes/telemetry.js` does NOT exist in `worldmonitor-main/`.
2. **Route/Function Existence**: Route `GET /api/v1/telemetry/export` and function `exportAllTelemetryData` do NOT exist in `worldmonitor-main/`.
3. **Architecture Match**: `worldmonitor-main/server` is organized into TypeScript modules (`gateway.ts`, `router.ts`, `cors.ts`) and `api/` Vercel endpoints, not Express `server/routes/*.js` files.
4. **Security Controls Found**: Telemetry/analytics in `worldmonitor-main` are handled via client-side Umami integration (`Dockerfile.umami`) and explicit Vercel serverless API handlers with strict origin allowlists (`api/_cors.js`) and API key entitlement checks (`server/_shared/entitlement-check.ts`).

### Findings Assessment

- **Status**: `NOT-SUPPORTED`
- **Confidence Assessment**: The 90% confidence score recorded in `findings.json` is **indefensible** based on source code evidence.
- **Limitations**: None. The endpoint and file do not exist in `worldmonitor-main/`.

---

## SEC-003: Permissive Cross-Origin Resource Sharing (CORS) Wildcard Header

### Referenced Details (from `findings.json`)

- **File**: `server/middleware/cors.js`
- **Function**: `configureCors`
- **Claim**: Wildcard CORS origin combined with credentials allows third-party websites to initiate authenticated cross-origin requests.
- **Claimed Evidence**: `res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Credentials', 'true');`

### Source Audit Verification

1. **File Existence**: `server/middleware/cors.js` does NOT exist. (The actual CORS configuration in `worldmonitor-main` is in `server/cors.ts` and `api/_cors.js`).
2. **Function Existence**: `configureCors` does NOT exist. Actual functions in `worldmonitor-main` are `getCorsHeaders(req)` and `isAllowedOrigin(origin)`.
3. **CORS Control Audit in `worldmonitor-main/server/cors.ts` & `api/_cors.js`**:
   - `worldmonitor-main` enforces a strict regex origin allowlist (`ALLOWED_ORIGIN_PATTERNS`):
     - Production: `^https:\/\/(.*\.)?worldmonitor\.app$`, specific Vercel preview domains (`^https:\/\/worldmonitor-[a-z0-9-]+-eliewm\.vercel\.app$`), and desktop Tauri protocols (`tauri://localhost`).
     - Dev: `localhost` / `127.0.0.1` are appended ONLY when `process.env.NODE_ENV !== 'production'`.
   - `getCorsHeaders(req)` dynamically sets `Access-Control-Allow-Origin` to the validated request origin if matched, or falls back to `https://worldmonitor.app`.
   - **Wildcard + Credentials Check**: The codebase never emits `Access-Control-Allow-Origin: *` together with `Access-Control-Allow-Credentials: true`. The only occurrence of `*` is in `getPublicCorsHeaders()`, which explicitly omits credentials (`Access-Control-Allow-Credentials`) for public static data caching.

### Findings Assessment

- **Status**: `NOT-SUPPORTED`
- **Confidence Assessment**: The 100% confidence score in `findings.json` is **indefensible**. The finding misidentifies the file/function name and falsely claims `Access-Control-Allow-Origin: *` is combined with `Access-Control-Allow-Credentials: true`.
- **Limitations**: None. Source code proves a strict regex-based origin allowlist is active.

---

## SEC-004: Verbose Debug Error Messages Leaking Stack Traces to Client

### Referenced Details (from `findings.json`)

- **File**: `server/middleware/errorHandler.js`
- **Function**: `globalErrorHandler`
- **Claim**: Unhandled server errors leak internal stack traces (`err.stack`), system paths, and database query details to HTTP response bodies in production.
- **Claimed Evidence**: `res.status(500).json({ error: err.message, stack: err.stack, internalContext: err.config });`

### Source Audit Verification

1. **File Existence**: `server/middleware/errorHandler.js` does NOT exist in `worldmonitor-main/`.
2. **Function Existence**: `globalErrorHandler` does NOT exist in `worldmonitor-main/`. Error mapping is implemented in `server/error-mapper.ts` via `mapErrorToResponse()`.
3. **Error Mapper Code Audit (`server/error-mapper.ts`)**:
   - For status 500 / unhandled errors, `mapErrorToResponse()` returns:
     `jsonMessageResponse('Internal server error', 500)`
   - Full error details are logged server-side via `console.error('[error-mapper] Unhandled error:', ...)` and are **never** returned to the HTTP client body.
   - Stack traces (`err.stack`) are not serialized or attached to client HTTP responses in `server/error-mapper.ts`.

### Findings Assessment

- **Status**: `NOT-SUPPORTED`
- **Confidence Assessment**: The 85% confidence score in `findings.json` is **indefensible**.
- **Limitations**: None. Source code verification confirms stack traces are omitted from client responses.

---

## SEC-005: Unbound Dynamic Database Query Parameter in Log Search API

### Referenced Details (from `findings.json`)

- **File**: `server/controllers/logController.js`
- **Function**: `searchLogs`
- **Claim**: Constructing dynamic MongoDB query code directly from user input using `$where` allows arbitrary JavaScript execution in the database engine context.
- **Claimed Evidence**: `const query = { $where: `this.message.includes('${req.query.search}')` };`

### Source Audit Verification

1. **File Existence**: `server/controllers/logController.js` does NOT exist in `worldmonitor-main/`.
2. **Function Existence**: `searchLogs` does NOT exist in `worldmonitor-main/`.
3. **Database Framework & Query Audit**:
   - `worldmonitor-main` does NOT use MongoDB or Mongoose `$where` operators.
   - Key storage layers in `worldmonitor-main` rely on Redis (`server/redis.ts`), Cloudflare R2 / S3 storage, or DuckDB / In-Memory query engines.
   - Searching the entire `worldmonitor-main` repository yields zero MongoDB `$where` query construction in server controllers.

### Findings Assessment

- **Status**: `NOT-SUPPORTED`
- **Confidence Assessment**: The 88% confidence score in `findings.json` is **indefensible**.
- **Limitations**: None. File, function, and MongoDB database query pattern are completely non-existent in the target codebase.

---

## Assessment Data Integrity Audit: `findings.json`

| Finding ID | Referenced File in `findings.json` | Actual File in `worldmonitor-main/` | Referenced Function | Status | Recorded Confidence | Justified Confidence |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: |
| **SEC-001** | `server/auth/jwt.js` | None (Does not exist) | `verifyToken` | `NOT-SUPPORTED` | 95% | 0% |
| **SEC-002** | `server/routes/telemetry.js` | None (Does not exist) | `exportAllTelemetryData` | `NOT-SUPPORTED` | 90% | 0% |
| **SEC-003** | `server/middleware/cors.js` | `server/cors.ts` / `api/_cors.js` | `configureCors` | `NOT-SUPPORTED` | 100% | 0% |
| **SEC-004** | `server/middleware/errorHandler.js` | `server/error-mapper.ts` | `globalErrorHandler` | `NOT-SUPPORTED` | 85% | 0% |
| **SEC-005** | `server/controllers/logController.js` | None (Does not exist) | `searchLogs` | `NOT-SUPPORTED` | 88% | 0% |

### Key Observations & Overstated Descriptions

1. **Synthetic / Mock Nature of Findings**:
   Every finding in `findings.json` targets a standard Express.js / Node.js application structure (e.g. `server/routes/`, `server/controllers/`, `server/middleware/`), whereas `worldmonitor-main/` is a modern TypeScript Vercel Edge / Sebuf RPC gateway application.

2. **Indefensible Confidence Scores**:
   The confidence percentages in `findings.json` (85% to 100%) are completely indefensible when audited against the source code of `worldmonitor-main/`.

3. **SIH Dashboard Recommendation**:
   The SIH dashboard should label all 5 entries as `NOT-SUPPORTED` (or `SYNTHETIC MOCK DEMO DATA`) to clearly indicate that they do not correlate to real source code in the target repository.

---

## Target Integrity Verification

A strict read-only audit policy was maintained throughout this assessment.

- **Target Repository**: `..\SIH 26163\worldmonitor\worldmonitor-main`
- **Modifications**: 0 files modified in target.
- **Verification**: `worldmonitor-main` remains 100% untouched and preserved in its original state.

---

## Overall Conclusion

These findings **SHOULD NOT** currently be described as confirmed vulnerabilities.

All five findings (`SEC-001` through `SEC-005`) refer to non-existent files, routes, functions, and query structures when audited against the target `worldmonitor-main` source tree. Furthermore, audit of the actual security controls present in `worldmonitor-main` (such as `server/cors.ts` and `server/error-mapper.ts`) demonstrates that robust origin allowlists and error sanitization patterns are implemented.
