# Tauri Validation Report

## Scope

Validated desktop build readiness for the World Monitor Tauri app by checking frontend compilation, TypeScript integrity, and Tauri/Rust build execution.

## Preflight checks before desktop validation

Run these checks first so failures are classified quickly:

1. npm registry reachability
   - `npm ping`
2. crates.io sparse index reachability
   - `curl -I https://index.crates.io/`
3. proxy configuration present when required by your network
   - `env | grep -E '^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY)='`

If any of these checks fail, treat downstream desktop build failures as environment-level until the network path is fixed.

## Commands run

1. `npm ci` — failed because the environment blocks downloading the pinned `@tauri-apps/cli` package from npm (`403 Forbidden`).
2. `npm run typecheck` — succeeded.
3. `npm run build:full` — succeeded (warnings only).
4. `npm run desktop:build:full` — not runnable in this environment because `npm ci` failed, so the local `tauri` binary was unavailable (desktop scripts now fail fast with a clear `npm ci` remediation message when this occurs).
5. `cargo check` (from `src-tauri/`) — failed because the environment blocks downloading crates from `https://index.crates.io` (`403 CONNECT tunnel failed`).

## Assessment

- The web app portion compiles successfully.
- Full Tauri desktop validation in this run is blocked by an **external environment outage/restriction** (registry access denied with HTTP 403).
- No code/runtime defects were observed in project sources during this validation pass.

## Failure classification for future QA

Use these labels in future reports so outcomes are actionable:

1. **External environment outage**
   - Symptoms: npm/crates registry requests fail with transport/auth/network errors (403/5xx/timeout/DNS/proxy), independent of repository state.
   - Action: retry in a healthy network or fix credentials/proxy/mirror availability.

2. **Expected failure: offline mode not provisioned**
   - Symptoms: build is intentionally run without internet, but required offline inputs are missing (for Rust: no `vendor/` artifact, no internal mirror mapping, or offline override not enabled; for JS: no prepared package cache).
   - Action: provision offline artifacts/mirror config first, enable offline override (`config.local.toml` or CLI `--config`), then rerun.

## Next action to validate desktop end-to-end

Choose one supported path:

- Online path:
  - `npm ci`
  - `npm run desktop:build:full`

- Restricted-network path:
  - Restore prebuilt offline artifacts (including `src-tauri/vendor/` or internal mirror mapping).
  - Run Cargo with `source.crates-io.replace-with` mapped to vendored/internal source and `--offline` where applicable.

After `npm ci`, desktop build uses the local `tauri` binary and does not rely on runtime `npx` package retrieval.

## Remediation options for restricted environments

If preflight fails, use one of these approved remediations:

- Configure an internal npm mirror/proxy for Node packages.
- Configure an internal Cargo registry/sparse index mirror for Rust crates.
- Pre-vendor Rust crates (`src-tauri/vendor/`) and run Cargo in offline mode.
- Use CI runners that restore package/cache artifacts from a trusted internal store before builds.

For release packaging details, see `docs/RELEASE_PACKAGING.md` (section: **Network preflight and remediation**).
