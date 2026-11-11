---
module: runtime packaging
component: Railway workers and desktop sidecar
problem_type: security_issue
tags: [nodejs, railway, railpack, desktop, docker, security-release]
---

# Node.js November 2026 runtime update

The [November 11 Node.js advisory](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases)
provides fixes in Node 22.23.5, 24.22.3, and 26.13.1. This review inspected
WorldMonitor main commit `f3cebf9fa3949daa51e431bb4767199e9692a7f8`.

## Confirmed packaging gap

| Surface | Before this change | Repair or remaining action |
| --- | --- | --- |
| Railway builds that use `scripts/railpack.json` | Exact pin 24.22.1 | Select 24.22.3. Retain an exact version because Railpack previously resolved ranges below their floor. |
| Desktop release downloader | Default 22.23.4 | Select 22.23.5. Retain the pinned keyring, signature, and archive checksum checks. |
| Node 24 Alpine Docker stages | Digest `8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85` contains 24.22.2 | Await a verified patched official image, then update the digests in all Node Docker stages. |
| Umami Node 22 Alpine stages and consumer-prices Node 24 slim stages | Fixed image digests from before this release | Await verified patched official images, then update their digests. |
| Development and CI | `.nvmrc` and main workflows select major 24 | Fresh resolution can select the patched release. Existing installations and caches still require an update and version check. |

The official Docker registry returned 404 for `24.22.3-alpine`,
`22.23.5-alpine`, and `24.22.3-slim` on November 11, 2026. The mutable
`24-alpine` and `24-slim` tags still contained 24.22.2; `22-alpine` still
contained 22.23.4. Changing to those tags would not install the security fixes.
This change therefore does not claim to remediate the Docker images.

## Reachability limits

The relay (`scripts/ais-relay.cjs`) and desktop sidecar
(`src-tauri/sidecar/local-api-server.mjs`) create plain HTTP servers and use
outbound HTTPS clients. The inspected application code did not establish a
reachable HTTP/2-server, TLS-server, per-host mTLS, or permission-model exploit
path. The advisory explicitly excludes plain HTTP from CVE-2026-123864.

Outbound HTTPS use alone does not prove CVE-2026-123877: that defect requires
reuse of an HTTPS agent across different CA policies. No such request sequence
was demonstrated. Updating the runtime removes affected core code and bundled
dependencies; it is not evidence of a successful exploit against WorldMonitor.

Vercel, Convex, and active Railway runtime versions were not inspected. Updating
this repository does not update a provider-managed runtime, an existing desktop
installation, or an already deployed container.

## Verification and follow-up

The pin regression rejects 24.22.1. The desktop fixture now exercises the
default version rather than overriding it, and rejects the old default. The
focused tests retain rejection of missing signatures, substituted keyrings,
unknown signing keys, modified signed checksums, and corrupt archives.

After patched official Docker images are published, inspect their manifest and
image configuration, confirm `NODE_VERSION`, and update every affected digest.
Build and test the resulting images before any separately authorized rollout.
Railway deployment, desktop publication, installed-version checks, and production
acceptance remain separate steps.
