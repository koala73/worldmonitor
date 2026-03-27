---
status: pending
priority: p2
issue_id: "054"
tags: [code-review, security, seeding, reddit, social-velocity, pr-2375]
dependencies: []
---

## Problem Statement

The `seedSocialVelocity` loop in `scripts/ais-relay.cjs` stores `p.permalink` from Reddit API responses directly into Redis without validating the URL scheme. Reddit permalinks are typically relative paths (e.g., `/r/worldnews/comments/...`) but the code prepends `https://reddit.com` — however, if the Reddit API ever returns a full URL with a different scheme (e.g., `javascript:` or `data:`), that value would be stored and potentially rendered as a link in the Social Velocity panel, creating an XSS vector.

## Findings

- **File:** `scripts/ais-relay.cjs` — `seedSocialVelocity` section: `url: 'https://reddit.com' + p.permalink` (or similar construction)
- **Concern:** `p.permalink` from the Reddit JSON API is typically a relative path starting with `/r/`, but this is not validated
- **Impact (if exploited):** If a future Reddit API change or edge case returns a full URL in `permalink`, the stored value could contain an arbitrary scheme. Frontend rendering the URL without validation could execute JavaScript
- **Secondary concern:** `p.permalink` from upvote-manipulated posts could contain unicode path segments that normalize unexpectedly

## Proposed Solutions

**Option A: Validate permalink starts with /r/ before storing (Recommended)**

```javascript
const safePermalink = p.permalink?.startsWith('/r/') ? p.permalink : null;
if (!safePermalink) continue; // skip malformed items
const url = 'https://reddit.com' + safePermalink;
```

- **Effort:** Trivial (one guard)
- **Risk:** None — drops malformed items, logs warning

**Option B: Parse full URL and assert scheme is https**

```javascript
const url = 'https://reddit.com' + p.permalink;
try {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') continue;
} catch { continue; }
```

- **Effort:** Trivial
- **Risk:** None

**Option C: Sanitize on the frontend rendering side**

Ensure the Social Velocity panel only renders URLs with `https:` scheme. Belt-and-suspenders approach alongside server-side validation.

- **Effort:** Small
- **Risk:** None — defense in depth

## Acceptance Criteria

- [ ] `p.permalink` validated (must start with `/r/` or parsed URL must have `https:` scheme) before storage
- [ ] Items with invalid permalinks are skipped with a console.warn
- [ ] Frontend Social Velocity panel does not render non-https URLs as clickable links

## Work Log

- 2026-03-27: Identified by security-sentinel agent during PR #2375 review.
