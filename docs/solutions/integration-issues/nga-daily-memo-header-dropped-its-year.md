---
title: NGA dropped the year from its daily-memo header, so the navigational-warnings fallback returned nothing
date: 2026-11-11
category: integration-issues
module: nga-broadcast-warnings
problem_type: integration_issue
component: service_object
symptoms:
  - "Health: chokepoints EMPTY_ON_DEMAND with 0 of 13 covered, and every row has navigationalWarningsAvailable false while AIS and transit are present"
  - "Health: cableHealth STALE_SEED, last write past its 90-minute budget"
  - "maritime:navwarnings:v3 holds the __WM_NEG__ negative-cache sentinel"
  - "fetchNgaBroadcastWarnings returns null against live upstream although all five DailyMem*.txt files answer HTTP 200"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components: [background_job]
tags: [nga, msi, navigational-warnings, daily-memo, upstream-format-drift, chokepoints, cable-health, date-parsing]
---

# NGA dropped the year from its daily-memo header, so the navigational-warnings fallback returned nothing

## Problem

The NGA broadcast-warn API (`msi.nga.mil/api/publications/broadcast-warn`) went down again, and this time it hangs instead of returning its 503 maintenance page. The fallback added in #10254 reads the five daily in-force memoranda from the maintenance page instead. On 2026-11-10 NGA changed the memo header from `HYDROARC IN FORCE AS OF 061440Z NOV 26.` to `HYDROARC IN FORCE AS OF 101445Z NOV.`, dropping the two-digit year. The header regex required the year, so every memo parsed to null. Because the fallback is all five memos or nothing (`server/_shared/nga-broadcast-warnings.ts:209`), the whole fallback returned null. Two consumers lost NGA at once: chokepoint status (`get-chokepoint-status.ts:580`) and cable health (`get-cable-health.ts:162`).

## Symptoms

- `chokepoints` in `/api/health` reports 0 of 13 covered. The `seed-meta:supply_chain:chokepoints` record lists all 13 ids in `uncoveredChokepoints`. In `supply_chain:chokepoints:v4`, every row has `navigationalWarningsAvailable: false` while `aisSnapshotAvailable` and `transitSummary.dataAvailable` are true.
- `cableHealth` goes `STALE_SEED`, and `seed-meta:cable-health` stops advancing.
- `maritime:navwarnings:v3` holds `"__WM_NEG__"`.
- The memo URLs return 200 with fresh content, while the API URL times out with no response.

## What Didn't Work

- Assuming the #10254 fallback already covered the outage. It covers the API being down. It does not cover the memos changing shape, and with a null result nothing distinguishes the two cases.
- Looking at the API failure mode. The change from a 503 page to a hang was handled correctly, because the API gets half the timeout budget. It was not the cause.

## Solution

Make the header year optional and infer it when absent (#10441):

```ts
const header = lines[headerIndex]?.trim().match(/^(.+) IN FORCE AS OF (\d{6}Z [A-Z]{3})(?: (\d{2}))?\.$/);
const asOf = header ? parseHeaderAsOf(header[2]!, header[3], nowMs) : null;

function parseHeaderAsOf(dayTimeMonth: string, yy: string | undefined, nowMs: number): { ms: number } | null {
  if (yy !== undefined) return parseDtg(`${dayTimeMonth} ${yy}`);
  const year = new Date(nowMs).getUTCFullYear();
  for (const candidate of [year + 1, year, year - 1]) {
    const asOf = parseDtg(`${dayTimeMonth} ${String(candidate % 100).padStart(2, '0')}`);
    if (asOf === null) return null;
    if (asOf.ms <= nowMs + 60 * 60 * 1000) return asOf;
  }
  return null;
}
```

The resolver takes the latest year that puts the date at most an hour ahead of now (`nga-broadcast-warnings.ts:93`). A 31 Dec memo read on 1 Jan stays in the old year. A 1 Jan memo seen just before midnight resolves to the new year, a case CodeRabbit raised in review. The existing 4-day age check (`NGA_DAILY_MEMO_MAX_AGE_MS`, line 72) still rejects stale memos.

## Why This Works

The memo bodies did not change. With a year spliced back into the live headers, the five memos parsed to 100, 26, 84, 153 and 32 warnings. The header was the only gate failing. The warning blocks inside each memo still carry their own dated groups (`091946Z NOV 26`), so only the header needed year inference.

Verified in production after the deploy at 2026-11-11T06:20Z:

- `maritime:navwarnings:v3` filled with 395 warnings.
- `seed-meta:supply_chain:chokepoints` reached `recordCount: 13`.
- `/api/health` returned HEALTHY, with `chokepoints` OK at 13 records and `cableHealth` OK.

## Prevention

- **Diagnose by running the fetcher against live upstream, not by reading health.** A one-off script that imports `fetchNgaBroadcastWarnings` and calls it with a 10s or 15s `timeoutMs` shows the full path. If it returns NULL while the memo files are HTTP 200, the memos have drifted. Then `head -3` each memo and parse each one separately with `parseNgaDailyMemo` to find which gate rejects it.
- **NGA changes the memo format without notice.** This is the second silent change in a week. On 2026-11-09 NAVAREA IV began listing its in-force summary as its own block (Sentry WORLDMONITOR-1C4). Expect more, and keep the parser strict, because a partial parse would report areas as quiet. Make each new format a fixture-backed test case.
- **Test new formats by deriving them from the existing fixtures.** The regression test strips the year from all five fixture headers and checks that each parses identically to the dated version. It was committed failing (`AssertionError: NAVAREA IV`) before the fix.
- **Known remaining exposure.** The per-warning date groups and `startsMemoNotice` still require a year. If NGA drops it there too, the memo still parses, but `issueDate` becomes empty and no alarm fires.

## Related Issues

- #10254: added the daily-memo fallback when the API went into maintenance.
- #10441: this fix.
- Sentry WORLDMONITOR-1C4: the in-force summary block, an earlier format change in the same memos.
