
itle: "feat: Server-Side User Preferences Sync + Notification Delivery Channels"
type: feat
status: active
date: 2026-03-24
---

# feat: Server-Side User Preferences Sync + Notification Delivery Channels

## Overview

Today, WorldMonitor stores all user configuration in localStorage — panel layout, enabled sources, market watchlist, map layers, monitors, and every other personalisation — meaning it is browser-local, lost on a new device, and inaccessible server-side. This makes login feel ornamental: signing in does not recover your setup, and the server cannot notify you of anything.

This plan migrates user preferences to Convex-backed server storage for signed-in users and adds first-class notification delivery via Telegram, Slack, and email. It makes login feel immediately valuable: your settings follow you everywhere, and the world can reach you.

**This is a multi-phase feature.** It cannot start until the Clerk migration (PR #1812 or equivalent rework) is merged and stable in production. The plan is intentionally sequenced so each phase ships value independently.

---

## Problem Statement

- User experience on a new browser/device starts from scratch. Zero personalisation recovery.
- No server knows what a user cares about, so no server-side notifications are possible.
- Users cannot subscribe to events (conflict escalations, market moves, breaking news) and receive push notifications to any external channel.
- Login is a gate for pro features only — not a value delivery mechanism in its own right.

---

## Prerequisite: Clerk Auth (must land before Phase 1)

**PR #1812 (`feat/better-auth`) or its rework must be merged before any work on this plan begins.**

What is needed from the Clerk migration:

- `clerk.ts` and `auth-state.ts` expose `user.id` (Clerk user ID) and a signed JWT (template `convex`) to all frontend code
- `server/auth-session.ts` validates the `convex` JWT at the edge using `jose` + JWKS cache
- `convex/auth.config.ts` has Clerk as the sole JWT provider
- `CLERK_JWT_ISSUER_DOMAIN`, `VITE_CLERK_PUBLISHABLE_KEY` env vars are set in all environments

---

## Proposed Solution

### Architecture

```
Browser (Clerk session)
  │
  ├─ Preference writes ──► Convex userPreferences (via HTTP action, JWT-authenticated)
  │
  ├─ Preference reads  ◄── Convex userPreferences (on sign-in, merge with localStorage)
  │
  └─ Notification prefs ──► Convex alertRules + notificationChannels

AIS relay (existing, _seed-utils.mjs)
  └─ atomicPublish() → PUBLISH wm:events:notify (new, extends existing)

Railway notification-delivery service (new)
  │
  ├─ SUBSCRIBE wm:events:notify (event-driven, replaces 60s poll)
  ├─ Queries Convex alertRules for matching users (by_enabled + variant filter)
  └─ Fans out via token-bucket queues to:
       ├─ Telegram Bot API  (25 msg/s bucket; chat_id from notificationChannels)
       ├─ Slack webhook     (0.8 msg/s bucket; URL encrypted at rest, re-validated at send)
       └─ Resend email      (rate-limited; email cached in notificationChannels at link time)
```

### Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Sync conflict resolution | `syncVersion` wins (server-incremented monotonic counter) | Clock skew on `updatedAt` (client-supplied) causes stale prefs to silently win |
| Sync scope | Explicit allowlist of safe keys only (see below) | Secrets in `mcp-store.ts` customHeaders and `runtime-config.ts` vault must never leave the device |
| Convex table name | `userPreferences` (not `savedViews`) | Single canonical blob per userId+variant; `savedViews` implies multi-slot named views (Phase 2 extension) |
| Prefs schema type | `v.any()` (not `v.string()`) | String blob bypasses all Convex validation; migration after data exists is non-trivial |
| Alert delivery loop | Redis pub/sub subscription in `notification-relay` | 60s poll = 60s worst-case latency; pub/sub drops this to <2s. `atomicPublish()` already has the Redis connection |
| Telegram pairing UX | Deep link with 15-minute time-limited token (base64url, 43 chars) | Best UX; base64url has 21 chars headroom vs hex at exactly Telegram's 64-char limit |
| Pairing status detection | `useQuery` WebSocket subscription (not setTimeout poll) | Convex is push-based over WebSockets; polling is unnecessary and architecturally wrong |
| Email address source | Cached in `notificationChannels` at link time (from `clerk.ts:130`) | Eliminates Clerk API fan-out in hot relay path; Clerk API rate limits would drop notifications |
| Alert rule scope | Per-variant | Tech-variant user should not receive conflict/OREF alerts from full-variant |
| Webhook URL storage | `v1:<base64(iv+tag+ciphertext)>` envelope with `keyVersion` prefix | Enables key rotation without re-encrypting all rows simultaneously |
| Sign-out behaviour | Preserve localStorage; mark sync state as `signed-out` | Do not silently delete user data |
| Phase 2 gating | `VITE_CLOUD_PREFS_ENABLED` feature flag (follow `src/config/beta.ts` pattern) | Decouples Phase 2 shipping from PR #1812 merge; enables internal QA before Clerk is live |

---

## Syncable Preferences Allowlist

**Include in cloud sync:**

| localStorage Key | Purpose |
|---|---|
| `worldmonitor-panels` | Panel enabled/priority map |
| `worldmonitor-monitors` | Keyword monitor configs (no secrets) |
| `worldmonitor-layers` | Map layer toggles |
| `worldmonitor-disabled-feeds` | Disabled news sources |
| `worldmonitor-panel-spans` | Panel row heights |
| `worldmonitor-panel-col-spans` | Panel column widths |
| `worldmonitor-panel-order` | User reorder sequence |
| `worldmonitor-theme` | Light/dark/system |
| `worldmonitor-variant` | Active variant |
| `worldmonitor-map-mode` | Flat/globe |
| `worldmonitor-runtime-feature-toggles` | Feature flags (non-secret toggles only) |
| `wm-breaking-alerts-v1` | Alert sensitivity settings |
| `wm-market-watchlist-v1` | Market watchlist symbols |
| `aviation:watchlist:v1` | Aviation watchlist |
| `wm-pinned-webcams` | Pinned webcam list |
| `wm-map-provider` | Map tile provider |
| `wm-font-family` | UI font preference |
| `wm-globe-visual-preset` | Globe visual settings |
| `wm-stream-quality` | Video quality preference |

**Explicitly excluded from cloud sync (secrets / device-local):**

| localStorage Key | Reason |
|---|---|
| `wm-mcp-panels` | Contains `customHeaders` with API keys (Authorization: Bearer …) |
| `wm-pro-html-{id}` | Widget HTML — large, device-generated, not portable |
| `wm-custom-widgets` | Widget metadata with tool configs |
| `wm-pro-key` / `wm-widget-key` | API key credentials |
| `worldmonitor-runtime-feature-toggles` vault entries | 26 `RuntimeSecretKey` API keys (Groq, ACLED, OpenSky, etc.) |
| `wm-live-channels` / `wm-active-channel` | Device-specific stream session state |
| `map-height` / `map-pinned` | Device-specific viewport state |

---

## Implementation Phases

### Phase 0: Pre-Work (no Clerk dependency, can start now)

**Goal:** Establish the primitives needed by all subsequent phases.

**Deliverables:**

1. **`convex/auth.config.ts`** — replace `jose` + JWKS with native Convex-Clerk integration:
   ```typescript
   export default {
     providers: [{
       domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
       applicationID: "convex",
     }],
   } satisfies AuthConfig;
   ```
   Set `CLERK_JWT_ISSUER_DOMAIN` in the Convex dashboard env (Frontend API URL, not Dashboard URL).

2. **`convex/constants.ts`** — shared validators to prevent drift:
   ```typescript
   export const channelTypeValidator = v.union(
     v.literal("telegram"),
     v.literal("slack"),
     v.literal("email"),
   );
   export const sensitivityValidator = v.union(
     v.literal("all"),
     v.literal("high"),
     v.literal("critical"),
   );
   export const CURRENT_PREFS_SCHEMA_VERSION = 1;
   export const MAX_PREFS_BLOB_SIZE = 65536; // 64KB
   ```

3. **`server/_shared/timing-safe.ts`** — constant-time comparison (required by P1-2):
   ```typescript
   export function timingSafeEqual(a: string, b: string): boolean {
     const aBuf = Buffer.from(a);
     const bBuf = Buffer.from(b);
     if (aBuf.length !== bBuf.length) return false;
     return crypto.timingSafeEqual(aBuf, bBuf);
   }
   ```

4. **Encryption utilities** with key versioning (`relay/lib/crypto.cjs`):
   ```javascript
   // Envelope format: "v1:<base64(iv[12] + tag[16] + ciphertext)>"
   const KEYS = { v1: Buffer.from(process.env.ENCRYPTION_KEY_V1, 'base64') };
   const CURRENT_VERSION = 'v1';
   function encrypt(plaintext) { /* random IV, AES-256-GCM, prepend version */ }
   function decrypt(stored) { /* parse version, select key, decrypt */ }
   ```

 `v.any()` stores JavaScript objects natively — no `JSON.parse/stringify` overhead, full type preservation. DO NOT use `v.string()` for the prefs blob.

- `ctx.auth.getUserIdentity()` in Convex mutations extracts `identity.subject` (Clerk userId). This is the ONLY correct source of userId — never accept it from mutation args.
- Convex CORS requires **paired OPTIONS + main routes**. `Authorization` must be in `Access-Control-Allow-Headers`. CORS headers must appear on ALL responses including 4xx.

---

### Phase 1: Convex Schema + Preferences Sync API (blocker for all subsequent phases)

**Goal:** Convex has the tables and HTTP actions needed. The app can write/read preferences for a signed-in user.

**Deliverables:**

#### `convex/schema.ts` additions

```typescript
// convex/schema.ts
import { channelTypeValidator, sensitivityValidator } from "./constants";

userPreferences: defineTable({
  userId: v.string(),           // from ctx.auth.getUserIdentity().subject — NEVER from args
  variant: v.string(),          // 'full' | 'tech' | 'finance' | 'commodity' | 'happy'
  data: v.any(),                // preference object (allowlist-filtered); NOT v.string()
  schemaVersion: v.number(),    // CURRENT_PREFS_SCHEMA_VERSION at write time
  updatedAt: v.number(),        // server-stamped Unix ms (display only — NOT used for conflict resolution)
  syncVersion: v.number(),      // server-incremented; PRIMARY conflict resolver
}).index("by_user_variant", ["userId", "variant"]),

// DISCRIMINATED UNION — one document per channelType per user
notificationChannels: defineTable(
  v.union(
    v.object({
      userId: v.string(),
      channelType: v.literal("telegram"),
      chatId: v.string(),           // from Telegram webhook — ONLY set by claimPairingToken
      verified: v.boolean(),        // set to true inside claimPairingToken mutation
      linkedAt: v.number(),
    }),
    v.object({
      userId: v.string(),
      channelType: v.literal("slack"),
      webhookEnvelope: v.string(),  // "v1:<base64(iv+tag+ciphertext)>" — never plaintext
      email: v.optional(v.string()), // NOT used for slack, but field exists for union compat
      verified: v.boolean(),        // set to true after test message succeeds
      linkedAt: v.number(),
    }),
    v.object({
      userId: v.string(),
      channelType: v.literal("email"),
      email: v.string(),            // cached from clerk.ts:130 at link time — NOT fetched at send time
      verified: v.boolean(),        // Clerk email_verified claim
      linkedAt: v.number(),
    }),
  )
).index("by_user", ["userId"])
 .index("by_user_channel", ["userId", "channelType"]),

alertRules: defineTable({
  userId: v.string(),
  variant: v.string(),
  enabled: v.boolean(),
  eventTypes: v.array(v.string()),
  sensitivity: sensitivityValidator,
  channels: v.array(channelTypeValidator),  // typed union, NOT v.array(v.string())
  updatedAt: v.number(),
}).index("by_user", ["userId"])
 .index("by_user_variant", ["userId", "variant"])
 .index("by_enabled", ["enabled"]),           // REQUIRED: relay queries by enabled=true

telegramPairingTokens: defineTable({
  userId: v.string(),
  token: v.string(),           // base64url, 43 chars (NOT hex — hex is at Telegram's 64-char limit)
  expiresAt: v.number(),       // Unix ms, 15 minutes from creation
  used: v.boolean(),
}).index("by_token", ["token"])
 .index("by_user", ["userId"]),
```

 `by_enabled` index on `alertRules` is essential — without it, the notification relay does a full table scan every time an event arrives.

- `notificationChannels` uses a discriminated union so TypeScript narrows correctly in mutation handlers. `chatId` is only present on telegram rows; `webhookEnvelope` only on slack rows.
- `syncVersion` is server-owned and server-incremented. The client supplies `expectedSyncVersion` as a precondition guard (see mutation below) — prevents silent overwrites from concurrent tabs.
- `schemaVersion` at document level (not inside the blob) enables version-aware reads without parsing blob content.

#### `convex/userPreferences.ts` (new file)

```typescript
// convex/userPreferences.ts
export const getPreferences = query({ ... })        // by userId+variant; apply schemaVersion migration
export const setPreferences = mutation({ ... })     // upsert; accepts expectedSyncVersion; server-stamps updatedAt

// Example setPreferences mutation:
// 1. ctx.auth.getUserIdentity() → userId (NEVER from args)
// 2. db.query(...).withIndex("by_user_variant", ...).unique() → existing
// 3. if existing && existing.syncVersion !== args.expectedSyncVersion → throw ConvexError("CONFLICT")
// 4. Validate args.data size ≤ MAX_PREFS_BLOB_SIZE (enforce in mutation, not schema)
// 5. db.patch(existing._id, { data, schemaVersion: CURRENT_PREFS_SCHEMA_VERSION, updatedAt: Date.now(), syncVersion: (existing?.syncVersion ?? 0) + 1 })

export const getChannels = query({ ... })
export const setChannel = mutation({ ... })         // encrypt webhook server-side; send test msg for Slack; set verified=true
export const deleteChannel = mutation({ ... })      // remove channel + clean up alertRules.channels[]
export const getAlertRules = query({ ... })
export const setAlertRules = mutation({ ... })
export const createPairingToken = mutation({ ... }) // generate base64url token (NOT hex); set used=false, expiresAt=now+15min
export const claimPairingToken = mutation({ ... })  // ATOMIC: check used+expiry, set chatId, set verified=true, set used=true in ONE mutation
```

#### `convex/http.ts` additions

```typescript
// POST /api/user-prefs — JWT-authenticated (Bearer token from Clerk "convex" template)
// OPTIONS /api/user-prefs — CORS preflight (paired route required)
// POST /api/telegram-pair-callback — UNAUTHENTICATED (called by Telegram bot)
//   Verifies X-Telegram-Bot-Api-Secret-Token header with timingSafeEqual()
//   Verifies message.chat.type === 'private'
//   Verifies message.date within 15 minutes
//   Calls claimPairingToken mutation
//   Always returns HTTP 200 (non-200 triggers Telegram retry storm)
```

**Note:** `undefined` values are stripped by Convex during serialization. Use `null` as the sentinel for "cleared field" in all preference objects.

 [ ] `convex/schema.ts` has all four new tables with indexes including `by_enabled`

- [ ] `convex/userPreferences.ts` exports all 8 mutations/queries
- [ ] `convex/auth.config.ts` uses native Clerk integration (no `jose`)
- [ ] `npx convex dev` applies schema without errors
- [ ] HTTP action `POST /api/user-prefs` returns 200 for a valid Clerk JWT + stores prefs in `userPreferences`
- [ ] HTTP action returns 401 for missing/invalid JWT
- [ ] HTTP action returns 409 with `"CONFLICT"` when `expectedSyncVersion` does not match
- [ ] `telegramPairingTokens` expire correctly (expiresAt check in mutation, not query filter only)
- [ ] `claimPairingToken` is atomic: sets `used=true` AND `chatId` AND `verified=true` in one mutation
- [ ] Prefs blob > 64KB is rejected with 400

---

### Phase 2: Frontend Preferences Sync

**Goal:** When a user signs in, their cloud prefs are loaded. When prefs change, they are debounced-synced to Convex.

**Feature flag gate:** `VITE_CLOUD_PREFS_ENABLED` must be `true`. Follow `src/config/beta.ts` pattern. This allows Phase 2 to be merged and deployed before PR #1812 lands; flip flag when Clerk is verified in production.

 `src/utils/settings-persistence.ts` — add `syncToCloud()` / `syncFromCloud()` with `schemaVersion` migration

- `src/services/auth-state.ts` — hook `initAuthState()` to call `syncFromCloud()` on sign-in
- `src/App.ts` — hook preference write events to trigger debounced `syncToCloud()`

#### Sync protocol

```
On sign-in (initAuthState resolves with user.id):
  1. Render immediately with localStorage prefs (OPTIMISTIC — do NOT block first paint)
  2. Fetch cloud prefs for (userId, currentVariant) in parallel
  3. If cloud.syncVersion > localStorage['wm-cloud-sync-version']:
       Apply schemaVersion migration if needed (MIGRATIONS[cloud.schemaVersion] → CURRENT)
       Apply cloud prefs to localStorage (cloud wins — newer syncVersion)
  4. If 'wm-cloud-sync-version' is null (first ever sign-in) AND cloud prefs exist:
       Cloud wins silently. Show 5-second undo toast: "We restored your preferences from another device. [Undo]"
       Undo applies the local prefs and uploads them.
  5. Else: upload local prefs to cloud with expectedSyncVersion = wm-cloud-sync-version
  5. Store cloud.syncVersion in localStorage['wm-cloud-sync-version']

On preference change (any SETTINGS_KEY_PREFIXES write):
  → Debounce 5000ms for layout/display prefs (reduce write amplification)
  → Debounce 2000ms for alert rule changes only
  → Build filtered prefs blob (allowlist only — sync NEVER touches mcp-store or vault keys)
  → POST /api/user-prefs with { variant, data, expectedSyncVersion: wm-cloud-sync-version }
  → On success: update localStorage['wm-cloud-sync-version'] = response.syncVersion
  → On 409 CONFLICT: re-fetch cloud prefs, merge, retry once
  → On visibility hide (tab switch/close): cancel debounce timer, flush via navigator.sendBeacon() in visibilitychange+pagehide handlers
     NOTE: `beforeunload` is NOT reliable (disabled by bfcache, does not fire on mobile). Use `visibilitychange`+`pagehide` instead.
     Multi-tab: listen to `storage` event; cancel local debounce when another tab writes a newer `localUpdatedAt`.
  → `wm-last-sync-at` is set from the server-returned timestamp in the response, NOT from `Date.now()` — set ONLY after confirmed server success

On sign-out:
  → Clear localStorage['wm-cloud-sync-state'] (sync metadata only, not prefs)
  → Set localStorage['wm-last-signed-in-as'] = userId
```

#### schemaVersion migration pattern

```typescript
// src/utils/settings-persistence.ts
const CURRENT_PREFS_SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> = {
  // Example: version 2 renames mapNewsFlash → mapFlash
  // 2: (data) => { data.mapFlash = data.mapNewsFlash; delete data.mapNewsFlash; return data; },
};

function applyMigrations(data: Record<string, unknown>, fromVersion: number): Record<string, unknown> {
  let result = data;
  for (let v = fromVersion + 1; v <= CURRENT_PREFS_SCHEMA_VERSION; v++) {
    result = MIGRATIONS[v]?.(result) ?? result;
  }
  return result;
}
```

**New localStorage metadata keys (sync state, not synced themselves):**

| Key | Type | Purpose |
|---|---|---|
| `wm-cloud-sync-version` | `number` | Last known cloud syncVersion (PRIMARY conflict resolver) |
| `wm-last-sync-at` | `number` | Server-returned Unix ms of last confirmed sync write (set ONLY after server success — never `Date.now()`) |
| `wm-cloud-sync-state` | `'synced' \| 'pending' \| 'syncing' \| 'conflict' \| 'offline' \| 'signed-out' \| 'error'` | UI indicator |

 [ ] Sign in on Device A → panel layout from Device B (pre-seeded in Convex) loads correctly without blocking first paint

- [ ] Change watchlist on Device A → sign in on Device B → watchlist matches Device A
- [ ] Tab close with pending debounce → prefs flushed via `sendBeacon`
- [ ] Sign out → prefs preserved locally (localStorage not cleared)
- [ ] Sync does not include any `RuntimeSecretKey` values or `wm-mcp-panels`
- [ ] 409 CONFLICT triggers re-fetch and merge (no silent data loss)
- [ ] `VITE_CLOUD_PREFS_ENABLED=false` → sync is a complete no-op (no Convex calls)
- [ ] Cloud sync indicator shows all 7 states in settings UI (including `syncing` and `offline`)
- [ ] `offline` state detected via fetch probe to `/api/health` (not `navigator.onLine` — unreliable)
- [ ] `offline` auto-retries on `window.addEventListener("online")` event
- [ ] `error` state requires manual retry (not auto-retry — server may be rate-limiting)
- [ ] First sign-in with both local and cloud prefs shows 5-second undo toast (cloud wins by default)
- [ ] `sendBeacon` flush on `visibilitychange`+`pagehide` (NOT `beforeunload`)

---

### Phase 3: Notification Channel Linking UI

**Goal:** Users can link Telegram, Slack, and email (auto from Clerk) in Preferences → Notifications. Alert rule preferences can be configured per-variant.

 `src/components/NotificationSettingsPanel.ts` — new panel inside Settings modal

- `src/services/notification-channels.ts` — channel state management (wraps Convex queries/mutations)

#### Telegram pairing flow

```
1. User clicks "Connect Telegram"
2. Frontend calls POST /api/user-prefs → createPairingToken → returns {token, deepLink}
   token: base64url (43 chars) — NOT hex (hex = exactly 64 chars, at Telegram's hard limit)
   deepLink = `https://t.me/WorldMonitorBot?start=<token>`
3. UI shows: "Open Telegram" button + deepLink (optionally QR via canvas)
   Token expires after 15 minutes — show countdown timer in UI
4. User taps deepLink → opens Telegram → sends /start <token> to @WorldMonitorBot
5. Bot webhook:
   a. Verifies X-Telegram-Bot-Api-Secret-Token header with timingSafeEqual() [REQUIRED — P0]
   b. Verifies message.chat.type === 'private' (reject group chats)
   c. Verifies message.date within 900 seconds (defense-in-depth on top of Convex expiry)
   d. Extracts token from /start <token> using regex: /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{1,64})$/
   e. Calls claimPairingToken mutation (atomic: sets chatId + verified=true + used=true)
   f. Sends confirmation message: "WorldMonitor connected. You will receive alerts here."
   g. Returns HTTP 200 always (non-200 triggers Telegram retry storm)
6. Frontend: useQuery(api.notifications.getPairingStatus) auto-updates via WebSocket push
   (NO setInterval polling — Convex is already push-based over WebSockets)


``



``javascript
await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: `${CONVEX_SITE_URL}/api/telegram-pair-callback`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET, // separate from BOT_TOKEN
    allowed_updates: ['message'],  // minimize attack surface
  }),
});
```

#### Slack linking flow

```
1. User pastes Slack incoming webhook URL into input
2. Frontend validates format: must match ^https://hooks\.slack\.com/services/[A-Z0-9]+/[A-Z0-9]+/[a-zA-Z0-9]+$
3. POST /api/user-prefs → setChannel({type: 'slack', webhookUrl})
4. Server-side:
   a. Re-validate URL (same regex — allowlist at write AND at send time) [P0-SSRF prevention]
   b. Resolve domain and verify not RFC-1918 / link-local address [P0-SSRF prevention]
   c. Encrypt with AES-256-GCM: "v1:<base64(iv+tag+ciphertext)>" envelope
   d. Store webhookEnvelope in notificationChannels (NEVER store plaintext)
   e. Send test message: "WorldMonitor connected ✓" (verifies webhook is live)
   f. If test message returns 200/ok: set verified=true


``

#### Email linking flow

```

1. Email is auto-populated from Clerk user profile at channel-linking time
   Source: getCurrentClerkUser().primaryEmailAddress (src/services/clerk.ts:130)
2. Only Clerk-verified email addresses accepted (emailAddress.verification.status === 'verified')
3. Cached in notificationChannels.email at link time — NOT fetched from Clerk API at send time

``

#### Alert rules UI

```
For each variant the user has accessed:
  - Event type checkboxes: Conflicts · Markets · Breaking News · Aviation · OREF
  - Sensitivity: All events / High only / Critical only
  - Channel checkboxes: Telegram · Slack · Email (only checked if channel is verified)
Rate limit display: "Max 5 alerts/hour per event type" (clarify: per-channel-send, not per-event)
```

 [ ] Telegram pairing completes end-to-end in < 60 seconds

- [ ] `X-Telegram-Bot-Api-Secret-Token` verified with `timingSafeEqual()` on every webhook call
- [ ] Group chat `/start` commands are rejected (chat.type !== 'private')
- [ ] Expired pairing token (> 15 min) shows clear error "Link expired — please start over"
- [ ] useQuery subscription updates pairing status without setTimeout polling
- [ ] Slack webhook URL validated client-side AND server-side (re-validated at send time too)
- [ ] Slack webhook URL is never returned to the client after saving
- [ ] Slack test message sent on link; verified=true only if test succeeds
- [ ] Email auto-populated from Clerk, no user entry required
- [ ] Alert rules are scoped per-variant and persist across sessions
- [ ] Deleting a channel removes it from alertRules.channels[] (or sets enabled=false if channels[] becomes empty)
- [ ] "Connected" / "Not connected" state is accurate within 1 second (WebSocket push)

---

### Phase 4: Notification Delivery Infrastructure (Railway)

**Goal:** A new Railway service (`notification-relay`) listens for breaking events and delivers to user channels.

 `relay/notification-relay.cjs` — new Railway service (follows `ais-relay.cjs` pattern)

- `scripts/_seed-utils.mjs` — add `PUBLISH` call inside `atomicPublish()` for event-driven delivery

#### Event-driven architecture (replaces 60s poll)

```javascript
// scripts/_seed-utils.mjs — add inside atomicPublish()
// After writing to Redis key, also publish to notification channel:
await redis.publish('wm:events:notify', JSON.stringify({
  eventType,    // 'conflict' | 'market' | 'breaking' | 'aviation' | 'oref'
  severity,     // 'high' | 'critical'
  payload,      // event data (title, summary, location)
  publishedAt: Date.now(),
}));
```

```javascript
// relay/notification-relay.cjs
// Subscribe to events channel (event-driven, no poll)
const subscriber = redis.duplicate();
await subscriber.subscribe('wm:events:notify');

subscriber.on('message', async (channel, message) => {
  const event = JSON.parse(message);
  await processEvent(event);
});

// Graceful shutdown for Railway restart
process.on('SIGTERM', () => subscriber.quit());
```

#### Delivery fan-out with rate-controlled queues

```javascript
// relay/notification-relay.cjs
const { ConvexHttpClient } = require("convex/browser"); // NOT convex/react
const convex = new ConvexHttpClient(process.env.CONVEX_URL);

async function processEvent(event) {
  // 1. Query matching rules using by_enabled index (NOT full table scan)
  const enabledRules = await convex.query(api.alertRules.getByEnabled, { enabled: true });
  const matching = enabledRules.filter(r =>
    r.eventTypes.includes(event.eventType) &&
    matchesSensitivity(r.sensitivity, event.severity)
  );

  // 2. For each rule, check dedup (SET NX — atomic)
  const eventHash = sha256Hex(JSON.stringify({ type: event.eventType, title: event.payload.title }));
  // sha256Hex from server/_shared/hash.ts — NOT FNV-1a (unsafe for attacker-controlled input)

  for (const rule of matching) {
    const dedupKey = `wm:notif:dedup:${rule.userId}:${eventHash}`;
    const isNew = await redis.set(dedupKey, '1', 'NX', 'EX', 1800); // SET NX — atomic, prevents dual-delivery
    if (!isNew) continue; // already delivered in this 30-min window

    // 3. Rate limit (per-channel-send, not per-event-fan-out)
    const channels = await convex.query(api.notifications.getChannels, { userId: rule.userId });
    for (const channel of channels.filter(c => c.verified && rule.channels.includes(c.channelType))) {
      await deliveryQueue.enqueue({ channel, event, userId: rule.userId });
    }
  }
}

// Token-bucket queues per channel type
const telegramQueue = new TokenBucket(25, 1000);  // 25 msg/s
const slackQueue    = new TokenBucket(0.8, 1000); // 0.8 msg/s
const emailQueue    = new TokenBucket(10, 1000);  // 10 msg/s (Resend limit)
```

#### Telegram delivery with 403/400 handling

```javascript
async function sendTelegram(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });

  if (res.status === 403) {
    // User blocked the bot — deactivate their Telegram integration
    await convex.mutation(api.notifications.deactivateChannel, { userId, channelType: 'telegram' });
    return;
  }
  if (res.status === 400) {
    const body = await res.json();
    if (body.description?.includes('chat not found')) {
      await convex.mutation(api.notifications.deactivateChannel, { userId, channelType: 'telegram' });
    }
    return;
  }
  if (res.status === 429) {
    const retryAfter = (await res.json()).parameters?.retry_after ?? 5;
    await sleep((retryAfter + 1) * 1000);
    return sendTelegram(chatId, text); // single retry
  }
}
```

#### Slack delivery with SSRF prevention

```javascript
async function sendSlack(webhookEnvelope, text) {
  const webhookUrl = decrypt(webhookEnvelope); // decrypt with versioned key

  // Re-validate at send time (NOT just at write time) — prevents SSRF bypass
  if (!isValidSlackWebhook(webhookUrl)) throw new Error('Invalid webhook URL');

  // Block RFC-1918 and link-local ranges
  const { address } = await dns.resolve4(new URL(webhookUrl).hostname);
  if (isPrivateIP(address)) throw new Error('Webhook URL resolves to private IP');

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, unfurl_links: false }),
    signal: AbortSignal.timeout(10000), // 10s timeout
  });

  if (res.status === 404 || res.status === 410) {
    await convex.mutation(api.notifications.deactivateChannel, { userId, channelType: 'slack' });
  }
}
```

 `TELEGRAM_BOT_TOKEN` — @WorldMonitorBot token (Railway + Convex env)

- `TELEGRAM_WEBHOOK_SECRET` — secret for `X-Telegram-Bot-Api-Secret-Token` (Convex env, separate from token)
- `ENCRYPTION_KEY_V1` — 32-byte base64 for AES-256-GCM (Railway env; NEVER in Convex)
- `CLERK_JWT_ISSUER_DOMAIN` — Convex auth config (already in Clerk migration)
- `CONVEX_URL` — Convex deployment URL for HTTP action calls

**Security rules:**

- Slack webhook URLs: re-validate `^https://hooks\.slack\.com/` at BOTH write AND send time
- Slack webhook URLs: DNS-resolve and block RFC-1918, link-local (169.254.x, 10.x, 172.16.x, ::1)
- Telegram: validate `chat_id` is a positive integer (private chats only)
- Email: send only to Clerk-cached-verified email addresses (cached at link time from `clerk.ts:130`)
- Rate limiting: 5 notifications per user per hour per channel (tracked with @upstash/ratelimit sliding window — NOT manual counter + TTL which resets on relay restart)
- Event dedup: `SET NX` in Redis (atomic) — NOT GET-then-SET (two relay instances = duplicate delivery otherwise)
- Dedup hash: `sha256Hex()` from `server/_shared/hash.ts` — NOT FNV-1a (unsafe for attacker-controlled input)
- `APP_ENCRYPTION_KEY` lives in Railway env vars ONLY — never in Convex (Convex dashboard access would expose it)

**Acceptance criteria — Phase 4:**

- [ ] An event published to `wm:events:notify` results in a Telegram message for a subscribed user within 10 seconds (vs 60 seconds with polling)
- [ ] Same event does not deliver twice within 30 minutes (SET NX dedup)
- [ ] Two concurrent relay instances do not double-deliver (SET NX atomic)
- [ ] A user who has not verified any channel produces no outbound request
- [ ] Rate limit uses sliding window (@upstash/ratelimit) — survives relay restart without window reset
- [ ] Telegram 403 (user blocked bot) deactivates the channel and stops further attempts
- [ ] Slack URL re-validated at send time (write-time-only validation is not sufficient)
- [ ] Slack URL resolving to private IP is rejected at send time
- [ ] Service restarts cleanly via Railway `SIGTERM` handler
- [ ] `CLERK_SECRET_KEY` is NOT present in Railway env (email comes from Convex cache, not Clerk API)

---

## System-Wide Impact

### Interaction Graph

```
User changes panel layout
  → localStorage write (existing)
  → debounced syncToCloud() fires (new, 5s debounce)
    → POST /api/user-prefs (Convex HTTP action)
      → setPreferences mutation (Convex, server-stamps updatedAt + increments syncVersion)
        → userPreferences document upserted

AIS relay publishes event (existing: atomicPublish in _seed-utils.mjs)
  → PUBLISH wm:events:notify (new: one-line addition to atomicPublish)
    → notification-relay subscriber wakes immediately
      → queries alertRules (by_enabled index)
        → fans out via token-bucket queues to Telegram/Slack/email

User signs in
  → auth-state.ts: initAuthState() resolves
    → render panels immediately with localStorage prefs (no blocking)
    → getPreferences query (Convex, parallel)
      → if cloud.syncVersion > localStorage['wm-cloud-sync-version']:
          apply schemaVersion migrations if needed
          apply cloud prefs to localStorage → App.ts re-renders panels
```

### Error Propagation

| Error | Location | Handling |
|---|---|---|
| Convex HTTP action 401 | Frontend sync | Silent — do not retry, do not block UX. Set `wm-cloud-sync-state = 'signed-out'`. |
| Convex HTTP action 409 CONFLICT | Frontend sync | Re-fetch cloud prefs, merge, retry once. |
| Convex HTTP action 500 | Frontend sync | Retry once after 5s. If still failing, mark `wm-cloud-sync-state = 'error'`. |
| Convex unreachable (offline) | Frontend sync | Set `wm-cloud-sync-state = 'offline'`. Resume on reconnect. |
| Telegram 403 (user blocked bot) | notification-relay | Deactivate channel in Convex. Log event. Stop retrying. |
| Telegram 429 (rate limit) | notification-relay | Respect `retry_after` header. Single retry. |
| Slack webhook 404/410 | notification-relay | Deactivate channel in Convex. Do not retry. |
| Slack URL resolves to private IP | notification-relay | Skip delivery, log security event. |
| Resend 429 | notification-relay | Skip delivery in this window. Sliding window rate limit prevents burst re-delivery. |
| Convex unreachable | notification-relay | Log, continue subscriber loop (do not crash Railway service). |
| Redis pub/sub disconnect | notification-relay | Reconnect with exponential backoff. Log gap in coverage. |

### State Lifecycle Risks

- **Partial sign-in sync:** Render immediately from localStorage (optimistic). Cloud prefs applied when response arrives. Panels may re-render once. Mitigation: call `syncFromCloud()` before `panelLayout.init()` in `async init()` so cloud prefs win if they arrive fast enough; optimistic render is a fallback not a race.
- **Concurrent writes from two tabs:** Client supplies `expectedSyncVersion`. Mutation rejects with 409 if mismatch. The losing tab re-fetches and retries with merged state. No silent data loss.
- **Relay restart during fan-out:** Redis SET NX dedup key is written before delivery attempt. If relay crashes after SET NX but before delivery, event is silently skipped until 30-min TTL expires (at-most-once delivery). This is the documented tradeoff. Document in relay README.
- **MCP panel custom headers are never in the sync blob:** Allowlist filter runs at serialisation time in `syncToCloud()`. Fail-closed by default — new keys must be explicitly added to allowlist.

### API Surface Parity

- `convex/http.ts` gains `POST /api/user-prefs` — joins existing `POST /api/register-interest` and `POST /api/contact` patterns
- `POST /api/telegram-pair-callback` is unauthenticated (called by Telegram, verified by secret token + content token)
- The gateway (`server/gateway.ts`) does not need changes — user-pref calls go direct to Convex, not through the WorldMonitor gateway

### Integration Test Scenarios

1. **Sign-in sync (optimistic):** Mock Clerk sign-in. Verify localStorage is used for initial render. Verify cloud prefs arrive and are applied within one Convex query round-trip.
2. **Secret exclusion:** Call `syncToCloud()` with `wm-mcp-panels` containing `customHeaders: {"Authorization": "Bearer secret"}`. Assert Convex mutation arg does not contain the string "secret" or "Bearer".
3. **Telegram pairing expiry:** Create a pairing token with `expiresAt = Date.now() - 1`. Assert `claimPairingToken` mutation throws and webhook callback returns HTTP 200 with "Token expired" message.
4. **Notification dedup (SET NX):** Inject the same breaking event twice into the notification loop. Assert only one Telegram message is sent per user within 30 minutes. Simulate two concurrent relay instances — neither duplicates.
5. **Slack SSRF:** Attempt to link `https://hooks.slack.com.evil.com/hook`. Assert setChannel rejects. Attempt a URL that DNS-resolves to 10.0.0.1 — assert relay rejects at send time.

---

## Acceptance Criteria

### Functional

- [ ] A signed-in user on a new device sees their panel layout, watchlist, and source preferences within 3 seconds of page load (rendered optimistically from localStorage; cloud prefs apply without blocking)
- [ ] Preferences changed on one device appear on a second device after sign-out/sign-in (no realtime sync in v1)
- [ ] Secrets (MCP headers, runtime API keys) are never written to Convex under any code path
- [ ] A user can link and unlink a Telegram account via deep-link pairing (useQuery for status, not setTimeout)
- [ ] A user can link and unlink a Slack webhook (URL never returned to client after save)
- [ ] Email notifications use the user's Clerk email address (cached at link time, no API call at send time)
- [ ] Alert rules are per-variant and persist across sessions
- [ ] Notifications are rate-limited (5 per channel per hour, sliding window)
- [ ] Same event not delivered twice within 30 minutes (SET NX dedup)

### Non-Functional

- [ ] `syncToCloud()` does not block the UI thread (async, debounced, non-blocking on failure)
- [ ] `VITE_CLOUD_PREFS_ENABLED=false` means zero Convex calls for sync (complete no-op)
- [ ] Convex schema `npx convex deploy` succeeds with zero errors in CI
- [ ] notification-relay restarts cleanly from Railway SIGTERM without manual intervention
- [ ] Telegram Bot token and encryption keys are never logged in plaintext
- [ ] All Convex mutations extract `userId` from `ctx.auth.getUserIdentity().subject` — never from args
- [ ] Notification latency from event publish to Telegram delivery: < 10 seconds (p99)

### Quality Gates

- [ ] Unit tests for `syncToCloud()` allowlist filter (assert secrets are excluded)
- [ ] Unit test for pairing token expiry (atomic claim rejects expired tokens)
- [ ] Unit test for Slack URL validation (reject `hooks.slack.com.evil.com`, `http://`, RFC-1918 resolved IPs)
- [ ] Unit test for 409 CONFLICT handling (re-fetch + merge + retry)
- [ ] Unit test for dedup SET NX (two concurrent relay instances, one delivery)
- [ ] Integration test for sign-in prefs restoration (optimistic render + cloud merge)
- [ ] `npm run typecheck` passes with no new errors

---

## Dependencies & Prerequisites

| Dependency | Status | Notes |
|---|---|---|
| Clerk auth (PR #1812) | In review — P0/P1 blockers posted | Must merge and deploy before Phase 1 ships (Phase 0 and schema can start now) |
| `VITE_CLOUD_PREFS_ENABLED` feature flag | New | Gates Phase 2 shipping; decouples from Clerk PR timeline |
| Telegram bot registration (@WorldMonitorBot) | Not started | Requires BotFather registration; `setWebhook` with `secret_token` to Convex HTTP action URL |
| `TELEGRAM_WEBHOOK_SECRET` env var | Not set | Random 256-char string; separate from `TELEGRAM_BOT_TOKEN` |
| `ENCRYPTION_KEY_V1` env var | Not set | `openssl rand -base64 32`. Railway env ONLY (not Convex). |
| Resend sender domain verification | Already done | `noreply@worldmonitor.app` is verified; verify rate tier covers expected volume |
| Convex production deploy key | Already set | Per `convex.md` memory entry |
| Privacy policy update | Not done | Required before Phase 1 ships to EU users |
| @upstash/ratelimit | Add to relay deps | Sliding window rate limiting for notification delivery |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| MCP panel secrets leaked to Convex via sync | Medium (easy to forget in future) | Critical | Allowlist at serialisation, not deny-list; test explicitly |
| Telegram Bot rate limiting (30 msg/s per bot) | Low for v1 user volume | Medium | Token-bucket queue at 25 msg/s; single retry on 429 |
| Convex query performance with 10k+ users | Low initially | Medium | `by_enabled` index covers relay query; Redis materialization for 10k+ scale (see Phase 4) |
| Clerk PR delays block entire roadmap | High | High | `VITE_CLOUD_PREFS_ENABLED` flag decouples; Phase 0 and schema work can ship without Clerk |
| Encryption key compromise (all Slack webhooks exposed) | Low | High | Key versioning envelope enables rotation; key lives in Railway env only (not Convex dashboard) |
| Relay crash during fan-out = missed notification | Medium | Low (at-most-once acceptable) | Document in relay README; future v2 can use at-least-once pattern |
| Single relay instance at Telegram rate limit | Medium at 500+ users | Medium | Token-bucket queue handles this; scale to 2 relay instances when queue depth grows |

---

## Future Considerations

- **Named views (Phase 2 extension):** The `userPreferences` table can evolve to support multiple named slots (e.g., "Morning Markets", "Geopolitical Watch") by adding a `viewName` field and updating the `by_user_variant` index to `by_user_variant_view`.
- **Real-time cross-device sync:** Phase 2 uses sign-in only. A Phase 3 extension could use Convex's built-in reactivity once the app has a Convex provider. For now, the HTTP action + optimistic render pattern avoids that dependency.
- **Discord webhook (Phase 5):** `discord.com/api/webhooks` can be added identically to Slack in the allowlist and delivery loop.
- **In-app notification centre:** A `notificationHistory` Convex table (userId, eventId, deliveredAt, channel, read) would power an in-app bell icon.
- **At-least-once delivery:** Current relay is at-most-once (crash after SET NX = missed notification). A Redis list-based job queue (LPUSH/BRPOP) would provide at-least-once with exactly-once dedup.
- **Per-panel alert rules:** Advanced users may want "notify me only when the AIS disruption panel has new data." Requires per-panel subscription metadata — out of scope for v1.

---

## Sources & References

### Internal References

- Auth migration plan: `docs/internal/clerk-auth-migration-plan.md`
- Pro roadmap (Convex schema spec): `docs/roadmap-pro.md` (lines 277–396)
- Current preferences keys: `src/utils/settings-persistence.ts`
- Secrets vault keys: `src/services/runtime-config.ts` (`RuntimeSecretKey` union)
- MCP panel secret risk: `src/services/mcp-store.ts` (`McpPanelSpec.customHeaders`)
- Existing Convex mutation pattern: `api/register-interest.js:244`, `convex/registerInterest.ts`
- Resend email pattern: `api/contact.js:32-76`
- Alert dispatch hook: `src/services/breaking-news-alerts.ts:149` (`dispatchAlert()`)
- Railway relay pattern template: `relay/ais-relay.cjs`
- atomicPublish (extend for pub/sub): `scripts/_seed-utils.mjs:529`
- Clerk email source: `src/services/clerk.ts:130` (getCurrentClerkUser().primaryEmailAddress)
- Feature flag pattern: `src/config/beta.ts`
- Hash utilities: `server/_shared/hash.ts` (use `sha256Hex()` for dedup, NOT `hashString()`)
- Rate limit utilities: `server/_shared/rate-limit.ts` (use @upstash/ratelimit sliding window)
- High-value ideas doc: `ideas/highvalue.md:33-46` (multi-channel alerting spec)
- Existing Convex schema: `convex/schema.ts`

### External References

- [Convex-Clerk native auth integration](https://docs.convex.dev/auth/clerk)
- [Convex HTTP actions + CORS](https://docs.convex.dev/functions/http-actions)
- [Convex discriminated union tables](https://docs.convex.dev/database/schemas)
- [Telegram Bot API: setWebhook + secret_token](https://core.telegram.org/bots/api#setwebhook)
- [Telegram Bot API: deep linking (base64url)](https://core.telegram.org/bots/features#deep-linking)
- [Telegram Bot API: rate limits (30 msg/s)](https://core.telegram.org/bots/faq#broadcasting-to-users)
- [Slack incoming webhooks docs](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
- [@upstash/ratelimit sliding window](https://github.com/upstash/ratelimit-js)
- [AES-256-GCM key versioning pattern](https://cryptography.io/en/latest/fernet/)

### Related Work

- PR #1812 (`feat/better-auth` → Clerk migration) — must merge first (or use `VITE_CLOUD_PREFS_ENABLED` flag to ship independently)
- PR #2024 (Dodo Payments) — DEPLOYMENT-PLAN.md merge order: #1812 before #2024
