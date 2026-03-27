---
title: "fix(intelligence): address P1/P2 code review findings from analytical frameworks PR #2380"
type: fix
status: active
date: 2026-03-27
origin: docs/plans/2026-03-27-001-feat-intelligence-analytical-frameworks-plan.md
---

# fix(intelligence): analytical frameworks review follow-up

Fixes all 5 P1 (security-critical) findings and 7 P2 (correctness/quality) findings
identified by 7-agent code review of PR #2380. Plus P3 cleanup. New branch off
`origin/main` — references `todos/041` through `todos/057`.

## Overview

PR #2380 shipped the analytical framework selector feature. A post-merge code review
found two cache-poisoning bugs, a missing server-side premium gate, an SSRF bypass,
and missing prompt sanitization — all blocking merge. Additionally there are several
P2 correctness bugs: a broken InsightsPanel re-render, a conflicting injection path
in DeductionPanel, and missing debounce on country-brief re-fetch.

## Implementation Units

### Unit 1 — Cache key fixes (todos 041, 045) `[P1]`

**Files:** `server/worldmonitor/intelligence/v1/deduct-situation.ts`,
`server/worldmonitor/news/v1/summarize-article.ts`,
`server/worldmonitor/news/v1/_shared.ts` (via `src/utils/summary-cache-key.ts`)

**Patterns to follow:** `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:37-40`
(the reference implementation that already does this correctly).

**deduct-situation.ts fix:**
```ts
// After extracting frameworkRaw (already done):
const frameworkHash = frameworkRaw ? (await sha256Hex(frameworkRaw)).slice(0, 8) : '';
// Modify cache key (currently line 29):
const cacheKey = `deduct:situation:v2:${queryHash}${frameworkHash ? ':fw' + frameworkHash : ''}`;
```

**summarize-article.ts fix:**
`getCacheKey(headlines, mode, sanitizedGeoContext, variant, lang)` is imported from
`src/utils/summary-cache-key.ts`. The `systemAppend` is NOT currently in the signature.
Options:

- Extend `buildSummaryCacheKey` to accept an optional `systemAppend` param,
  append `':fw' + hashString(systemAppend).toString(16).slice(0, 8)` when non-empty.
- OR: compute the suffix inline and append to the result of `getCacheKey(...)` before
  storing in Redis, like `get-country-intel-brief.ts` does.

Use `hashString` (sync FNV-1a from `server/_shared/hash.ts`) for `systemAppend` since
it's already truncated to 2000 chars and collision resistance is not needed for a
suffix appended to an already-SHA256-keyed string.

**Verification:** Two requests with same `headlines` but different `systemAppend` must
produce different Redis keys.

**Execution note:** test-first — add test case to `tests/summary-cache-key.test.mts`
(or create) asserting that `buildSummaryCacheKey` with `systemAppend` != without it.

---

### Unit 2 — Server-side premium gate (todo 042) `[P1]`

**Files:** `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts`,
`server/worldmonitor/intelligence/v1/deduct-situation.ts`,
`server/worldmonitor/news/v1/summarize-article.ts`

**Gateway architecture context:** `src/shared/premium-paths.ts` gates entire routes.
The intelligence/news routes are NOT in `PREMIUM_RPC_PATHS` (they're semi-public).
Framework enhancement is a PRO-only field within an otherwise public endpoint.

**Pattern:** Read `Authorization` header from `ctx.request`, call
`validateBearerToken(token)` from `server/auth-session.ts`, check `role === 'pro'`.
For API-key-authenticated callers, use `validateApiKey(ctx.request, {}).valid`.

```ts
import { validateBearerToken } from '../../../auth-session.js';
import { validateApiKey } from '../../../auth-key.js'; // confirm import path

async function isCallerPremium(ctx: ServerContext): Promise<boolean> {
  // Check API key first (most common premium path)
  const keyCheck = validateApiKey(ctx.request, {});
  if (keyCheck.valid) return true;
  // Fall back to Bearer token
  const authHeader = ctx.request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const session = await validateBearerToken(authHeader.slice(7));
    return session.valid && session.role === 'pro';
  }
  return false;
}
```

Then in each handler:
```ts
const frameworkRaw = (await isCallerPremium(ctx)) && typeof req.framework === 'string'
  ? req.framework.slice(0, 2000)
  : '';
```

**Note:** `validateApiKey` is synchronous; wrap to avoid unnecessary async ops.
Confirm the import path for `validateApiKey` — check `server/auth-key.ts` or
`server/gateway.ts` for where it's defined.

**Verification:** Request with `framework: 'test'` + no auth → framework ignored in
LLM call. Request with valid PRO API key + `framework: 'test'` → framework applied.

---

### Unit 3 — SSRF fix in fetch-agentskills.ts (todo 043) `[P1]`

**File:** `api/skills/fetch-agentskills.ts`

**Current code (lines 42-46):**
```ts
const h = skillUrl.hostname;
if (h !== 'agentskills.io' && !h.endsWith('.agentskills.io')) {
  return Response.json({ error: 'Only agentskills.io URLs are supported.' }, { status: 400 });
}
```

**Problem:** `evil.agentskills.io` passes `endsWith('.agentskills.io')`. The attacker
registers `evil.agentskills.io` and points it to `169.254.169.254` or an internal host.

**Constraint:** Vercel edge functions CANNOT use `node:dns` — full DNS pinning is not
feasible. Best available defense: exact allowlist + block redirects.

**Fix:**
```ts
const ALLOWED_AGENTSKILLS_HOSTS = new Set([
  'agentskills.io',
  'www.agentskills.io',
  'api.agentskills.io',
]);

if (!ALLOWED_AGENTSKILLS_HOSTS.has(skillUrl.hostname)) {
  return Response.json(
    { error: 'Only agentskills.io URLs are supported.' },
    { status: 400, headers: corsHeaders }
  );
}

// Fetch with redirect:manual to prevent redirect to internal hosts
const skillResp = await fetch(skillUrl.toString(), {
  redirect: 'manual',
  signal: AbortSignal.timeout(8_000),
});
if (skillResp.status >= 300 && skillResp.status < 400) {
  return Response.json(
    { error: 'Redirects are not allowed.' },
    { status: 400, headers: corsHeaders }
  );
}
if (!skillResp.ok) {
  return Response.json(
    { error: `Failed to fetch skill: ${skillResp.status}` },
    { status: 502, headers: corsHeaders }
  );
}
```

**Remove dead rate-limiting stub (todo 054):** Delete lines 17-21 (the `void ip` block)
and change `"not supported in phase 1"` → `"not supported"` in the error string.

**Verification:** Request with `{ url: 'https://evil.agentskills.io/skill' }` returns
400. Request with `{ url: 'https://agentskills.io/skill' }` proceeds to fetch.

---

### Unit 4 — Prompt sanitization (todo 044) `[P1]`

**File:** `server/_shared/llm.ts` (the `systemAppend` injection block, lines ~186-191)

**Problem:** User-supplied `systemAppend` text is concatenated into the system prompt
without filtering. A crafted framework can contain `"Ignore all previous instructions"`.

**Fix — add `sanitizeSystemAppend()` helper in `llm.ts` or `llm-sanitize.ts`:**
```ts
const INJECTION_PHRASES = [
  'ignore all', 'ignore previous', 'disregard', 'override', 'forget your',
  'new instructions', 'from now on', 'you are now', 'act as', 'pretend you',
  'your new role', 'system:', '\u0000', // null byte
];

function sanitizeSystemAppend(text: string): string {
  return text
    .split('\n')
    .filter(line => {
      const lower = line.toLowerCase().trim();
      return !INJECTION_PHRASES.some(phrase => lower.includes(phrase));
    })
    .join('\n')
    .trim();
}
```

Apply before injection in `callLlm()`:
```ts
if (systemAppend && firstMsg && firstMsg.role === 'system') {
  const sanitized = sanitizeSystemAppend(systemAppend);
  if (sanitized) {
    messages = [
      { role: 'system', content: `${firstMsg.content}\n\n---\n\n${sanitized}` },
      ...messages.slice(1),
    ];
  }
}
```

**Also fix `DeductionPanel.ts` (todo 046, overlapping concern):** The
`geoContext` append path in `DeductionPanel.handleSubmit()` also injects framework text
without sanitization. See Unit 6 for the fix there.

**Verification:** Framework text containing `"ignore all previous instructions"` does
NOT appear in the LLM system prompt. Legitimate framework text (e.g., PMESII-PT
analysis instructions) passes through unchanged.

---

### Unit 5 — Parallelize sha256 calls (todo 051) `[P2]`

**File:** `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:38-39`

**Current (sequential):**
```ts
const contextHash = contextSnapshot ? (await sha256Hex(contextSnapshot)).slice(0, 16) : 'base';
const frameworkHash = frameworkRaw ? (await sha256Hex(frameworkRaw)).slice(0, 8) : '';
```

**Fix (parallel):**
```ts
const [contextHashFull, frameworkHashFull] = await Promise.all([
  contextSnapshot ? sha256Hex(contextSnapshot) : Promise.resolve('base'),
  frameworkRaw    ? sha256Hex(frameworkRaw)    : Promise.resolve(''),
]);
const contextHash = contextSnapshot ? contextHashFull.slice(0, 16) : 'base';
const frameworkHash = frameworkRaw ? frameworkHashFull.slice(0, 8) : '';
```

**Effort:** Trivial (2 lines). Bundle with Unit 1 or Unit 2.

---

### Unit 6 — DeductionPanel dual injection (todo 046) `[P2]`

**File:** `src/components/DeductionPanel.ts`

**Current (broken — dual path):**
```ts
// Line ~123: appends to geoContext
const fw = getActiveFrameworkForPanel('deduction');
if (fw) {
  geoContext = `${geoContext}\n\n---\nAnalytical Framework:\n${fw.systemPromptAppend}`;
}
// Line ~135: sends framework:'' (empty — server never gets framework text)
const resp = await client.deductSituation({ query, geoContext, framework: '' });
```

**Fix:** Use the dedicated `framework` field. Remove the geoContext append:
```ts
const fw = getActiveFrameworkForPanel('deduction');
// Remove the geoContext manual append for frameworks
const resp = await client.deductSituation({
  query,
  geoContext,
  framework: fw?.systemPromptAppend ?? '',
});
```

This aligns with how `get-country-intel-brief.ts` sends the framework as a dedicated
field rather than baking it into geoContext.

**Verification:** Submit a deduction with a framework selected → only one injection path
fires. The `framework` field in the RPC request body is non-empty.

---

### Unit 7 — InsightsPanel double updateGeneration increment (todo 047) `[P2]`

**File:** `src/components/InsightsPanel.ts:55-58`

**Current (broken):**
```ts
this.frameworkUnsubscribe = subscribeFrameworkChange('insights', () => {
  this.updateGeneration++;          // ← manual increment
  void this.updateInsights(this.lastClusters);  // ← updateInsights also increments
});
```

`updateInsights()` starts with `const gen = ++this.updateGeneration` (line ~270).
With the manual pre-increment, `gen` is 2 ahead of what the in-flight call captured,
causing the generation guard to cancel the call that should succeed.

**Fix:** Remove the manual increment:
```ts
this.frameworkUnsubscribe = subscribeFrameworkChange('insights', () => {
  void this.updateInsights(this.lastClusters);
});
```

**Verification:** Change framework in InsightsPanel → panel actually re-renders with
new framework-shaped analysis (currently it doesn't).

---

### Unit 8 — Add framework keys to settings export/import (todo 048) `[P2]`

**File:** `src/utils/settings-persistence.ts`

`SETTINGS_KEY_PREFIXES` array on line ~20 drives the export whitelist. Add:
```ts
'wm-analysis-frameworks',
'wm-panel-frameworks',
```

This ensures `exportSettings()` includes user's custom imported frameworks and per-panel
selections when they export to JSON. On `importSettings()`, the existing
`isSettingsKey(key)` prefix check will match them automatically.

**Verification:** Export settings → JSON contains `wm-analysis-frameworks` entry.
Import on a fresh profile → custom frameworks are restored.

---

### Unit 9 — Country-brief framework change debounce (todo 050) `[P2]`

**File:** `src/app/country-intel.ts:72-78`

**Fix:** Wrap the callback with a 400ms debounce:
```ts
let _fwDebounce: ReturnType<typeof setTimeout> | null = null;

this.frameworkUnsubscribe = subscribeFrameworkChange('country-brief', () => {
  const page = this.ctx.countryBriefPage;
  if (!page?.isVisible()) return;
  const code = page.getCode();
  const name = page.getName() ?? code;
  if (!code || !name) return;
  if (_fwDebounce) clearTimeout(_fwDebounce);
  _fwDebounce = setTimeout(() => void this.openCountryBriefByCode(code, name), 400);
});
```

Clear the debounce timer when `frameworkUnsubscribe` is called (in `destroy()` or
wherever unsubscription happens).

---

### Unit 10 — localStorage hot-path cache for getActiveFrameworkForPanel (todo 049) `[P2]`

**File:** `src/services/analysis-framework-store.ts`

Add a module-level Map as a write-through cache. Invalidate on every mutation:

```ts
const _activeCache = new Map<AnalysisPanelId, AnalysisFramework | null>();

// In setActiveFrameworkForPanel, deleteImportedFramework, renameImportedFramework:
_activeCache.clear(); // or _activeCache.delete(panelId) where panelId is known

export function getActiveFrameworkForPanel(panelId: AnalysisPanelId): AnalysisFramework | null {
  if (!hasPremiumAccess()) return null;
  if (_activeCache.has(panelId)) return _activeCache.get(panelId)!;
  const selections = loadFromStorage<Record<string, string | null>>(PANEL_KEY, {});
  const frameworkId = selections[panelId] ?? null;
  if (!frameworkId) { _activeCache.set(panelId, null); return null; }
  const result = loadFrameworkLibrary().find(f => f.id === frameworkId) ?? null;
  _activeCache.set(panelId, result);
  return result;
}
```

---

### Unit 11 — i18n for Analysis Frameworks settings strings (todo 052) `[P2]`

**Files:** `src/services/preferences-content.ts`, locale translation files

Affected strings (lines ~211-252):

- `"Analysis Frameworks"` → `t('preferences.analysisFrameworks')`
- `"Active per panel"` → `t('preferences.activePerPanel')`
- `"Skill library"` → `t('preferences.skillLibrary')`
- Import modal labels, button text, error messages

Add keys to both `en` and `fr` locale files. Follow the existing pattern in preferences-content.ts.

---

### Unit 12 — P3 cleanup (todos 054-057) `[P3]`

Bundle all small cleanup into one commit:

**054 — Dead rate-limiting stub:** Already removed as part of Unit 3 (SSRF fix).

**055 — FrameworkSelector hardcodes 'insights' panelId:**
Add `note?: string` to `FrameworkSelectorOptions`. Remove `if (opts.panelId === 'insights')` branch.
InsightsPanel passes `note: '* Applies to client-generated analysis only'`.
DailyMarketBriefPanel passes the same note (aligns with todo 053 documentation fix).

**056 — Duplicate stripThinkingTags in summarize-article.ts:**
`stripThinkingTags` is exported from `server/_shared/llm.ts`. In `summarize-article.ts`,
replace the 16-line inline implementation with `import { stripThinkingTags } from '../../_shared/llm.js'`.

**057 — Date.now() ID collision:**
In `preferences-content.ts` import handler, replace `id: Date.now().toString()` with
`id: crypto.randomUUID()`.

---

## Acceptance Criteria

### Security (P1)

- [ ] `deduct-situation.ts` cache key includes `frameworkHash` when `framework` non-empty (todo 041)
- [ ] `summarize-article.ts` cache key includes `systemAppend` hash when non-empty (todo 045)
- [ ] Requests without a PRO API key or PRO Bearer token have `framework`/`systemAppend` silently ignored server-side (todo 042)
- [ ] `fetch-agentskills.ts` uses exact hostname allowlist + `redirect: 'manual'` (todo 043)
- [ ] `systemAppend` is sanitized via directive-phrase line filter before LLM injection (todo 044)

### Correctness (P2)

- [ ] `DeductionPanel.handleSubmit()` passes framework via `framework` field only — no geoContext append (todo 046)
- [ ] Changing framework in InsightsPanel triggers one `updateGeneration` increment and causes re-render (todo 047)
- [ ] Settings export JSON includes `wm-analysis-frameworks` and `wm-panel-frameworks` keys (todo 048)
- [ ] `getActiveFrameworkForPanel` makes zero localStorage calls on cache hit (todo 049)
- [ ] Rapid framework changes in country-brief fire only one RPC after 400ms settle (todo 050)
- [ ] `sha256Hex` calls for context+framework hashes run in parallel (todo 051)
- [ ] Analysis Frameworks settings strings use `t()` i18n calls (todo 052)

### Cleanup (P3)

- [ ] No `void ip` dead stub in `fetch-agentskills.ts` (todo 054)
- [ ] `FrameworkSelector` accepts `note?: string`, no hardcoded `'insights'` panel check (todo 055)
- [ ] `summarize-article.ts` imports `stripThinkingTags` from `_shared/llm.ts` (todo 056)
- [ ] Imported framework IDs use `crypto.randomUUID()` (todo 057)

## Scope Boundaries

- Do NOT change the proto definitions (all fields already added in PR #2380)
- Do NOT add a server-side DailyMarketBrief endpoint (out of scope, tracked in todo 053 separately)
- Do NOT add Vercel Firewall rules (done outside this PR, noted in todo 054)
- Do NOT change `hasPremiumAccess()` client-side logic — only add SERVER-side enforcement

## Dependencies

- Branch from `origin/main` (not from the `feat/intelligence-analytical-frameworks` branch)
- PR #2380 must be merged before or simultaneously with this PR

## System-Wide Impact

- **Cache invalidation:** No existing cached entries are invalidated — the `frameworkHash`
  suffix only applies to requests that include a framework. Requests without a framework
  continue using the existing key namespace.
- **Security regression risk:** Sanitization in Unit 4 could over-filter. Test with all 5
  built-in framework texts to ensure none are stripped.
- **Premium gate (Unit 2):** All existing clients that don't send `framework` are unaffected.
  PRO users already send via the FrameworkSelector — no client changes needed.

## Sources & References

- Origin PR: koala73/worldmonitor#2380
- Review todos: `todos/041` through `todos/057`
- Reference cache key pattern: `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:37-40`
- Premium gate infrastructure: `server/auth-session.ts`, `src/shared/premium-paths.ts`, `server/gateway.ts:243-263`
- Settings persistence: `src/utils/settings-persistence.ts:20-42`
- sanitizeForPrompt: `server/_shared/llm-sanitize.ts`
- stripThinkingTags: `server/_shared/llm.ts:104-122`
