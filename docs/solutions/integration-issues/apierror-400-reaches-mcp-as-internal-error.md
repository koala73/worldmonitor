---
title: A handler's ApiError(400) reaches MCP callers as -32603 "Internal error"; throw ValidationError with the argument name
date: 2026-10-17
category: integration-issues
module: mcp tool dispatch
problem_type: integration_issue
component: service_object
symptoms:
  - "MCP search_flight_prices_by_date with a 50-day range returns -32603 \"Internal error: data fetch failed\""
  - "The same request against /api/aviation/v1/search-google-dates returns 400 {\"message\":\"Date range must contain 1 to 31 days\"}"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
related_components:
  - search-google-flights
  - search-google-dates
tags: [mcp, validation-error, apierror, rpc-validation-error, json-rpc, invalid-params, sebuf]
---

# A handler's ApiError(400) reaches MCP callers as -32603 "Internal error"; throw ValidationError with the argument name

## Problem

The Google Flights handlers rejected bad input with `throw new ApiError(400, message, '')`. The HTTP API answered correctly with a 400 and the message. Through MCP the same rejection became `-32603 "Internal error: data fetch failed"`. Agents read -32603 as transient and retry instead of fixing their arguments, and a directory reviewer sees an internal error.

## Symptoms

- MCP: `{"error":{"code":-32603,"message":"Internal error: data fetch failed"}}` for a range over 31 days or a return date before departure.
- Direct HTTP: `400 {"message":"Date range must contain 1 to 31 days"}`.

## Solution

Throw the generated sebuf `ValidationError` with a field named after the query and MCP argument (PR #9212):

```ts
// before
const invalid = (message: string): never => { throw new ApiError(400, message, ''); };
if (days < 1 || days > 31) invalid('Date range must contain 1 to 31 days');

// after
const invalid = (field: string, description: string): never => { throw new ValidationError([{ field, description }]); };
if (days < 1 || days > 31) invalid('end_date', 'Date range must contain 1 to 31 days');
```

The generated router serializes it as `400 {"violations":[{field, description}]}`, and MCP returns:

```json
{"code":-32602,"message":"Invalid params","data":{"violations":[{"field":"end_date","description":"Date range must contain 1 to 31 days"}]}}
```

## Why This Works

MCP tools fetch the HTTP route and pass non-OK responses to `assertToolFetchOk` (`api/mcp/billing-denial.ts`). For a 400 it only reads `violations` from the body; when it finds safe ones it throws `RpcValidationError`, which dispatch maps to -32602. A body with only `message` falls through to a plain `Error`, and dispatch's catch-all returns -32603 (`api/mcp/dispatch.ts`). Violation fields must match `/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/`, so snake_case argument names pass.

## Prevention

- In any handler an MCP tool calls, reject caller input with `ValidationError`, not `ApiError(400)`. Name the field the caller sent (`end_date`, not `endDate`) and check paired fields separately so the violation names the wrong one.
- Test the whole path: send the gateway's real 400 response through `assertToolFetchOk` and expect `RpcValidationError` with the exact violation. `tests/google-dates-boundary.test.mts` and `tests/google-flights-boundary.test.mts` do this.
- `grep -rn "new ApiError(400" server/` lists the handlers that still have this gap.

## Related Issues

- PR #9212.
- [Google Flights RPCs now need a BotGuard token](google-flights-rpcs-need-botguard-read-the-results-page.md): the change that introduced the 31-day limit this error reports.
