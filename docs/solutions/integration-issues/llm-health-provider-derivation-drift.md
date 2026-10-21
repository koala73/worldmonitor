---
title: LLM health derives providers from credential presence
date: 2026-08-28
category: integration-issues
module: llm-health
problem_type: integration_issue
component: service_object
symptoms:
  - "The desktop health indicator omitted Groq when GROQ_API_KEY did not start with gsk_"
  - "Server LLM calls still used the same Groq key"
root_cause: duplicated_policy
resolution_type: code_change
severity: medium
related_components: [desktop, server, testing]
tags: [llm, groq, health-check, desktop, sidecar, provider-parity]
---

# LLM health derives providers from credential presence

## Decision

The `gsk_` check was drift. It was not an intentional desktop security rule.

`shared/llm-health-providers.js` is now the source of truth for provider health
configuration. A non-empty `GROQ_API_KEY` enables the Groq origin on both the
server and the desktop sidecar. The provider request validates the credential.
The health check reports origin reachability only.

## Why the prefix check was wrong

The server accepted any non-empty `GROQ_API_KEY`. The desktop endpoint accepted
only keys that started with `gsk_`. Both implementations arrived in the same
repository snapshot, and the history has no reason for the extra desktop rule.

A key prefix is not a reliable credential contract. A malformed or revoked key
can have the expected prefix. A valid key can use a different format. The
desktop already has a separate credential-validation endpoint for that question.

## Shared provider shape

The shared module returns entries with three fields:

- `name` identifies the provider in the health response.
- `url` is the origin that both processes probe.
- `allowPrivateNetwork` permits configured local LLM origins in the sidecar.

The sidecar endpoint and `warmHealthCache()` consume this list. This removes the
duplicated Groq and OpenRouter conditions.

## Dead startup probe

The sidecar also probed configured providers after startup. The loop did not
write a cache, and `/api/llm-health` ran new probes for every request. The
startup result had no consumer, so the loop was deleted.

## Verification

The regression tests set `GROQ_API_KEY=groq-test-key`. The server cache and the
desktop endpoint both report `https://api.groq.com` as available when the origin
responds.

Run these checks:

```bash
node_modules/.bin/tsx --test tests/llm-health.test.mts
node --test src-tauri/sidecar/local-api-server.test.mjs
npm run typecheck:api
npm run test:sidecar
```

## Related

- [A timeout that assumed a provider-routing pin the seeder never had](timeout-assumed-a-routing-pin-that-never-existed.md)
  records the same rule: policy that must remain aligned across an import
  boundary must live where both consumers can import it.
