# TARGET-004 — Tauri Local Sidecar Security Review

## Scope
Audited the desktop sidecar local API server implementation in:
- `src-tauri/sidecar/local-api-server.mjs`
- `src-tauri/src/main.rs`
- `src-tauri/tauri.conf.json`

---

## Sidecar Architecture

```
Tauri Desktop App (`src-tauri/src/main.rs`)
   │  (Launches sidecar process & passes transport secret env)
   ▼
Local API Server (`src-tauri/sidecar/local-api-server.mjs`)
   │
   ├── 1. Network Listener: Bound strictly to `127.0.0.1` (IPv4 loopback)
   ├── 2. Transport Auth Check (`x-worldmonitor-local-token` / `Authorization: Bearer <token>`)
   ├── 3. Origin / CORS Validation (`SIDECAR_ALLOWED_ORIGINS` regex check)
   ├── 4. Egress URL Safety Check (`assertSafeSidecarFetchUrl` -> IPv4-pinned SSRF guard)
   └── 5. Dispatch to Endpoint Handlers (`/api/*`)
```

---

## Network Binding

- **Interface**: Strictly bound to IPv4 loopback (`127.0.0.1`).
- **Source Evidence** ([src-tauri/sidecar/local-api-server.mjs](file:///c:/Users/varun/OneDrive/Documents/personals/SIH%2026163/worldmonitor/worldmonitor-main/src-tauri/sidecar/local-api-server.mjs#L1978)):
  ```js
  server.listen(port, '127.0.0.1');
  ```
- **External Exposure**: The server does **NOT** bind to `0.0.0.0` or public network interfaces. External LAN or WAN hosts cannot connect to the local sidecar port.

---

## API Endpoints

- Handled via `dispatch()` mapping `/api/*` requests to local handler modules.
- Meta / Status Endpoints: `/api/local-status`, `/api/local-traffic-log`, `/api/local-debug-toggle`, `/api/local-env-update`.
- Data Proxies: `/api/opensky`, `/api/llm-health`.

---

## Authentication & Authorization

- **Transport Credential Requirement**: Inbound HTTP requests must present a secret transport token via header `x-worldmonitor-local-token` or `Authorization: Bearer <expectedToken>`.
- **Credential Stripping**: Transport tokens are consumed and stripped at the sidecar boundary before forwarding requests to internal route handlers.
- **Product Key Injection**: Sensitive service credentials (such as `WORLDMONITOR_API_KEY` for OpenSky) are injected internally by the sidecar process, keeping them isolated from the webview renderer process.

---

## Browser-Origin Security

- **Strict CORS Allowlist**: Origin headers are checked against `SIDECAR_ALLOWED_ORIGINS`:
  - `^tauri://localhost$`
  - `^https?://localhost(:\d+)?$`
  - `^https?://127\.0\.0\.1(:\d+)?$`
  - `^https?://tauri\.localhost(:\d+)?$`
  - `^https:\/\/([a-z0-9-]+\.)?worldmonitor\.app$`
- **Refusal Fallback**: Disallowed origins receive `Access-Control-Allow-Origin: tauri://localhost` fallback, preventing arbitrary web origins (e.g. `evil.com`) from reading local API responses.

---

## Port Security

- **Ephemeral Port Allocation**: If the default port is occupied (`EADDRINUSE`), the sidecar falls back to OS-assigned dynamic port binding (`tryListen(0)`).
- **Port File Handshake**: Port file output (`LOCAL_API_PORT_FILE`) communicates the dynamic port to the parent Tauri process via local file IPC.
- **Token Protection**: Unauthenticated local processes scanning ports cannot execute requests without the transport token.

---

## Process Isolation

- Sidecar runs as a child Node.js process managed by the main Tauri Rust application.
- Global fetch within the sidecar (`ipv4Fetch`) applies an internal SSRF guard (`assertSafeSidecarFetchUrl`) and pins DNS lookups to IPv4 addresses to prevent TOCTOU rebinding attacks during upstream telemetry queries.

---

## Tauri Permissions & Capabilities

- Desktop permissions defined in `src-tauri/tauri.conf.json` restrict webview window capabilities, scope filesystem access, and enforce CSP policy on desktop window loads.

---

## Security Controls Summary

1. **IPv4 Loopback Binding**: Binds strictly to `127.0.0.1`.
2. **Mandatory Transport Token**: Unauthenticated local processes are rejected with `HTTP 401`.
3. **Restricted CORS Allowlist**: Prevents cross-origin browser access from non-whitelisted domains.
4. **Sidecar Egress SSRF & DNS Pinning**: Pinned IPv4 DNS lookups protect upstream fetching within sidecar handlers.

---

## Potential Weaknesses

No design weaknesses or process isolation bypasses were found.

---

## Safe Runtime Validation

Static code analysis confirms `127.0.0.1` binding, transport token requirements, and strict CORS validation. Local runtime attack testing is **unnecessary**.

---

## Classification

**SOURCE-PROTECTED**

---

## Conclusion

**No vulnerability established.**

The World Monitor Tauri desktop sidecar binds strictly to `127.0.0.1`, enforces transport token authentication, restricts CORS origins, and isolates process credentials.
