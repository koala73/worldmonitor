---
status: pending
priority: p1
issue_id: "034"
tags: [code-review, bug, auth, clerk]
dependencies: []
---

## Problem Statement

`initAuthState()` and `setupAuthWidget()` in `src/App.ts` are both wrapped in `if (isProUser())` guards. `isProUser()` checks `getAuthState().user?.role === 'pro'` as its third condition — but `getAuthState()` starts as `{ user: null, isPending: true }` until `initAuthState()` runs. On any fresh browser session with no `wm-pro-key` or `wm-widget-key` in localStorage, `isProUser()` returns `false`, Clerk never loads, the sign-in button never appears, and new users can never sign in. The guard is using the very thing it is trying to initialize as its precondition.

## Findings

- **File:** `src/App.ts:745` and `src/App.ts:818`
- `if (isProUser()) { await initAuthState(); }` — Clerk init gated behind pro check
- `if (isProUser()) this.eventHandlers.setupAuthWidget();` — sign-in button never mounts for new users
- `isProUser()` in `widget-store.ts:153` returns false for users with no legacy keys and no active Clerk session
- This is a bootstrapping deadlock: the guard prevents the initialization that would make the guard pass

## Proposed Solutions

**Option A: Remove the `isProUser()` guard entirely around auth init (Recommended)**
Gate only on `!isDesktopRuntime()` if Clerk should not load on desktop. `initAuthState()` is cheap when no key is present.

- **Pros:** Correct. New web users see sign-in button.
- **Cons:** None.
- **Effort:** Small
- **Risk:** Low

**Option B: Gate on `isBrowserRuntime()` or `BETA_MODE`**
Same as A but adds a feature flag for controlled rollout.

- **Pros:** Staged rollout.
- **Cons:** More code, unnecessary complexity at this stage.
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] Fresh browser session (no localStorage keys) shows the sign-in button in the header
- [ ] Clicking sign-in opens Clerk modal
- [ ] After sign-in, pro user sees premium panels
- [ ] `initAuthState()` is called unconditionally (or gated only on runtime type, not user role)

## Work Log

- 2026-03-26: Identified during PR #1812 review (kieran-typescript-reviewer + architecture-strategist agents). Confirmed by reading `App.ts:745`.
