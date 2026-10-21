---
status: pending
priority: p1
issue_id: "043"
tags: [code-review, security, ssrf, analytical-frameworks]
dependencies: []
---

# SSRF bypass in `fetch-agentskills.ts` — `endsWith` check trivially circumvented

## Problem Statement
`api/skills/fetch-agentskills.ts` validates the skill URL with `skillUrl.hostname.endsWith('agentskills.io')`. An attacker can bypass this with a subdomain they control: `evil.agentskills.io` passes the check. The function then `fetch()`es the attacker-controlled URL from Vercel edge compute, potentially reaching internal Vercel network resources (`169.254.169.254` metadata endpoint, internal services). This is a textbook SSRF. Additionally, the check applies only to the direct URL — HTTP redirects are NOT validated, so `agentskills.io.example.com` could redirect to an internal address.

## Findings
- **`api/skills/fetch-agentskills.ts:42`** — `if (!skillUrl.hostname.endsWith('agentskills.io'))` — passes for `evil.agentskills.io`
- No redirect validation — `fetch()` follows 301/302 by default
- No IP-range blocking — `169.254.169.254` (Vercel metadata) reachable if DNS or redirect resolves there
- **Constraint**: Vercel edge functions CANNOT use `node:dns` — full DNS pinning is not feasible without routing through Railway
- Flagged by: security-sentinel, learnings-researcher (ssrf-toctou-dns-pinning skill, VibeSec-Skill)

## Proposed Solutions

### Option A: Strict hostname check + redirect:manual (Recommended for now)
Replace `endsWith` with an exact hostname match against an allowlist and block redirects:
```ts
const ALLOWED_HOSTS = new Set(['agentskills.io', 'www.agentskills.io', 'api.agentskills.io']);
if (!ALLOWED_HOSTS.has(skillUrl.hostname)) {
  return Response.json({ error: 'URL must be from agentskills.io' }, { status: 400 });
}
const resp = await fetch(skillUrl.toString(), { redirect: 'manual' });
if (resp.status >= 300 && resp.status < 400) {
  return Response.json({ error: 'Redirects not allowed' }, { status: 400 });
}
```
**Pros:** Simple, no DNS needed, blocks subdomain bypass and redirect chains | **Effort:** Small | **Risk:** Low

### Option B: Railway relay for DNS pinning
Route the fetch through a Railway relay that can use `node:dns` to resolve the IP, validate it's not private/link-local, then fetch the pinned IP.
**Pros:** Full SSRF protection including DNS rebinding | **Cons:** Added latency, Railway dependency | **Effort:** Medium | **Risk:** Medium

### Option C: Block via Vercel Firewall rules only
Rely on Vercel's network-level protection to block fetches to internal IPs.
**Cons:** Not documented, not guaranteed, no defense against subdomain bypass | **Risk:** High

## Technical Details
- File: `api/skills/fetch-agentskills.ts:42`
- PR: koala73/worldmonitor#2380
- Constraint: Vercel edge cannot use `node:dns` (from MEMORY.md)
- Reference: ssrf-toctou-dns-pinning skill, VibeSec-Skill

## Acceptance Criteria
- [ ] `endsWith` check replaced with exact hostname allowlist
- [ ] Redirects blocked with `redirect: 'manual'`
- [ ] `evil.agentskills.io` returns 400 (not fetched)
- [ ] `169.254.169.254` is unreachable via this endpoint

## Work Log
- 2026-03-27: Identified during PR #2380 review by security-sentinel
