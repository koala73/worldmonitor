# Documentation Alignment Final Report

**Audit:** `<name>`  
**Base branch/commit:** `<branch> @ <sha>`  
**Fix branch/commit:** `<branch> @ <sha>`  
**Audit Captain:** `<name/thread>`  
**Date:** `<YYYY-MM-DD>`

## Summary

`<One paragraph summary. Do not state "fully aligned" until all required role signoffs below are complete.>`

## Role Signoffs

| Role | Reviewer | Evidence artifact | Status |
|---|---|---|---|
| Audit Captain | `<name/thread>` | `<link/path>` | `<complete/pending>` |
| Claim Cartographer | `<name/thread>` | `<link/path>` | `<complete/pending>` |
| Runtime Truth Reviewer | `<name/thread>` | `<link/path>` | `<complete/pending>` |
| Data Pipeline / Redis Reviewer | `<name/thread>` | `<link/path>` | `<complete/pending>` |
| Generated Contract Reviewer | `<name/thread>` | `<link/path>` | `<complete/pending>` |
| Executable Examples Reviewer | `<name/thread>` | `<link/path>` | `<complete/pending>` |
| Bias / Methodology Reviewer | `<name/thread>` | `<link/path>` | `<complete/pending>` |
| Adversarial Verifier | `<name/thread>` | `<link/path>` | `<complete/pending>` |

## Findings Disposition

| Finding ID | Disposition | Fix evidence | Guardrail |
|---|---|---|---|
| FIND-001 | `<fixed / duplicate / accepted risk / not a bug>` | `<commit/path>` | `<test or manual check>` |

## Verification

```bash
npm run docs:check
<targeted parity tests>
```

## Residual Risks

| Risk | Owner | Follow-up |
|---|---|---|
| `<risk or "None">` | `<owner>` | `<issue/PR/thread>` |

## Closure Statement

`<Use "fully aligned" only if every role signoff is complete, every finding has a disposition, and every accepted residual risk is listed.>`
