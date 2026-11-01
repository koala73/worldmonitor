# Preserve health incident evidence

Use the offline recorder to keep full health snapshots and track recurring failures with one owner. It makes no network requests and does not run seeders. Capture the full `/api/health` response, including `checkedAt` and `checks`. A summary containing only `problems` cannot prove that an omitted source recovered and is rejected.

```sh
node scripts/health-incident-evidence.mjs capture "$HOME/.local/state/worldmonitor/incident-evidence" /tmp/health.json existing-codex-thread-id
node scripts/health-incident-evidence.mjs report "$HOME/.local/state/worldmonitor/incident-evidence"
```

Use a directory under a trusted parent owned by you. Existing evidence directories must be owned by the current user, have no group or other permissions, and must not be symbolic links. Each capture gets a new exclusive file with private file permissions. Reports also refuse unsafe directories and linked event files. Repeated captures cannot replace previous evidence. Keep the directory on durable storage for long investigations. Do not put credentials or private provider responses in a health snapshot.

A successful check changes an incident's operational state to `recovered`. Its cause remains `open`, its original owner stays assigned, and a later failure increments `occurrences`. Missing checks and pending optional caches cannot establish recovery. The report is derived from immutable captures, ordered by the health response's original `checkedAt`, rather than the time the file was copied.

Only record causal closure after the repair has supporting evidence. The command requires an incident ID from the report and a nonempty evidence reference. It records the operator's assessment; it does not verify that reference or prove production acceptance.

```sh
node scripts/health-incident-evidence.mjs resolve "$HOME/.local/state/worldmonitor/incident-evidence" 'toronto@2031-01-01T00:00:00.000Z' /tmp/verified-repair.md
```

A subsequent failure creates a new incident. Preserve old source clocks, deadlines and evidence gaps in the referenced report. Natural recovery alone does not justify causal closure. Each capture stores the incident reference and original owner, so importing older evidence preserves an existing closure. Use one capture writer per evidence directory.
