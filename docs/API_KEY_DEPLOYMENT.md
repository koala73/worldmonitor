# API Key Gating & Registration — Deployment Guide

## Overview

Desktop cloud fallback is gated on a `WORLDMONITOR_API_KEY`. Without a valid key, the desktop app operates local-only (sidecar). A registration form collects emails via Convex DB for future key distribution.

## Architecture

```
Desktop App                          Cloud (Vercel)
┌──────────────────┐                ┌──────────────────────┐
│ fetch('/api/...')│                │ api/[domain]/v1/[rpc]│
│        │         │                │        │              │
│ ┌──────▼───────┐ │                │ ┌──────▼───────┐      │
│ │ sidecar try  │ │                │ │ validateApiKey│      │
│ │ (local-first)│ │                │ │ (origin-aware)│      │
│ └──────┬───────┘ │                │ └──────┬───────┘      │
│   fail │         │                │   401 if invalid      │
│ ┌──────▼───────┐ │   fallback    │                       │
│ │ WM key check │─┼──────────────►│ ┌──────────────┐      │
│ │ (gate)       │ │  +header      │ │ route handler │      │
│ └──────────────┘ │               │ └──────────────┘      │
└──────────────────┘               └──────────────────────┘
```

## Required Environment Variables

### Vercel

| Variable | Description | Example |
|----------|-------------|---------|
| `WORLDMONITOR_VALID_KEYS` | Comma-separated list of valid API keys | `wm_abc123def456,wm_xyz789` |
| `CONVEX_URL` | Convex deployment URL (from `npx convex deploy`) | `https://xyz-123.convex.cloud` |

### Generating API keys

Keys must be at least 16 characters (validated client-side). Recommended format:

```bash
# Generate a key
openssl rand -hex 24 | sed 's/^/wm_/'
# Example output: wm_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6
```

Add to `WORLDMONITOR_VALID_KEYS` in Vercel dashboard (comma-separated, no spaces).

## Convex Setup

### First-time deployment

```bash
# 1. Install (already in package.json)
npm install

# 2. Login to Convex
npx convex login

# 3. Initialize project (creates .env.local with CONVEX_URL)
npx convex init

# 4. Deploy schema and functions
npx convex deploy

# 5. Copy the deployment URL to Vercel env vars
# The URL is printed by `npx convex deploy` and saved in .env.local
```

### Verify Convex deployment

```bash
# Typecheck Convex functions
npx convex dev --typecheck

# Open Convex dashboard to see registrations
npx convex dashboard
```

### Schema

The `registrations` table stores:

| Field | Type | Description |
|-------|------|-------------|
| `email` | string | Original email (for display) |
| `normalizedEmail` | string | Lowercased email (for dedup) |
| `registeredAt` | number | Unix timestamp |
| `source` | string? | Where the registration came from |
| `appVersion` | string? | Desktop app version |

Indexed by `normalizedEmail` for duplicate detection.

## Security Model

### Client-side (desktop app)

- `installRuntimeFetchPatch()` checks `WORLDMONITOR_API_KEY` before allowing cloud fallback
- Key must be present AND valid (min 16 chars)
- `secretsReady` promise ensures secrets are loaded before first fetch (2s timeout)
- Fail-closed: any error in key check blocks cloud fallback

### Server-side (Vercel edge)

- `api/_api-key.js` validates `X-WorldMonitor-Key` header on sebuf routes
- **Origin-aware**: desktop origins (`tauri.localhost`, `tauri://`, `asset://`) require a key
- Web origins (`worldmonitor.app`) pass through without a key
- Non-desktop origin with key header: key is still validated
- Invalid key returns `401 { error: "Invalid API key" }`

### CORS

`X-WorldMonitor-Key` is allowed in both `server/cors.ts` and `api/_cors.js`.

## Verification Checklist

After deployment:

- [ ] Set `WORLDMONITOR_VALID_KEYS` in Vercel
- [ ] Set `CONVEX_URL` in Vercel
- [ ] Run `npx convex deploy` to push schema
- [ ] Desktop without key: cloud fallback blocked (console shows `cloud fallback blocked`)
- [ ] Desktop with invalid key: sebuf requests get `401`
- [ ] Desktop with valid key: cloud fallback works as before
- [ ] Web access: no key required, works normally
- [ ] Registration form: submit email, check Convex dashboard
- [ ] Duplicate email: shows "already registered"
- [ ] Existing settings tabs (LLMs, API Keys, Debug) unchanged

## Files Reference

| File | Role |
|------|------|
| `src/services/runtime.ts` | Client-side key gate + header attachment |
| `src/services/runtime-config.ts` | `WORLDMONITOR_API_KEY` type, validation, `secretsReady` |
| `api/_api-key.js` | Server-side key validation (origin-aware) |
| `api/[domain]/v1/[rpc].ts` | Sebuf gateway — calls `validateApiKey` |
| `api/register-interest.js` | Registration endpoint → Convex |
| `server/cors.ts` / `api/_cors.js` | CORS headers with `X-WorldMonitor-Key` |
| `src/components/WorldMonitorTab.ts` | Settings UI for key + registration |
| `convex/schema.ts` | Convex DB schema |
| `convex/registerInterest.ts` | Convex mutation |
