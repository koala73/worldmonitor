---
title: "An idle-time auto-open popover steals focus from an open modal and swallows its Escape"
date: 2026-09-29
category: ui-bugs
module: src/app/event-handlers.ts
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "The WebMCP smoke `validates monitor switches and opens settings and alerts through existing UI` fails in CI on both attempts at `expect(#unifiedSettingsModal.active).toHaveCount(0)` after Escape, and passes locally alone and as the full suite"
  - "The Playwright error-context.md aria snapshot marks the header `◎ Mission` button `[active]`, outside the open settings dialog"
  - "The failing screenshot shows the settings modal still open on the Notifications tab"
  - "The commit under test touched nothing in the UI path, and its own PR run of the same job was green"
root_cause: async_timing
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags: [mission-preset, onboarding-popover, request-idle-callback, schedule-after-first-paint, focus-steal, escape-key, stop-propagation, is-modal-open, ci-only-flake, playwright-error-context]
---

# An idle-time auto-open popover steals focus from an open modal and swallows its Escape

## Problem

The first-run Mission prompt opens itself on the first idle period after paint. On a slow machine that idle period can land after the user has already opened a modal. The prompt then takes focus, and its own Escape handler stops propagation. Escape closes the prompt instead of the modal, and the modal cannot be closed from the keyboard.

## Symptoms

- CI only: the `variant-smoke-pro-webmcp` job failed on the main merge commit of #8697 in Test run 36513431456, twice in a row. The same job passed on the PR head and on the parent commit.
- The failing assertion expects the settings overlay to be gone after `page.keyboard.press('Escape')`.
- The failure snapshot in `error-context.md` shows focus on the Mission header button, not inside the dialog.
- Local runs pass, alone (`--repeat-each=3`) and as the full `npm run test:e2e:webmcp`.

## What Didn't Work

- **Blaming the merged diff.** The merge commit's only change from its green parent was a Sentry filter and a stale-bundle reporter change. Neither can affect keyboard handling. Re-running the same commit locally passed, so the diff did not cause it.
- **Treating it as a known flake.** None of the recent failed Test runs had this job fail. It was a new race, not a noisy test.
- **Opening the popover first.** Waiting for the prompt to be visible before opening settings passed. That ordering is harmless: opening settings closes nothing, and the settings `keydown` listener on `document` still sees Escape. Only the reverse ordering fails.
- **Opening the popover with a click over the modal.** Clicking `#missionPresetBtn` from `page.evaluate` while settings was open did not mount the popover, so it could not reproduce the auto-open path.

## Solution

Skip the idle-time auto-open while any overlay is on screen, using the existing `isModalOpen` predicate (`src/utils/open-modal.ts:207`). The guard sits in the `scheduleAfterFirstPaint` callback in `setupMissionPresets` (`src/app/event-handlers.ts:934`):

```ts
scheduleAfterFirstPaint(() => {
  if (this.ctx.isDestroyed) return;
  if (this.missionPresetPopover || loadStoredMissionPreset() || isMissionPresetPromptDismissed()) return;
  if (isModalOpen(document)) return;
  this.openMissionPresetPopover(document.getElementById('missionPresetBtn'), false, 'auto');
});
```

Skipping costs nothing. The prompt is not marked dismissed, so it reappears on the next load. The fix shipped in PR #8698.

## Why This Works

Three facts combine:

1. The popover focuses itself when it mounts. It is appended outside the modal, so the modal's focus trap loses focus to it.
2. The popover's `keydown` handler calls `e.stopPropagation()` on Escape (`src/app/event-handlers.ts:1073`), then closes the popover. `closeMissionPresetPopover` returns focus to its opener, the Mission button (`src/app/event-handlers.ts:1123`). That is the `[active]` marker in the CI snapshot.
3. The settings modal listens for Escape on `document` (`src/components/UnifiedSettings.ts:611`). A key stopped on the popover never bubbles there.

The auto-open was guarded only against a stored preset, a dismissal, and an existing popover. It never checked whether another overlay was already open. Checking `isModalOpen` at fire time closes that gap for every modal, not only settings.

## Prevention

- **Guard every deferred auto-open against open overlays at fire time.** Code that shows UI from `requestIdleCallback`, `setTimeout`, or a data-arrival callback runs at a moment the user controls. Re-check `isModalOpen(document)` inside the callback, not when scheduling it.
- **Read the `[active]` marker in `error-context.md` first** for a keyboard or focus failure that reproduces only in CI. It names the element that held focus when the assertion failed, which usually points straight at the element that stole it.
- **Reproduce idle-timing races by controlling `requestIdleCallback`, not by sleeping.** A delay in `addInitScript` reproduced the CI failure exactly:

  ```ts
  await page.addInitScript(() => {
    window.requestIdleCallback = ((cb: IdleRequestCallback) =>
      window.setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 8000) as unknown as number
    ) as typeof window.requestIdleCallback;
  });
  ```

- **For a deterministic regression test, hold idle callbacks for the page's life and flush them yourself.** `e2e/mission-presets.spec.ts` does this with `holdIdleCallbacks` and `releaseIdleCallbacks`:
  - Callbacks stay held after the flush. If holding stopped, a callback queued after the release would run through the native scheduler after the assertion, and the test would pass without exercising the guard. Review on #8698 caught this in the first version.
  - The release waits for `load` plus three animation frames. `scheduleAfterFirstPaint` queues its callback two frames after `load` (`src/utils/after-paint.ts`), so three frames guarantee it is queued. The helper also asserts that the flushed batch is non-empty.
- **Pair the negative test with a positive control.** The same hold-and-release with no modal open must still open the prompt. Without it, the negative test passes even when the release never triggers the auto-open.
- **Expect this spec to run only locally.** `e2e/mission-presets.spec.ts` is not named by any CI job. The CI guard for this race is the WebMCP smoke that caught it.

## Related Issues

- [A forced reload on tab-focus destroys the modal the user left the app to serve](stale-bundle-reload-destroys-an-in-progress-modal.md) covers the same overlay area from the reload side. `isModalOpen` and the overlay reload contract come from that line of work.
- PR #8698 contains the fix and the regression tests.
- Test run 36513431456 is the CI failure.
