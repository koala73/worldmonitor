---
title: "StatusPanel is a detached data sink — UI appended to it is never mounted"
date: 2026-08-28
category: ui-bugs
module: src/components/StatusPanel.ts
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "The `digest-coverage-row` div appended by `StatusPanel.updateDigestCoverage()` never appears under `document` — `StatusPanel.init()` replaces the base element with a fresh detached `div.status-panel-container` and nothing ever appends it"
  - "aria-live text explaining stale or missing digest categories is invisible to sighted users and unreachable by assistive technology, even though the update method runs on every status tick from data-loader.ts"
  - "`StatusPanel.getElement()` has zero callers anywhere in src/, and the CSS classes `status-panel-container` and `digest-coverage-row` appear nowhere else in src/"
  - "All component-level contract tests for the coverage row pass, because none of them asserts the element is reachable from `document`"
  - "Issue #7085's acceptance criterion ('exposes the same state to assistive technology') is unmet in production even though PR #7090 merged and closed the issue"
root_cause: incomplete_setup
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
  - development_workflow
tags: [status-panel, digest-coverage, detached-dom, accessibility, aria-live, mounted-dom-assertion, panel-lifecycle, dead-ui]
---

# StatusPanel is a detached data sink — UI appended to it is never mounted

## Problem

`StatusPanel` (`src/components/StatusPanel.ts`) is constructed and written to on every data load, but its root element is never attached to the document. PR #7090 (merged 2026-08-25, auto-closing issue #7085 by keyword) added a digest coverage row that appends itself to `this.element` — so the row, and the accessibility contract it carries, render into a detached DOM node that no user and no screen reader can ever reach. The feature shipped green, with 18 contract tests, and is invisible in production.

## Symptoms

- **The row exists in code and nowhere on screen.** `updateDigestCoverage()` builds a `digest-coverage-row` div with `role="status"`, `aria-live="polite"`, `aria-label="Digest coverage status"` and appends it to the panel element (`src/components/StatusPanel.ts:118-127`). The class string `digest-coverage-row` appears in exactly two places in the repo: that creation site, and the component test at `tests/dom/status-panel-digest-coverage.test.mts:31`. No CSS rule, no query, no mount site.
- **The panel's own root class is equally orphaned.** `status-panel-container` appears twice repo-wide: `src/components/StatusPanel.ts:88` where it is created, and `docs/Docs_To_Review/COMPONENTS.md:960` where a stale doc describes a version of the component that no longer exists.
- **Nothing reads the panel back.** `getElement()` at `src/components/StatusPanel.ts:172-174` has zero call sites against `statusPanel` anywhere in `src/`. Neither do `getFeeds()` / `getApis()` (`src/components/StatusPanel.ts:101-102`) or the `onUpdate` hook (`src/components/StatusPanel.ts:77`).
- **Only writes flow in.** Every one of the ~135 `statusPanel` references in `src/app/data-loader.ts` is a write: `?.updateFeed(...)`, `?.updateApi(...)`, and the #7085 additions `this.ctx.statusPanel?.updateDigestCoverage({...})` at `src/app/data-loader.ts:775` and `:792`, both inside `reportDigestCoverage` (`src/app/data-loader.ts:767`).
- **Confirmed on the live production dashboard.** (session history) A 2026-08-28 verification session opened `worldmonitor.app/dashboard` in a real browser hunting for coverage content: heading searches came back empty, `document.body.children` contained no status-panel element, and the only `aria-live` region on the page was the "PRO is launched" upsell banner — no digest-coverage content anywhere in the accessibility tree.
- **Issue #7085's acceptance criterion is unmet in the shipped product.** The requirement — the dashboard explains stale or missing categories in text and exposes the same state to assistive technology — is satisfied only inside a detached element. The issue was auto-closed by PR #7090's closing keyword and has been **reopened (P1) on 2026-08-28** with this finding. Parent epic: #7080.

## What Didn't Work

- **Relying on the base class to mount it.** `StatusPanel extends Panel` and calls `super({ id: 'status', title: t('panels.status') })` (`src/components/StatusPanel.ts:80`). `Panel` assigns `this.element = document.createElement('div')` in its constructor (`src/components/Panel.ts:197`). But `StatusPanel.init()` then **overwrites** it: `this.element = h('div', { className: 'status-panel-container' })` (`src/components/StatusPanel.ts:88`). Even if the base-class element had been mounted, the replacement would have severed it. Nothing in the base class rescues a subclass that reassigns `element` after `super()`.
- **Relying on the panel registry.** The app mounts panels generically through `this.ctx.panels` (`src/app/app-context.ts:68`), which `src/app/panel-layout.ts` walks to append `panel.getElement()`. `StatusPanel` is not in that registry. It lives in its own context slot — `statusPanel` (`src/app/app-context.ts:100`) — and is constructed by `setupStatusPanel()` as a bare object: `this.ctx.statusPanel = new StatusPanel()` (`src/app/event-handlers.ts:1664`, inside a lazy `import('@/components/StatusPanel')`). Having a `id: 'status'` panel id buys nothing; the registry is keyed by what is inserted into it, not by what a constructor declares.
- **Relying on the contract tests from PR #7090.** `tests/digest-coverage-block.test.mts` covers the server-side coverage classifier, and `tests/dom/data-loader-digest-coverage.test.mts` covers the caller. They are good tests of the *values*. `tests/dom/status-panel-digest-coverage.test.mts` is the one test of the *row*, and it reads the element out of the component itself — `new StatusPanel()` then `panel.getElement().querySelector('.digest-coverage-row')` (lines 28-31). A detached element satisfies `querySelector`, `getAttribute('aria-live')`, and `textContent` identically to a mounted one. None of the three files asserts `document`, `isConnected`, or `body` reachability. **The suite could not have failed.**
- **Trusting the component doc.** `docs/Docs_To_Review/COMPONENTS.md:954-961` describes StatusPanel as a 251-line panel whose DOM is "`div.status-panel-container` with toggle button, sections: `feeds-list`, `apis-list`, `storage-info`." The current file is 175 lines with no render method at all, and `feeds-list`, `apis-list`, and `storage-info` appear nowhere in `src/`. The rendering half of this component was removed at some point and the doc was never updated — which is very likely why appending to `this.element` looked like a reasonable way to add a visible row.

## Solution

**The fix ships with this doc in PR #7267** (issue #7085 stays open for its post-deploy gates: live browser verification and the MCP proof). The diagnosis was verified first: the element was provably unreachable at `origin/main` pre-fix, established by three greps against source and corroborated by a live-browser accessibility-tree probe (session history).

The fix has two parts, and neither is optional:

**1. Give the coverage row a real home in the document.** The shipped shape (PR #7267): `updateDigestCoverage()` self-mounts the panel element into the always-present `footer.site-footer` on first update, guarded by `isConnected` so it no-ops if anything else ever mounts the panel and self-heals if the footer is re-rendered. The site footer is what #7085 itself asked for ("a compact dashboard footer or status row"), it exists from layout Phase 1 — long before the first digest load — and a document without one (a non-dashboard page, a bare test) leaves the row detached rather than throwing. The alternative considered and rejected: mounting from `setupStatusPanel()` in `event-handlers.ts`, which matches the sibling `setup*()` convention but is untestable there (nothing constructs `EventHandlerManager` in tests — its only test is a source-grep, the toothless wiring-guard shape).

**2. Lock it with an assertion that requires the document.** A test that reads the element out of the component under test cannot distinguish mounted from detached. The regression test must start from `document`:

```ts
// e2e or integration — must go through the real app bootstrap, not `new StatusPanel()`
await loadDigest(app);                       // drive the real reportDigestCoverage path
const row = document.querySelector('.digest-coverage-row');
expect(row).not.toBeNull();                  // fails today: the node is detached
expect(row?.isConnected).toBe(true);
expect(row?.getAttribute('aria-live')).toBe('polite');
expect(row?.textContent).toMatch(/^Digest coverage: (complete|partial|stale|unavailable|unknown) — /);
```

Prove the test goes red against the current code before landing the mount fix. The repo already has the harness pattern for this: `src/e2e/china-activity-nowcast-panel-harness.ts:64` does `app.appendChild(panel.getElement())` to put a panel into a real document before asserting on it.

While fixing, also correct `docs/Docs_To_Review/COMPONENTS.md:954-961` — it currently describes DOM that does not exist and actively misleads the next person who adds UI here.

## Why This Works

The root cause is not a logic error in the coverage classifier — that part is correct and well tested. It is an **ownership gap**: `StatusPanel` was reduced to a data sink at some point (its rendering removed, its readers deleted), but its constructor still builds an element and still exposes `getElement()`. The class kept the *shape* of a view component while losing every consumer that made it one. Appending to `this.element` is a completely reasonable thing to write against that shape — and completely inert.

Two structural facts turn that gap into a silent failure:

1. **A detached `HTMLElement` is fully functional.** `appendChild`, `querySelector`, `getAttribute`, and `textContent` all behave identically whether or not the tree is rooted at `document`. Nothing in the DOM API distinguishes the two unless you ask (`isConnected`, or a query that starts at `document`). So no runtime error, no console warning, no test failure — the only signal is that nobody sees it.
2. **Component-level tests are scoped below the bug.** The test at `tests/dom/status-panel-digest-coverage.test.mts:28-31` constructs the component and queries *within it*. Mounting is by definition a property of the relationship between the component and the app, so a test that only instantiates the component has excluded the failure from its own scope. This is the same family as two sibling failure modes already recorded in project memory (auto memory [claude]): "a test that CLONES the unit under test cannot fail," and "WM dashboard window scroll never fires" — green tests sitting on top of dead user-visible wiring.

The optional-chaining call style compounds it. `this.ctx.statusPanel?.updateDigestCoverage(...)` (`src/app/data-loader.ts:775`, `:792`) is written to tolerate a null panel during the lazy import — which is correct — but it means "the panel isn't there" and "the panel is there and swallowing everything" produce byte-identical behavior at every call site. There is no code path in the app that would ever notice the difference.

## Prevention

**1. Ask "who mounts this element?" before adding UI to an existing component — and answer it with three greps.** When a component already exists, it is tempting to assume it is wired up. Verify without a browser:

```bash
# a) does anything read the element out?
git grep -n "<instanceName>.getElement\|<instanceName>?.getElement" src/

# b) does the root class exist anywhere but its own creation site?
git grep -n "<root-css-class>" -- src/ tests/ ':!*.md'

# c) does anything consume the component's read API at all?
git grep -n "<instanceName>\." src/ | grep -v "update\|set"
```

If (a) is empty, (b) returns only the line that creates it, and (c) shows only writes, the element is unreachable and any UI you append to it is dead on arrival. Three greps, no browser, under a minute. This generalizes: **a UI class with zero readers is a data sink wearing a view's clothes**, whatever its name says.

Related trap to check in the same pass: if the component `extends` a base class, confirm it does not reassign `this.element` after `super()` (as `src/components/StatusPanel.ts:88` does over `src/components/Panel.ts:197`). A subclass that replaces the base element opts itself out of every base-class mounting path, silently.

**2. Every user-visible feature needs at least one assertion that starts at `document`.** Component tests are necessary and not sufficient — they verify the element is *built*, never that it is *reachable*. Pair them with one mounted-DOM assertion driven through the real app path, as in the Solution section. The distinguishing property is the *starting point of the query*, not the assertion count. `panel.getElement().querySelector(x)` and `document.querySelector(x)` differ by exactly one bug class — this one — and it is the bug class that decides whether users see the feature. When a PR adds visible UI, at least one test must start from `document`.

**3. An `aria-live` attribute on a detached node is a false accessibility claim.** `role="status"`, `aria-live="polite"`, and `aria-label` are contracts with the accessibility tree, and the accessibility tree is derived from the *rendered* document. On a detached element they announce nothing to anyone — but they read in review, in the diff, and in the test file exactly like a delivered accessibility feature, and they let an issue with an a11y acceptance criterion close green. Treat any ARIA attribute added in a PR as unverified until a test proves the node is connected to `document`. Reviewing "does it have aria-live?" is not reviewing accessibility; reviewing "is the aria-live node reachable from `document` in the running app?" is.

**4. Auto-closed issues with UI or accessibility acceptance criteria deserve a post-merge audit.** #7085 was closed by PR #7090's closing keyword the moment the PR merged — the keyword asserts the criteria are met, and nothing checks that assertion. This finding came out of a 2026-08-28 gate audit of auto-closed issues, which is the control that caught it three days later. Keep that audit; the closing keyword is a claim, not evidence.

**5. Stale component docs manufacture this bug.** `docs/Docs_To_Review/COMPONENTS.md:954-961` describes a rendering StatusPanel that has not existed for some time. A contributor reading it would reasonably conclude the panel renders. When a component's rendering is removed, delete or update its DOM documentation in the same change — otherwise the doc keeps inviting people to append UI into a void.

## Related Issues

- Issue #7085 — `feat(news): expose compact digest coverage and latest-attempt state` (REOPENED 2026-08-28, P1). Fix pending.
- PR #7090 — merged 2026-08-25, auto-closed #7085 by keyword. Added `updateDigestCoverage` (`src/components/StatusPanel.ts:109-128`), the caller `reportDigestCoverage` (`src/app/data-loader.ts:767`), and the three test files.
- Issue #7080 — `epic(news): make digest retention bounded, category-complete, and honest` (parent epic, OPEN).
- [playback-control-gated-on-a-clerk-role-field-with-no-writer](../logic-errors/playback-control-gated-on-a-clerk-role-field-with-no-writer.md) — same failure shape in the same file family (`event-handlers.ts` `setup*()`): a UI feature silently broken for 100% of users because one link in the chain is never exercised, and only a behavioral test driving production wiring has teeth.
- [panel-scheduled-but-never-primed-shows-loading-radar-for-a-full-interval](panel-scheduled-but-never-primed-shows-loading-radar-for-a-full-interval.md) — sibling dashboard-panel wiring gap: a panel needing two registrations shipped with one; here `setupStatusPanel()` does step 1 (construct) but never step 2 (mount), which sibling `setupPizzIntIndicator()`/`setupLlmStatusIndicator()` both do.
- [deferred-panel-mounts-after-the-boot-data-pass-and-keeps-its-constructor-empty-state](deferred-panel-mounts-after-the-boot-data-pass-and-keeps-its-constructor-empty-state.md) — the repo's `Panel.runWhenConnected()`/`notifyConnected()` idiom for DOM-connection timing; that bug eventually mounted, this one never does.
