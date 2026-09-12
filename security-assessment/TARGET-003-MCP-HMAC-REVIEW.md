# TARGET-003 — MCP Internal HMAC Security Review

## Scope

Audited the internal Model Context Protocol (MCP) HMAC service authentication and replay defense implementation in:

- `server/_shared/mcp-internal-hmac.ts`
- `server/gateway.ts` (`claimInternalMcpReplayNonce` and `verifyInternalMcpRequest` verification path)

---

## Authentication Flow

```
Inbound MCP Request -> Gateway (`server/gateway.ts`)
   │
   ├── 1. Extract Headers (`X-WM-MCP-Internal`, `X-WM-MCP-User-Id`, `X-WM-MCP-Nonce`)
   ├── 2. Header & Format Parsing (`parseSignatureHeader`: `<ts>.<sigB64u>`)
   ├── 3. Symmetric Timestamp Window Check (`Math.abs(now - ts) <= 30`)
   ├── 4. Re-canonicalize Request Shape:
   │      ├── Query canonicalization (`canonicalQueryString`) -> `queryHash` (SHA-256)
   │      └── Body bytes hash (`sha256Hex(body)`) -> `bodyHash` (SHA-256)
   ├── 5. Re-compute HMAC Payload: `${ts}:${method}:${pathname}:${queryHash}:${bodyHash}:${userId}:${nonce}`
   ├── 6. HMAC-SHA256 Sign (`crypto.subtle.sign`) -> `expectedSig`
   ├── 7. Constant-Time Signature Compare (`timingSafeStringEqual(expectedSig, sigB64u)`)
   │      └── If false -> Return HTTP 401 `invalid_internal_mcp_signature` (Fail-Closed)
   ├── 8. Atomic Replay Cache Claim (`claimInternalMcpReplayNonce` via Redis `SET key 1 EX 65 NX`)
   │      ├── If Redis Error/Unavailable -> Return HTTP 503 `internal_mcp_replay_cache_unavailable` (Fail-Closed)
   │      └── If Already Set ('replay') -> Return HTTP 401 `invalid_internal_mcp_signature` (Fail-Closed)
   └── 9. Re-build Trusted Request Headers (`x-wm-mcp-internal-verified: <random_process_nonce>`, `x-user-id`)
```

---

## HMAC Verification

- **Algorithm**: Web Crypto API (`crypto.subtle`) `HMAC-SHA256` with base64url signature encoding.
- **Canonical Payload Structure**:
  `${ts}:${method}:${pathname}:${queryHash}:${bodyHash}:${userId}:${nonce}`
  - `queryHash`: SHA-256 hex digest of lexicographically sorted, URL-encoded query parameters.
  - `bodyHash`: SHA-256 hex digest of raw request body bytes.
- **Secret Management**: Loaded via `process.env.MCP_INTERNAL_HMAC_SECRET`. If `secret` is missing or empty, `verifyInternalMcpRequest()` immediately returns `null` (`HTTP 401`).
- **Signature Comparison**: Uses `timingSafeStringEqual()`, which hashes both input strings to fixed 256-bit SHA-256 digests via WebCrypto before executing bitwise XOR comparison (`diff |= aHash[i] ^ bHash[i]`) across all 32 bytes. This eliminates timing leaks from early-exit character matches or string length differences.

---

## Timestamp Validation

- **Format**: Unix timestamp in seconds.
- **Window**: Enforces strict symmetric 30-second window (`INTERNAL_MCP_TIMESTAMP_WINDOW_SECONDS = 30`).
- **Skew Defense**: Rejects timestamps where `Math.abs(nowSec - ts) > 30`. Stale timestamps and future timestamps beyond 30 seconds are rejected with `HTTP 401`.

---

## Replay Protection & Redis Dependency

- **Nonce Structure**: One-shot UUID/random string bound into the signed HMAC payload (`X-WM-MCP-Nonce`).
- **Replay TTL**: `INTERNAL_MCP_REPLAY_CACHE_TTL_SECONDS = 65` (2 * 30s timestamp window + 5s buffer) to cover the full window across potential clock-skew bounds.
- **Atomic Claim Mechanism**:
  ```typescript
  const result = await runRedisPipeline([
    ['SET', key, '1', 'EX', INTERNAL_MCP_REPLAY_CACHE_TTL_SECONDS, 'NX'],
  ]);
  ```
  Uses Redis single-command `SET key 1 EX 65 NX` to check and record the nonce atomically in one network operation.

---

## Redis Failure / Fallback Behavior

- **Investigation Result**: The system **FAILS CLOSED**.
- **Evidence (`server/gateway.ts` lines 157-168 and 1256-1265)**:
  ```typescript
  if (result.length === 0) return 'unavailable';
  if (claim?.error) return 'unavailable';
  ...
  if (replayClaim === 'unavailable') {
    emitRequest(503, 'replay_cache_unavailable', null);
    return new Response(
      JSON.stringify({ error: 'internal_mcp_replay_cache_unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }
  ```
  If Redis is down, timing out, or returns a pipeline error, `claimInternalMcpReplayNonce()` explicitly returns `'unavailable'`. The gateway handles `'unavailable'` by returning **`HTTP 503 internal_mcp_replay_cache_unavailable`**. It does **NOT** fall back to bypassing replay checks or allowing unverified executions.

---

## Race Condition Analysis

- **Atomic Operation**: The `SET key 1 EX 65 NX` command relies on Redis's single-threaded command execution guarantee. Concurrent requests presenting the identical nonce will compete at the Redis engine level: exactly one request will receive `OK` (fresh), while all concurrent racing requests will receive `null` (replay) and be rejected with `HTTP 401`.
- **Race Condition Vulnerability**: None. The single `SET NX` pipeline call eliminates GET-then-SET time-of-check to time-of-use (TOCTOU) races.

---

## Security Controls Summary

1. **HMAC Request Binding**: Binds method, pathname, query parameters, body hash, user ID, timestamp, and nonce into an un-forgeable HMAC-SHA256 signature.
2. **Timing-Safe Digest Comparison**: Eliminates timing side-channels via fixed-length SHA-256 hash comparison.
3. **Atomic Replay Claim**: Uses `SET NX` with 65s TTL to prevent signature reuse.
4. **Strict Fail-Closed Redis Policy**: Serves HTTP 503 if Redis is unreachable; never downgrades authentication.
5. **Header Stripping & Internal Nonce Isolation**: Strips inbound signature headers before attaching a process-random `x-wm-mcp-internal-verified` nonce to prevent header-spoofing attacks.

---

## Potential Weaknesses

No security weaknesses or bypass conditions were identified.

---

## Classification

**SOURCE-PROTECTED**

---

## Runtime Validation

Runtime validation is **not necessary**. Code analysis of `server/_shared/mcp-internal-hmac.ts` and `server/gateway.ts` establishes that verification and Redis failure handling are completely fail-closed and cryptographically sound.

---

## Conclusion

**No vulnerability established.**

The internal MCP HMAC service authentication enforces strict request-shape binding, constant-time signature comparison, atomic Redis `SET NX` replay claims, and absolute fail-closed error handling (HTTP 503 on Redis failure).
