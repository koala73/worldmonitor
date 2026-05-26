---
status: pending
priority: p2
issue_id: "052"
tags: [code-review, quality, i18n, analytical-frameworks]
dependencies: []
---

# Analysis Frameworks settings section uses hardcoded English — inconsistent with i18n pattern

## Problem Statement
The "Analysis Frameworks" section added to `preferences-content.ts` uses hardcoded English strings (`'Analysis Frameworks'`, `'Active per panel'`, `'Skill library'`, button labels, error messages, modal text). Every other section in `preferences-content.ts` uses `t('preferences.xxx')` for internationalization. The frameworks section is the only section that cannot be translated and will display in English even on French-locale (`fr`) builds.

## Findings
- **`src/services/preferences-content.ts`** — frameworks section: `html += \`<summary>Analysis Frameworks</summary>\`` and similar hardcoded strings
- All other sections: `t('preferences.aiProviders')`, `t('preferences.theme')`, etc.
- French locale (`fr`) is a supported language for the app
- Flagged by: code-simplicity-reviewer

## Proposed Solutions

### Option A: Add i18n keys and use `t()` (Recommended)
Add keys to both `en` and `fr` translation files:
```json
// en
"preferences": {
  "analysisFrameworks": "Analysis Frameworks",
  "activePerPanel": "Active per panel",
  "skillLibrary": "Skill library",
  ...
}
```
Then use `t('preferences.analysisFrameworks')` in `preferences-content.ts`.
**Pros:** Consistent with existing pattern | **Effort:** Small | **Risk:** Low

### Option B: Accept as-is for now, file separate i18n ticket
Defer i18n to a follow-up PR since the frameworks feature is new and translations take time.
**Cons:** Creates a known inconsistency; French users see English UI | **Risk:** Low

## Technical Details
- File: `src/services/preferences-content.ts`
- PR: koala73/worldmonitor#2380
- Pattern to follow: existing `t('preferences.*')` calls throughout the same file

## Acceptance Criteria
- [ ] All user-visible strings in the Analysis Frameworks section use `t()` calls
- [ ] French translation keys exist for all new strings
- [ ] No hardcoded English strings remain in the frameworks section

## Work Log
- 2026-03-27: Identified during PR #2380 review by code-simplicity-reviewer
