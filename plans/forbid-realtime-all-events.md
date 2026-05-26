# Forbid `(digestMode=realtime, sensitivity=all)` notification rules

## Why

A user enabled email notifications with **Real-time (immediate) × All events** and received **14 emails in 22 minutes** (Resend log, 2026‑04‑27). Four of those were `Severe Thunderstorm Warning` for adjacent NWS zones inside ~3 minutes. This is the worst kind of foot-gun:

- The user opted in, so we deliver — but no reasonable person wants 14 alerts/22min in their inbox.
- The bursty subset trains recipients to mark WorldMonitor as spam, which directly threatens the in-flight PRO launch broadcast warmup (kill threshold: complaint rate > 0.08%).
- A rate cap or coalescer would *hide* the symptom; this plan **prevents the configuration**.

The semantic claim: **real-time delivery means "interrupt me now."** That semantics is incompatible with `all` (which sweeps in market ticks, scheduled-event reminders, RSS chatter). Real-time should only ever pair with `high` or `critical`.

This is the primary fix. A complementary follow-up (Slot A: per-recipient hourly cap; Slot B: event-family coalesce for genuine bursts of `high`-tier events like NWS adjacent-zone storms) is tracked separately.

## The rule

```
(effective digestMode === 'realtime') ⇒ sensitivity ∈ {'high', 'critical'}
```

`(realtime, all)` is unrepresentable. Users who want "all events" must pick a digest cadence (`daily`, `twice_daily`, `weekly`).

**Effective digestMode** definition (used everywhere): `r.digestMode ?? 'realtime'` — schema comment at `convex/schema.ts:112` documents that absent = realtime, so a row with `digestMode === undefined` AND `sensitivity === 'all'` is the *silent third case* of the forbidden state. Every gate in this plan must use the `r.digestMode == null || r.digestMode === 'realtime'` form, never just `=== 'realtime'`.

This is a **cross-field invariant**. Convex's table-schema validators can't enforce it — only mutation code + relay defense can. The plan is a mutation/UI/relay/migration package, not a schema change.

## Scope — 5 lockstep surfaces (across multiple files each)

This kind of cross-cutting constraint bites you twice if you only fix one site. The rule must hold at:

1. **Convex mutation logic** — `convex/alertRules.ts` (6 existing mutations + 1 new internal mutation) + the HTTP-action default-fallback in `convex/http.ts:504`.
2. **Transport plumbing** — 4 files in lockstep so the new atomic mutation is reachable from the UI: `convex/alertRules.ts` (mutation), `convex/http.ts` (HTTP-action branch), `api/notification-channels.ts` (Vercel proxy branch with error passthrough), `src/services/notification-channels.ts` (client wrapper).
3. **Settings UI** — `src/services/notifications-settings.ts`. Includes a layout fix: sensitivity must be visible in digest mode.
4. **Relay coerce-at-read** — `scripts/notification-relay.cjs`. Single normalization point so BOTH sensitivity reads (legacy match + importance threshold) use the same effective value.
5. **Backfill migration + courtesy email** — covers ALL rows in the forbidden state, not just enabled ones.

Plus onboarding/tooltip copy that aligns the wording across UI helper text, server error message, and migration email (§5).

Each is detailed below.

---

## 1. Convex mutation logic

### 1a. Writer audit — every insert/patch path

Every mutation that touches the `alertRules` table — AND every HTTP-action default-insert path — can produce or preserve the forbidden state. Audit:

| Site | File:Line | Inserts default `sensitivity: "all"`? | Touches `digestMode`? | Touches `sensitivity`? |
|---|---|---|---|---|
| `setAlertRules` | `convex/alertRules.ts:17` | no (uses arg) | no | yes |
| `setDigestSettings` | `convex/alertRules.ts:65` | yes (line 111) | yes | no |
| `setAlertRulesForUser` (internal) | `convex/alertRules.ts:129` | no (uses arg) | no | yes |
| `setQuietHours` | `convex/alertRules.ts:193` | yes (line 236) | no | no |
| `setDigestSettingsForUser` (internal) | `convex/alertRules.ts:244` | yes (line 275) | yes | no |
| `setQuietHoursForUser` (internal) | `convex/alertRules.ts:282` | yes (line 320) | no | no |
| HTTP action `set-alert-rules` fallback | `convex/http.ts:504` | yes (`?? "all"` fallback when client omits sensitivity) | no | yes |

Two failure modes:

- Mutations that don't touch the pair directly (`setQuietHours`, `setQuietHoursForUser`) can *create* a forbidden row from scratch by default-inserting `sensitivity: "all"` when no row exists.
- The HTTP action at `convex/http.ts:504` hardcodes a `body.sensitivity ?? "all"` fallback before calling `setAlertRulesForUser` — even if the mutation defaults are flipped, this fallback re-introduces `"all"` for any client that omits the field.

Both must be addressed.

### 1b. Centralize via two helpers (one defaulter + one validator)

```ts
// convex/alertRules.ts (top of file)

const DEFAULT_DIGEST_HOUR = 8;

/**
 * Returns the (digestMode, sensitivity) pair that a fresh row should default to,
 * or that an existing row should hold after applying `incoming`. Used in both
 * default-insert paths and validator paths to keep them in lockstep.
 */
function resolveEffectivePair(args: {
  incomingDigestMode?: "realtime" | "daily" | "twice_daily" | "weekly";
  incomingSensitivity?: "all" | "high" | "critical";
  existing?: { digestMode?: string; sensitivity?: string };
}): { digestMode: "realtime" | "daily" | "twice_daily" | "weekly"; sensitivity: "all" | "high" | "critical" } {
  const digestMode = (args.incomingDigestMode
    ?? args.existing?.digestMode
    ?? "realtime") as "realtime" | "daily" | "twice_daily" | "weekly";
  const sensitivity = (args.incomingSensitivity
    ?? args.existing?.sensitivity
    ?? "high") as "all" | "high" | "critical"; // CHANGED: was "all" — see §1c
  return { digestMode, sensitivity };
}

function assertCompatibleDeliveryMode(pair: { digestMode: string; sensitivity: string }) {
  if (pair.digestMode === "realtime" && pair.sensitivity === "all") {
    throw new ConvexError({
      code: "INCOMPATIBLE_DELIVERY",
      message:
        "Real-time delivery requires High or Critical sensitivity. " +
        "To receive all events, choose Daily, Twice daily, or Weekly digest.",
    });
  }
}
```

**Apply at every writer**, after fetching `existing` and before patch/insert:

```ts
const pair = resolveEffectivePair({ incomingDigestMode: args.digestMode, incomingSensitivity: args.sensitivity, existing });
assertCompatibleDeliveryMode(pair);
// Then use pair.digestMode / pair.sensitivity for default-insert fallbacks below.
```

For `setAlertRules` and `setAlertRulesForUser` (writers of `sensitivity`), `incomingDigestMode` is undefined — it pulls from `existing` (or defaults to `'realtime'`). For `setDigestSettings` and `setDigestSettingsForUser`, vice versa. For `setQuietHours` and `setQuietHoursForUser`, *neither* is in args — the call validates that `existing`'s pair is still compatible, and on first-row insert the helper supplies safe defaults.

### 1c. Default flip: `sensitivity: "all"` → `sensitivity: "high"` — INSERT-ONLY

5 sites today produce the default `sensitivity: "all"`. Combined with the implicit `digestMode = realtime` (no digestMode field set), every first-row creation today produces the forbidden state.

Flip the default to `"high"`, but **only on fresh insert** — never on patch of an existing row. Patching an existing row when the caller omitted `sensitivity` must preserve the existing value, NOT silently narrow `daily+all` digest users to `daily+high`. This is the subtle data-corruption case Codex flagged: the HTTP `set-alert-rules` fallback at `convex/http.ts:504` applies to both inserts and patches, so a naive `?? "high"` flip would silently rewrite existing `sensitivity` whenever an older client (or admin script) omits the field.

**Implementation pattern (uniform across all 5 sites):**

1. **Make `sensitivity` optional** in `setAlertRulesForUser` (`convex/alertRules.ts:135`) and `setAlertRules` (`convex/alertRules.ts:22`). The validator was `sensitivityValidator`; change to `v.optional(sensitivityValidator)`.
2. **`resolveEffectivePair` already handles this**: it returns `args.incomingSensitivity ?? args.existing?.sensitivity ?? "high"`. So omitted-on-patch preserves existing; omitted-on-insert defaults to `"high"`. Same helper, no special-casing.
3. **Patch logic** must use `pair.sensitivity` (the resolved value) when no existing row is being created from scratch, AND must NOT include `sensitivity` in the `patch` object when the caller didn't pass one and we want to preserve. The simplest pattern:
   ```ts
   const patch: Record<string, unknown> = { /* ...other fields... */ };
   if (args.sensitivity !== undefined) patch.sensitivity = args.sensitivity;
   if (existing) await ctx.db.patch(existing._id, patch);
   else await ctx.db.insert("alertRules", { ...defaults, sensitivity: pair.sensitivity, ...patch });
   ```
4. **`convex/http.ts:504`** — remove the `?? "all"` fallback entirely. Pass `body.sensitivity` (which may be `undefined`) straight through to `setAlertRulesForUser`. The mutation now accepts optional sensitivity (per step 1) and `resolveEffectivePair` does the right thing for both insert and patch.

**Sites changed:**

- `convex/alertRules.ts:22` (validator: required → optional)
- `convex/alertRules.ts:135` (validator: required → optional)
- `convex/alertRules.ts:111,236,275,320` (4 default-insert literals: `sensitivity: "all"` → `sensitivity: pair.sensitivity` from `resolveEffectivePair`)
- `convex/http.ts:504` (remove fallback; pass `body.sensitivity` through unchanged)

**Why this matters operationally:** the HTTP fallback flow (a client posting to `set-alert-rules` without `sensitivity`) is *legal today* and produces correct behavior because `?? "all"` matches the prior default. After the change, the same call must continue to produce correct behavior — preserving the existing row's sensitivity rather than silently rewriting it. The optional-field flow handles this; a blind constant flip would not.

### 1d. New atomic internal mutation: `setNotificationConfigForUser`

The current settings flow saves delivery mode and sensitivity via TWO separate REST calls (`saveDigestSettings` + `saveAlertRules`, see `notifications-settings.ts:454,510,533`). After §1b lands, this two-call sequence creates a server-side error for the legitimate user flow `daily + all → realtime`:

1. UI calls `setDigestSettings({digestMode: 'realtime'})` first.
2. Server fetches existing row → `sensitivity: 'all'`. `assertCompatibleDeliveryMode({realtime, all})` → throws `INCOMPATIBLE_DELIVERY`.

The fix is **a single atomic internal mutation** that takes both fields, called via the existing HTTP-action transport pattern (matches existing `setAlertRulesForUser` shape):

```ts
// convex/alertRules.ts
export const setNotificationConfigForUser = internalMutation({
  args: {
    userId: v.string(),
    variant: v.string(),
    // All optional — caller passes only the fields it wants to change.
    enabled: v.optional(v.boolean()),
    eventTypes: v.optional(v.array(v.string())),
    sensitivity: v.optional(sensitivityValidator),
    channels: v.optional(v.array(channelTypeValidator)),
    aiDigestEnabled: v.optional(v.boolean()),
    digestMode: v.optional(digestModeValidator),
    digestHour: v.optional(v.number()),
    digestTimezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, variant } = args;
    const existing = await ctx.db.query("alertRules")
      .withIndex("by_user_variant", q => q.eq("userId", userId).eq("variant", variant))
      .unique();
    const pair = resolveEffectivePair({
      incomingDigestMode: args.digestMode,
      incomingSensitivity: args.sensitivity,
      existing,
    });
    assertCompatibleDeliveryMode(pair);
    // ...validate digestHour (0–23 int), digestTimezone (Intl.DateTimeFormat), then patch-or-insert with full pair...
  },
});
```

Internal-only (matches existing pattern: HTTP action → `internal.alertRules.*`). No public Convex mutation needed because no client uses the Convex browser SDK for these surfaces — everything goes through the REST proxy in §1f.

The UI's mode-change save flow routes through this new mutation via the new HTTP action `set-notification-config`. The legacy `setAlertRules`/`setDigestSettings` mutations and their HTTP actions remain for single-field updates (alert-rules toggle, quiet-hours, etc.) — they keep the validation; they just can't be used for pair-flip transitions.

### 1f. Transport plumbing — 4 sites for the new HTTP action

The UI doesn't call Convex mutations directly. The transport chain for any settings save is:

```
notifications-settings.ts UI
   ↓
src/services/notification-channels.ts (client wrapper)
   ↓
POST /api/notification-channels (Vercel)
   ↓
api/notification-channels.ts (forwards via convexRelay → convex.site)
   ↓
convex/http.ts HTTP action (validates body, runs internal mutation)
   ↓
convex/alertRules.ts internal mutation
```

For `setNotificationConfigForUser` to be reachable from the UI, the same chain must exist for the new action. **4 sites in lockstep**:

1. **`convex/alertRules.ts`** — the internal mutation defined in §1d.
2. **`convex/http.ts`** — new branch added below the existing `set-digest-settings` block (around line 547):
   ```ts
   if (action === "set-notification-config") {
     const VALID_SENSITIVITY = new Set(["all", "high", "critical"]);
     const VALID_DIGEST_MODE = new Set(["realtime", "daily", "twice_daily", "weekly"]);
     if (typeof body.variant !== "string" || !body.variant) {
       return new Response(JSON.stringify({ error: "MISSING_VARIANT" }), { status: 400, headers: { "Content-Type": "application/json" } });
     }
     if (body.sensitivity !== undefined && !VALID_SENSITIVITY.has(body.sensitivity)) {
       return new Response(JSON.stringify({ error: "INVALID_SENSITIVITY" }), { status: 400, headers: { "Content-Type": "application/json" } });
     }
     if (body.digestMode !== undefined && !VALID_DIGEST_MODE.has(body.digestMode)) {
       return new Response(JSON.stringify({ error: "INVALID_DIGEST_MODE" }), { status: 400, headers: { "Content-Type": "application/json" } });
     }
     try {
       await ctx.runMutation((internal as any).alertRules.setNotificationConfigForUser, {
         userId,
         variant: body.variant,
         enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
         eventTypes: Array.isArray(body.eventTypes) ? body.eventTypes : undefined,
         sensitivity: body.sensitivity,
         channels: Array.isArray(body.channels) ? body.channels : undefined,
         aiDigestEnabled: typeof body.aiDigestEnabled === "boolean" ? body.aiDigestEnabled : undefined,
         digestMode: body.digestMode,
         digestHour: typeof body.digestHour === "number" ? body.digestHour : undefined,
         digestTimezone: typeof body.digestTimezone === "string" ? body.digestTimezone : undefined,
       });
     } catch (err: unknown) {
       // Surface ConvexError code/message so the API path can pass through 400 with a real reason
       // instead of swallowing it as a generic 500. INCOMPATIBLE_DELIVERY in particular needs to
       // reach the client so the UI can render the helper text.
       const data = (err as { data?: { code?: string; message?: string } } | undefined)?.data;
       if (data?.code === "INCOMPATIBLE_DELIVERY") {
         return new Response(JSON.stringify({ error: data.code, message: data.message }), { status: 400, headers: { "Content-Type": "application/json" } });
       }
       throw err;
     }
     return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
   }
   ```

3. **`api/notification-channels.ts`** — new branch added below the existing `set-digest-settings` block (around line 412):
   ```ts
   if (action === 'set-notification-config') {
     const { variant, enabled, eventTypes, sensitivity, channels, aiDigestEnabled, digestMode, digestHour, digestTimezone } = body;
     if (!variant) return json({ error: 'variant required' }, 400, corsHeaders);
     const resp = await convexRelay({
       action: 'set-notification-config',
       userId: session.userId,
       variant, enabled, eventTypes, sensitivity, channels, aiDigestEnabled,
       digestMode, digestHour, digestTimezone,
     });
     if (!resp.ok) {
       // Pass through 400 + body so the UI sees INCOMPATIBLE_DELIVERY instead of generic 500.
       // Existing `set-alert-rules`/`set-digest-settings` branches can't surface this because
       // their server validation is type-only; this branch must do better.
       const errBody = await resp.text().catch(() => '');
       const status = resp.status === 400 ? 400 : 500;
       const errorPayload = errBody ? safeParseJson(errBody) ?? { error: 'Operation failed' } : { error: 'Operation failed' };
       return json(errorPayload, status, corsHeaders);
     }
     return json({ ok: true }, 200, corsHeaders);
   }
   ```
   (`safeParseJson` is a small helper to avoid throwing on non-JSON error bodies.)

4. **`src/services/notification-channels.ts`** — new client wrapper:
   ```ts
   export async function setNotificationConfig(args: {
     variant: string;
     enabled?: boolean;
     eventTypes?: string[];
     sensitivity?: 'all' | 'high' | 'critical';
     channels?: ChannelType[];
     aiDigestEnabled?: boolean;
     digestMode?: DigestMode;
     digestHour?: number;
     digestTimezone?: string;
   }): Promise<void> {
     const res = await authFetch('/api/notification-channels', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ action: 'set-notification-config', ...args }),
     });
     if (!res.ok) {
       const body = await res.json().catch(() => ({}));
       if (body?.error === 'INCOMPATIBLE_DELIVERY') {
         throw new IncompatibleDeliveryError(body.message ?? 'Real-time delivery requires High or Critical sensitivity.');
       }
       throw new Error(`set notification config: ${res.status}`);
     }
   }
   export class IncompatibleDeliveryError extends Error { constructor(m: string) { super(m); this.name = 'IncompatibleDeliveryError'; } }
   ```
   The dedicated error type lets the UI catch it specifically and surface the helper text without leaking generic "Operation failed" copy.

The transport landscape after PR 1: legacy `set-alert-rules`/`set-digest-settings`/`set-quiet-hours` actions remain unchanged (they keep the new validators). The new `set-notification-config` action is the *only* path used for any UI flow that may flip the (digestMode, sensitivity) pair.

### 1e. Tests (`convex/alertRules.test.ts` or equivalent)

Behavior tests:

- `setAlertRules({sensitivity: "all"})` against existing `{digestMode: "realtime"}` → throws `INCOMPATIBLE_DELIVERY`.
- `setAlertRules({sensitivity: "all"})` against existing `{digestMode: "daily"}` → succeeds.
- `setDigestSettings({digestMode: "realtime"})` against existing `{sensitivity: "all"}` → throws.
- `setDigestSettings({digestMode: "daily"})` against existing `{sensitivity: "all"}` → succeeds, leaves `sensitivity: "all"` intact.
- `setQuietHours({...})` with NO existing row → inserts row with `sensitivity: "high"` (not `"all"`), `digestMode` absent (effective realtime), invariant holds.
- `setQuietHoursForUser({...})` same as above for internal path.
- `setNotificationConfigForUser({digestMode: "realtime", sensitivity: "all"})` → throws (atomic rejection).
- `setNotificationConfigForUser({digestMode: "realtime", sensitivity: "high"})` against existing `{digestMode: "daily", sensitivity: "all"}` → succeeds, both fields land atomically.
- **Partial-update re-validation test** (Codex round 3 #2 — corrected target): `setNotificationConfigForUser({enabled: true})` against existing forbidden row `{digestMode: "realtime", sensitivity: "all", enabled: false}` → throws `INCOMPATIBLE_DELIVERY` (because `resolveEffectivePair` derives the pair from `existing` and the validator runs on every patch path, even when the caller only flipped `enabled`). This is the right test target because `setNotificationConfigForUser` is the partial-update mutation by design — `setAlertRules`/`setAlertRulesForUser` require the full field set, so an "enable-only" call doesn't exist on those surfaces.
- HTTP-action contract test (`tests/notification-channels-http.test.*`): POST `/api/notification-channels` with `action: 'set-notification-config'`, body `{digestMode: 'realtime', sensitivity: 'all', variant: 'full'}` → response 400 with body `{error: 'INCOMPATIBLE_DELIVERY', message: ...}`. Confirms error passthrough end-to-end.
- **Insert-only-default test** (covers Codex round 3 #1 — patch-vs-insert correctness):
  - HTTP `set-alert-rules` POST with `sensitivity` omitted, no existing row → row inserted with `sensitivity: 'high'`.
  - HTTP `set-alert-rules` POST with `sensitivity` omitted, existing row `{digestMode: 'daily', sensitivity: 'all'}` → row patched WITHOUT touching `sensitivity` (still `'all'`). Critical: this proves the omitted-field flow does NOT silently narrow existing digest users.
  - Same as above but existing row `{digestMode: 'realtime', sensitivity: 'high'}` (compatible) → patch succeeds, `sensitivity` unchanged.

## 2. Settings UI (`src/services/notifications-settings.ts`)

### 2a. Layout fix — sensitivity must escape `usRealtimeSection`

Today the `Sensitivity` block (lines 311–316) is nested inside `<div id="usRealtimeSection">` (line 299), which gets `display: none` when delivery mode is not realtime (line 479). That means a digest-mode user **can't see or change sensitivity** — yet the rule allows them to keep `sensitivity: "all"` in digest mode (and in fact requires that surface to exist for a daily-digest user who genuinely wants every event).

**Restructure** the layout (HTML at line 291 and onward): pull the SENSITIVITY label + `<select id="usNotifSensitivity">` OUT of `usRealtimeSection` and place it as a top-level row that's visible regardless of delivery mode. The "Enable notifications" toggle and Quiet Hours block stay inside `usRealtimeSection` (Quiet Hours has no semantic in digest mode anyway).

After the move, the sensitivity dropdown is always visible. The `all` option's enabled/disabled state depends on the current delivery mode value, which leads into:

### 2b. Disable `all` option when delivery mode is realtime

In the render path:

```ts
const isRealtime = !DIGEST_CRON_ENABLED || digestMode === 'realtime';
// ...
<select id="usNotifSensitivity">
  <option value="all" ${isRealtime ? 'disabled' : ''}${sensitivity === 'all' && !isRealtime ? ' selected' : ''}>
    All events${isRealtime ? ' (digest only)' : ''}
  </option>
  <option value="high" ...>High &amp; critical</option>
  <option value="critical" ...>Critical only</option>
</select>
<div class="ai-flow-toggle-desc">Real-time delivery requires High or Critical. To receive all events, switch to a digest cadence.</div>
```

### 2c. Mode-change live behavior

Extend the `usDigestMode` change listener at line 475:

- When user switches TO realtime: if `usNotifSensitivity` is currently `all`, snap it to `high` and surface a one-line toast: *"Switched to High & critical — real-time delivery doesn't support All events."*
- When user switches AWAY from realtime: re-enable the `all` option (no auto-flip — let the user choose).

### 2d. Save-handler atomicity (the `daily+all → realtime` save trap)

Today the change listener at line 475 calls `saveDigestSettings()` immediately on dropdown change. With §1b validators in place, switching from `daily+all` to `realtime` would call `setDigestSettings({digestMode: 'realtime'})` against an existing row with `sensitivity: 'all'` and **throw**.

The fix in §2c (snap `usNotifSensitivity` to `high` IN THE DOM before save) makes the *visible* state safe, but the save call still hits the server with only `digestMode` — the server only sees `existing.sensitivity = 'all'`.

Solution: route the mode-change save through the new client wrapper `setNotificationConfig` (§1f) instead of `setDigestSettings`, passing BOTH the new `digestMode` and the (snapped) `sensitivity`. Atomic on the server, race-free.

Update save paths in `notifications-settings.ts`:

- Line 405 (alert-rules save) — keep `saveAlertRules` (single-field update is fine in isolation, server validator catches any inconsistency).
- Line 454 (digest-mode change) — switch to `setNotificationConfig` and pass both `digestMode` and the current sensitivity (snapped to `high` if was `all`).
- Lines 510/533 (quiet-hours saves) — keep `setQuietHours` (these don't touch the pair).
- Add a UI-side `try/catch (IncompatibleDeliveryError)` around the `setNotificationConfig` call to render the helper-text inline as a toast, in case server validation triggers despite client-side prevention.

### 2e. UI tests (Playwright)

- Open settings with existing `{digestMode: 'realtime', sensitivity: 'high'}`. Sensitivity is visible. Change delivery mode to `daily` → `all` becomes enabled.
- Same start. Try to select `all` while realtime → option disabled.
- Open settings with `{digestMode: 'daily', sensitivity: 'all'}`. Sensitivity is visible (regression test for §2a). Change delivery mode to `realtime` → sensitivity snaps to `high`, toast appears, single atomic save succeeds (no server error).
- Open settings with `{digestMode: 'realtime', sensitivity: 'high'}` and explicitly try a manual two-step (change sensitivity to `all`, save, change delivery to `daily`, save) → first save rejects with the helper-text error.

## 3. Relay coerce-at-read (`scripts/notification-relay.cjs`)

`shouldNotify` at line 622 reads `rule.sensitivity` **twice**: once in `matchesSensitivity` at line 623, and once in the importance-score threshold lookup at lines 630–632. Codex correctly flagged that wrapping only one read leaves the threshold path consulting the unnormalized `'all'` value, which silently uses the looser `IMPORTANCE_SCORE_MIN` floor — defeating half the defense.

**Normalize once at function entry**:

```js
function shouldNotify(rule, event) {
  // Coerce (effective realtime + 'all') → 'high' for both legacy match and importance threshold.
  // Defense in depth — the schema-mutation validators (convex/alertRules.ts) and the migration
  // make this state unreachable for new traffic; this catches in-flight rows during migration
  // and any tooling that bypasses the validators. See plans/forbid-realtime-all-events.md §3.
  const effectiveDigestMode = rule.digestMode ?? 'realtime';
  const effectiveSensitivity =
    effectiveDigestMode === 'realtime' && rule.sensitivity === 'all' ? 'high' : rule.sensitivity;

  const passesLegacy = matchesSensitivity(effectiveSensitivity, event.severity ?? 'high');
  if (!passesLegacy) return false;

  if (process.env.IMPORTANCE_SCORE_LIVE === '1' && event.payload?.importanceScore != null) {
    const threshold = effectiveSensitivity === 'critical' ? 82
                    : effectiveSensitivity === 'high' ? 69
                    : IMPORTANCE_SCORE_MIN;
    return event.payload.importanceScore >= threshold;
  }
  return true;
}
```

Both reads now use the same normalized value. Silent (no log spam) — pure read-time normalization.

**Test** (`tests/notification-relay-effective-sensitivity.test.mjs`):

- Rule `{digestMode: 'realtime', sensitivity: 'all'}`, event `{severity: 'low'}` → `shouldNotify` returns false (legacy match path coerced).
- Same rule, `IMPORTANCE_SCORE_LIVE=1`, event `{severity: 'high', importanceScore: 50}` → returns false (threshold path also coerced; 50 < 69).
- Same rule, event `{severity: 'high', importanceScore: 80}` → returns true.
- Rule `{digestMode: undefined, sensitivity: 'all'}` (silent third case) treated identically to `'realtime'`.
- Rule `{digestMode: 'daily', sensitivity: 'all'}` left as-is (digest path, no coercion).

## 4. Backfill migration

### 4a. Discovery query — paginated, ALL rows, not just enabled

Two reasons the prior `.collect()` approach is wrong:

- **Disabled rows must be covered** (Codex round 1 #5): rows with `enabled: false` can be flipped to `enabled: true` later via partial update, and §1 validators will reject that flip on a forbidden row — but only if the pre-existing row in the bad state has been migrated. Filtering on `enabled: true` misses this case.
- **Convex `.collect()` has scale limits** (Codex round 3 #3): `.collect()` reads all matching docs into memory and is bounded by Convex's per-query result limit (16MB / soft ~16k docs). The `alertRules` table grows with the user base; even at current scale we should not pre-commit to an unscalable shape.

**Execution-path note** — `internalQuery`/`internalMutation` functions are NOT callable from `ConvexHttpClient` (they're only callable from other Convex functions). The codebase's existing `scripts/notification-relay.cjs:243` even carries a comment confirming this constraint, and uses public `query`/`mutation` for HTTP-client calls. For one-off migration work, the canonical pattern is **temporary public functions gated by an admin secret**, called via `ConvexHttpClient.query()` / `.mutation()` (NOT `.action()` — wrong method for query/mutation types). After the migration completes, the functions are removed in a follow-up cleanup PR.

The admin secret is set as a Convex env var (`MIGRATION_ADMIN_SECRET`) via `npx convex env set`, and the driver script reads it from a local env var. Functions throw if the secret doesn't match.

**Discovery (counts only, paginated, admin-gated public query):**

```ts
// convex/alertRules.ts — TEMP MIGRATION FUNCTION, remove after migration completes
export const _countRealtimeAllRules = query({
  args: { cursor: v.union(v.string(), v.null()), adminSecret: v.string() },
  handler: async (ctx, args) => {
    if (args.adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
      throw new ConvexError("UNAUTHORIZED");
    }
    const page = await ctx.db.query("alertRules").paginate({ numItems: 500, cursor: args.cursor });
    let matched = 0;
    let enabledMatched = 0;
    const variantCounts: Record<string, number> = {};
    const sample: { _id: string; userId: string; variant: string }[] = [];
    for (const r of page.page) {
      if ((!r.digestMode || r.digestMode === "realtime") && r.sensitivity === "all") {
        matched++;
        if (r.enabled) enabledMatched++;
        variantCounts[r.variant] = (variantCounts[r.variant] ?? 0) + 1;
        if (sample.length < 5) sample.push({ _id: r._id, userId: r.userId, variant: r.variant });
      }
    }
    return { matched, enabledMatched, variantCounts, sample, isDone: page.isDone, nextCursor: page.continueCursor };
  },
});
```

**Driver script** (`scripts/migrate-discover-realtime-all.mjs`):

```js
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const adminSecret = process.env.MIGRATION_ADMIN_SECRET;
if (!adminSecret) { console.error("MIGRATION_ADMIN_SECRET not set"); process.exit(1); }

let cursor = null;
const totals = { matched: 0, enabledMatched: 0, variantCounts: {}, samples: [] };
do {
  // Use ConvexHttpClient.query() — NOT .action(); _countRealtimeAllRules is a query, not an action.
  const r = await c.query(api.alertRules._countRealtimeAllRules, { cursor, adminSecret });
  totals.matched += r.matched;
  totals.enabledMatched += r.enabledMatched;
  for (const [k, v] of Object.entries(r.variantCounts)) totals.variantCounts[k] = (totals.variantCounts[k] ?? 0) + v;
  if (totals.samples.length < 20) totals.samples.push(...r.sample.slice(0, 20 - totals.samples.length));
  cursor = r.isDone ? null : r.nextCursor;
} while (cursor);
console.log(JSON.stringify(totals, null, 2));
```

The driver loops until `isDone`. Each `_countRealtimeAllRules` call processes at most 500 docs and returns counts plus a tiny sample — well within result limits. Total time is `ceil(N / 500)` round-trips.

For the email-channel subset (users-with-verified-email count), run a separate paginated query joining `notificationChannels`, OR sample from the `samples` array post-discovery and check channels for each sample userId. Don't try to do the join inside one paginated mutation — keep each function call O(page).

### 4b. Migration mutation — paginated, idempotent, batched, admin-gated public mutation

```ts
// convex/alertRules.ts — TEMP MIGRATION FUNCTION, remove after migration completes
export const _migrateRealtimeAllPage = mutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    pageSize: v.number(),
    dryRun: v.boolean(),
    defaultDigestHour: v.number(),
    defaultDigestTimezone: v.string(),
    adminSecret: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
      throw new ConvexError("UNAUTHORIZED");
    }
    const page = await ctx.db.query("alertRules").paginate({ numItems: args.pageSize, cursor: args.cursor });
    const now = Date.now();
    let migrated = 0;
    for (const r of page.page) {
      const isForbidden = (!r.digestMode || r.digestMode === "realtime") && r.sensitivity === "all";
      if (!isForbidden) continue; // idempotent: already-migrated rows are skipped
      if (args.dryRun) { migrated++; continue; }
      await ctx.db.patch(r._id, {
        digestMode: "daily",
        digestHour: r.digestHour ?? args.defaultDigestHour,
        digestTimezone: r.digestTimezone ?? args.defaultDigestTimezone,
        updatedAt: now,
      });
      migrated++;
    }
    return { migrated, isDone: page.isDone, nextCursor: page.continueCursor };
  },
});
```

**Idempotency**: each page filters to "still in forbidden state" before patching. Re-running the migration after partial completion — or after new forbidden rows somehow appearing post-§1 — is safe; already-migrated rows match `digestMode: "daily"` and are skipped. The migration carries no separate "migrated" marker because the filter IS the marker.

**Driver script** (`scripts/migrate-realtime-all-to-daily.mjs`):

```js
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const adminSecret = process.env.MIGRATION_ADMIN_SECRET;
if (!adminSecret) { console.error("MIGRATION_ADMIN_SECRET not set"); process.exit(1); }

const dryRun = process.argv.includes("--dry-run");
const PAGE_SIZE = 200;
let cursor = null, total = 0, pages = 0;
const t0 = Date.now();
do {
  // ConvexHttpClient.mutation() — NOT .action(); _migrateRealtimeAllPage is a mutation.
  const r = await c.mutation(api.alertRules._migrateRealtimeAllPage, {
    cursor, pageSize: PAGE_SIZE, dryRun,
    defaultDigestHour: 8, defaultDigestTimezone: "UTC",
    adminSecret,
  });
  total += r.migrated;
  pages++;
  console.log(`[migrate] page ${pages}: migrated=${r.migrated}, total=${total}, isDone=${r.isDone}`);
  cursor = r.isDone ? null : r.nextCursor;
} while (cursor);
console.log(`[migrate] DONE: ${dryRun ? "[DRY-RUN] would migrate" : "migrated"} ${total} rows in ${pages} pages, ${(Date.now()-t0)/1000}s`);
```

`PAGE_SIZE = 200` keeps each Convex mutation under the per-call write budget (Convex limits writes per transaction; 200 is a safe headroom for `db.patch` calls). If write budget becomes a concern at higher row counts, drop to 100.

**Migration choice** — flip `digestMode` to `daily`, NOT narrow `sensitivity`:

- The user expressed intent "I want all events." Demoting `sensitivity` silently strips events; they'd notice as a regression.
- Demoting `digestMode` to `daily` keeps the same event set, batched.

### 4c. Run order

1. **Set the admin secret** (one-time): generate a random 32+ char value, then `npx convex env set MIGRATION_ADMIN_SECRET <value>` (sets in production deployment) and locally `export MIGRATION_ADMIN_SECRET=<value>` so the driver script can pass it in.
2. **Deploy PR 1** (server + transport + UI + relay coerce + migration functions — they're inert until called with the secret, see Order of Operations). Closes the door on new rows entering the state.
3. **Run discovery**: `node scripts/migrate-discover-realtime-all.mjs`. Eyeball totals (matched, enabledMatched, variant distribution, samples). Post in PR 2 description.
4. **Run dry-run migration**: `node scripts/migrate-realtime-all-to-daily.mjs --dry-run`. Confirm count matches discovery.
5. **Run live migration**: `node scripts/migrate-realtime-all-to-daily.mjs`. Verify by re-running discovery — should return `matched: 0`.
6. **Send §4d courtesy email** same day, AFTER step 5 completes.
7. **Cleanup PR** (PR 2 follow-up): remove `_countRealtimeAllRules` and `_migrateRealtimeAllPage` and the driver scripts. **Rotate the secret**: `npx convex env remove MIGRATION_ADMIN_SECRET`. Treat the prior value as exposed (Convex dashboard function-call history retains it in args logs) — do not reuse it for any other admin path. The migration functions exist as a temporary admin surface and should not remain in the codebase post-migration.

### 4d. Courtesy email — to migrated users only

One-time transactional send to `userId`s in the migrated set who have a verified email channel. Subject: *"We changed your WorldMonitor delivery to a daily digest"*.

> **Why you got this email.** You had real-time alerts enabled with sensitivity set to "All events." That combination produced more notifications than anyone wants — for some users, dozens per hour during busy news days.
>
> **What we changed.** We switched your delivery to a **daily digest**, sent once a day at 8 AM in your timezone. You still receive every event you'd been receiving — just batched into one email instead of one-per-event.
>
> **Want real-time alerts back?** Open Settings → Notifications. Real-time delivery now requires sensitivity set to "High & critical" or "Critical only." This protects you from the noise that comes with watching every event.
>
> **Want digest at a different hour, or twice-daily?** Same place — Settings → Notifications.
>
> Sorry for the inconvenience. We'd rather over-correct than continue training your inbox to hit "Mark as spam."
>
> — Elie, WorldMonitor

## 5. Onboarding / tooltip copy

Render a permanent helper line under the SENSITIVITY label (not a tooltip — invisible on mobile):

> *Real-time delivery requires High or Critical. To receive all events, switch to a digest cadence.*

This was already covered as part of §2b but is called out separately so reviewers can verify the copy matches the courtesy email (§4d) and the server error message (§1b). All three should agree on the wording "Real-time delivery requires High or Critical" — divergence here causes user confusion when they hit the constraint from different surfaces.

---

## Out of scope (tracked separately)

- **Slot A — per-recipient hourly rate cap** at `notification-relay.cjs:899`. Generic burst-airbag for any future bursty publisher.
- **Slot B — event-family coalesce** in `checkDedup` at `notification-relay.cjs:56`. The proper fix for "4 NWS thunderstorm warnings for adjacent zones in 3 minutes" — these are genuine `high`-severity events; the coalesce key is the NWS parent ID / VTEC code.
- **Critical-tier severity audit**. Are we marking events `critical` consistently? A user on `critical only` should never feel they're missing important things. Separate pass.
- **Future HTTP/admin write surfaces**. The current write surfaces (`api/notification-channels.ts` for the UI, plus the Convex internal mutations called by HTTP actions) are all covered by §1 + §1f. Any future endpoint that writes `alertRules` rows must route through `setNotificationConfigForUser` or one of the existing internal mutations — that's the contract, but no out-of-tree path exists today.

## Implementation gotchas

These are pre-flagged by review and easy to miss during implementation:

- **Keep `sensitivity` out of the patch object when omitted.** Per §1c, patch logic must conditionally include the field — `if (args.sensitivity !== undefined) patch.sensitivity = args.sensitivity` — never `patch.sensitivity = args.sensitivity ?? "high"`. The blind-fallback form silently narrows existing digest users from `daily+all` to `daily+high` whenever a caller omits the field. Apply this discipline at every patch site, not just the obvious ones.
- **Confirm the temp migration functions and driver scripts are actually removed.** PR 2 must include the deletion in the same commit as the migration execution. Add a note to PR 2's checklist: "removed `_countRealtimeAllRules`, `_migrateRealtimeAllPage`, `scripts/migrate-discover-realtime-all.mjs`, `scripts/migrate-realtime-all-to-daily.mjs`" + "ran `npx convex env remove MIGRATION_ADMIN_SECRET`". Without this discipline the temp admin surface lingers as dead code with a live secret.
- **Never log `MIGRATION_ADMIN_SECRET`.** The driver script reads it from env and passes it as an argument; do NOT log the args object on error. ConvexError messages thrown by the migration functions must not echo the secret. Code review checklist item: grep the driver scripts and the migration functions for any `console.log` / `JSON.stringify` of the args object that includes `adminSecret`.
- **Convex dashboard logs ALL function arguments.** Even though the driver scripts and our own logging never echo `adminSecret`, the Convex platform itself logs every public-function call with its full args payload to the dashboard's function-call history. Anyone with dashboard access sees the secret in plaintext for the lifetime of the temp functions. Mitigations: (a) keep the temp functions in main for as little time as possible — PR 2 removes them in the same commit as the migration run, (b) **rotate the secret to a fresh random value as soon as the migration completes and the temp functions are deleted** (`npx convex env remove MIGRATION_ADMIN_SECRET` is sufficient if the secret was generated for one-time use; if any other system reused it, regenerate first), (c) treat the secret as exposed if the team has wider dashboard access — i.e. a one-time use OK, do not reuse for any other purpose. Greptile P2-security on PR #3461.

## Risk register

- **Migration deletes user-perceived value.** Mitigation: §4 chooses `daily` digest over narrowing sensitivity, preserving event-set intent.
- **UI snap-to-`high` surprises a power user mid-edit.** Mitigation: toast + same-screen ability to switch back to digest.
- **Convex `INCOMPATIBLE_DELIVERY` reaches a client without UI handling.** Mitigation: §2 uses the atomic mutation `setNotificationConfig`, plus §2c snaps before save. Server error is a belt for tooling/scripts.
- **Existing tests asserting `(realtime, all)` works.** Mitigation: grep `tests/` for the combination during PR — those tests codify the foot-gun and need updating.
- **`setNotificationConfig` introduces a parallel surface that drifts from `setAlertRules` + `setDigestSettings`.** Mitigation: the new mutation routes its insert/patch logic through the same `resolveEffectivePair` / `assertCompatibleDeliveryMode` helpers, so behavior stays in lockstep. Tests cover the atomic flow specifically.
- **Disabled forbidden rows reactivated post-migration.** Mitigation: the migration covers ALL rows regardless of `enabled` (§4a), AND the validator re-checks the pair on any patch including `enabled` flips (§1e test).

## Order of operations

The constraint is cross-cutting (server validators, HTTP transport, UI render/save flow, relay coerce). Splitting server from UI creates an error window where the legacy UI hits server errors for legitimate `daily+all → realtime` flips, surfacing as a confusing generic "Operation failed" toast. To avoid that, **PR 1 bundles all user-facing surfaces atomically**.

1. **PR 1 (atomic — server + transport + UI + relay)**: §1 (helpers, validation at every writer, insert-only default flip, new `setNotificationConfigForUser`) + §1f (4-site transport plumbing for the new HTTP action with error-passthrough) + §2 (UI restructure: sensitivity escapes realtime section, mode-change uses new wrapper, snap-to-`high` toast) + §3 (relay coerce) + §5 (copy) + the temp migration functions from §4a/§4b (admin-secret-gated; inert until called with the secret) + tests for all of the above. No error window for users; UI and server land in lockstep.
2. Run discovery + dry-run migration. Eyeball count + enabled split + variant distribution + email-channel subset, post in PR 2 description.
3. **PR 2 (data migration execution + email + cleanup)**: run live migration via the driver script + send courtesy email + REMOVE the temp migration functions and driver scripts in the same PR (cleanup-on-execution avoids them lingering in the codebase as dead admin surface).
4. Run migration. Send §4d email same day, AFTER migration completes. Land PR 2 cleanup commit. Remove the Convex env var.

PR 1 is bigger but atomic. PR 2 is a one-shot data operation with dry-run. Each PR independently revertible (PR 2 in particular is reversible by re-running with the inverse mapping, since `digestMode: 'realtime'` + `sensitivity: 'all'` is unambiguously the prior state). The relay coerce in PR 1 doubles as the safety net during PR 2's brief migration-execution window.

**Why not split PR 1 further?** Two reasonable variants were considered:

- *Split A: server-only PR then UI PR.* Creates the daily+all→realtime error window for any user who hits settings between deploys. Rejected.
- *Split B: transport-additive PR then validation+UI PR.* Cleaner but the "additive transport with no enforcement" PR has no observable behavior to test against, making review harder. Rejected.

Chosen approach prioritizes atomicity over PR size.
