#!/usr/bin/env node
/**
 * Compare downstream Pro-feature adoption between subscribers who confirmed
 * at least one activation-wizard step and subscribers who confirmed none.
 *
 * Reported per cohort (#5621) — day-0 post-checkout sessions and the
 * markerless retro backfill are separate populations with different baseline
 * adoption, so they get separate verdicts rather than one pooled number.
 *
 * Every shown presentation stays in the cohort. Its observation window starts
 * at the durable exit when present, otherwise the latest persisted progress,
 * otherwise `presentedAt` for a no-action abandonment. This avoids both
 * lost-exit censorship and counting the wizard's own writes as downstream
 * adoption.
 * Only presentations with a complete observation window are analyzed, and a
 * verdict is refused when any newest-first Convex export may be truncated.
 *
 * Usage:
 *   `node --env-file=.env.local scripts/report-activation-lift.mjs
 *      [--window-days=14] [--limit=20000]`
 *
 * Required env: CONVEX_DEPLOY_KEY, CONVEX_DEPLOYMENT.
 *
 * Read-only: uses `npx convex data <table>`, never a mutation.
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const FEATURE_TABLES = [
  "notificationChannels",
  "alertRules",
  "userApiKeys",
  "mcpProTokens",
];
export const MIN_GROUP_SIZE_FOR_A_CLAIM = 30;
export const DEFAULT_EXPORT_TIMEOUT_MS = 60_000;

function parseJsonLines(table, stdout) {
  try {
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(
      `[activation-lift] could not parse the ${table} export: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function fetchTable(
  table,
  {
    limit,
    timeoutMs = DEFAULT_EXPORT_TIMEOUT_MS,
    runner = spawnSync,
  },
) {
  const result = runner(
    "npx",
    ["convex", "data", table, "--limit", String(limit), "--order", "desc", "--format", "jsonl"],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 256,
      timeout: timeoutMs,
    },
  );
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(
      `[activation-lift] npx convex data ${table} timed out after ${timeoutMs}ms`,
    );
  }
  if (result.error || result.status !== 0) {
    const details = [
      result.error instanceof Error ? result.error.message : result.error,
      result.signal ? `signal=${result.signal}` : null,
      result.stderr,
      result.stdout,
    ].filter(Boolean);
    throw new Error(
      `[activation-lift] npx convex data ${table} failed${
        details.length > 0 ? `: ${details.join(" | ")}` : ""
      }`,
    );
  }
  const rows = parseJsonLines(table, result.stdout ?? "");
  return { rows, truncated: rows.length >= limit };
}

function activityTimestamp(table, row) {
  switch (table) {
    case "notificationChannels":
      return row.verified === true ? row.linkedAt : null;
    case "alertRules":
      return row.enabled === true ? row.updatedAt : null;
    case "userApiKeys":
    case "mcpProTokens":
      return row.revokedAt === undefined ? row.createdAt : null;
    default:
      return null;
  }
}

/**
 * Build the user index once. The previous implementation filtered every full
 * table for every presentation (up to 1.6B predicate evaluations at 20k rows).
 */
export function indexFeatureRows(featureRowsByTable) {
  return Object.fromEntries(
    FEATURE_TABLES.map((table) => {
      const byUser = new Map();
      for (const row of featureRowsByTable[table] ?? []) {
        if (typeof row.userId !== "string") continue;
        const timestamp = activityTimestamp(table, row);
        if (typeof timestamp !== "number") continue;
        const rows = byUser.get(row.userId);
        if (rows) rows.push(timestamp);
        else byUser.set(row.userId, [timestamp]);
      }
      return [table, byUser];
    }),
  );
}

function summarizeGroup(rows, featureIndex, windowMs) {
  let anyCount = 0;
  const perTable = Object.fromEntries(FEATURE_TABLES.map((table) => [table, 0]));
  for (const presentation of rows) {
    let any = false;
    const sinceMs = presentation.observationStartedAt;
    for (const table of FEATURE_TABLES) {
      const timestamps = featureIndex[table].get(presentation.userId) ?? [];
      let count = 0;
      for (const timestamp of timestamps) {
        if (timestamp > sinceMs && timestamp <= sinceMs + windowMs) count += 1;
      }
      perTable[table] += count;
      if (count > 0) any = true;
    }
    if (any) anyCount += 1;
  }
  return {
    n: rows.length,
    anyCount,
    rate: rows.length > 0 ? anyCount / rows.length : 0,
    perTable,
  };
}

/**
 * Which activation cohort a presentation row belongs to (#5621). An absent
 * `cohort` is the markerless retro backfill — the only cohort that existed
 * before day-0 sessions started writing rows, so every historical row keeps
 * classifying the way it always did.
 */
export function activationCohortOf(row) {
  return row.cohort === "day0" ? "day0" : "retro";
}

export const ACTIVATION_COHORTS = ["day0", "retro"];

export const COHORT_LABELS = {
  day0: "Day-0 (post-checkout welcome)",
  retro: "Retro (markerless first-cycle backfill)",
};

/**
 * Analyze each cohort on its own. They are NOT pooled: a day-0 subscriber is
 * minutes old and a retro subscriber is mid-cycle, so their baseline adoption
 * rates are not comparable and a combined lift number would average two
 * different populations into one meaningless figure.
 */
export function analyzeActivationLiftByCohort({ presentations, ...rest }) {
  // One index for both cohorts — building it per cohort would re-walk every
  // feature table for no gain.
  const featureIndex = indexFeatureRows(rest.featureRowsByTable ?? {});
  return Object.fromEntries(
    ACTIVATION_COHORTS.map((cohort) => [
      cohort,
      analyzeActivationLift({
        ...rest,
        featureIndex,
        presentations: presentations.filter((row) => activationCohortOf(row) === cohort),
      }),
    ]),
  );
}

export function analyzeActivationLift({
  presentations,
  featureRowsByTable,
  featureIndex: prebuiltFeatureIndex,
  truncatedTables = [],
  reportNow,
  windowMs,
  minGroupSize = MIN_GROUP_SIZE_FOR_A_CLAIM,
}) {
  const presented = presentations.filter((row) => typeof row.presentedAt === "number");
  const shown = presented.filter((row) => row.outcomeTrackingVersion === 1);
  const observed = shown.map((row) => ({
    ...row,
    observationStartedAt:
      typeof row.exitedAt === "number"
        ? row.exitedAt
        : typeof row.outcomeUpdatedAt === "number"
          ? row.outcomeUpdatedAt
          : row.presentedAt,
  }));
  const mature = observed.filter(
    (row) => row.observationStartedAt + windowMs <= reportNow,
  );
  const immature = observed.filter(
    (row) => row.observationStartedAt + windowMs > reportNow,
  );
  const incompleteExits = mature.filter((row) => typeof row.exitedAt !== "number");
  const engaged = mature.filter((row) => (row.confirmedSteps?.length ?? 0) > 0);
  const presentedOnly = mature.filter((row) => (row.confirmedSteps?.length ?? 0) === 0);

  // Push-denial cohort (#5617). `blockedSteps` records a step the BROWSER
  // refused, which before #5617 was indistinguishable from a voluntary skip in
  // this table — so this count could not be produced at all. Rows written by a
  // client too old to report the bucket leave it ABSENT rather than empty, and
  // those are excluded from the denominator instead of being counted as "no
  // denial": they never looked, so they cannot testify either way.
  const denialObservable = mature.filter((row) => Array.isArray(row.blockedSteps));
  const denied = denialObservable.filter((row) => row.blockedSteps.length > 0);

  const base = {
    totalPresentations: presentations.length,
    shown: shown.length,
    uninstrumented: presented.length - shown.length,
    mature: mature.length,
    immature: immature.length,
    incompleteExits: incompleteExits.length,
    // A denial is a permanent dead end — the browser never re-prompts once
    // permission is `denied` — so this is the population for whom re-prompting
    // is worth exactly nothing.
    pushDenial: {
      observable: denialObservable.length,
      denied: denied.length,
      unreportable: mature.length - denialObservable.length,
      rate:
        denialObservable.length > 0
          ? Number((denied.length / denialObservable.length).toFixed(4))
          : null,
    },
    truncatedTables: [...truncatedTables],
  };
  if (truncatedTables.length > 0) {
    return { ...base, verdict: "incomplete-export", engaged: null, presentedOnly: null };
  }

  const featureIndex = prebuiltFeatureIndex ?? indexFeatureRows(featureRowsByTable);
  const engagedSummary = summarizeGroup(engaged, featureIndex, windowMs);
  const presentedOnlySummary = summarizeGroup(presentedOnly, featureIndex, windowMs);
  if (mature.length === 0) {
    return {
      ...base,
      verdict: "no-mature-outcomes",
      engaged: engagedSummary,
      presentedOnly: presentedOnlySummary,
    };
  }
  if (engagedSummary.n < minGroupSize || presentedOnlySummary.n < minGroupSize) {
    return {
      ...base,
      verdict: "below-sample-floor",
      engaged: engagedSummary,
      presentedOnly: presentedOnlySummary,
    };
  }
  return {
    ...base,
    verdict: "comparison",
    lift: engagedSummary.rate - presentedOnlySummary.rate,
    engaged: engagedSummary,
    presentedOnly: presentedOnlySummary,
  };
}

function formatGroup(name, summary, windowDays, minGroupSize) {
  const lines = [
    `${name}: n=${summary.n}, adopted >=1 feature within ${windowDays}d: ${summary.anyCount} (${(
      summary.rate * 100
    ).toFixed(1)}%)`,
  ];
  for (const table of FEATURE_TABLES) {
    lines.push(`    ${table}: ${summary.perTable[table]} qualifying rows`);
  }
  if (summary.n < minGroupSize) {
    lines.push(
      `    WARNING: n=${summary.n} is below the ${minGroupSize}-sample verdict floor.`,
    );
  }
  return lines;
}

export function formatActivationLiftReport(
  analysis,
  {
    windowDays,
    limit,
    minGroupSize = MIN_GROUP_SIZE_FOR_A_CLAIM,
    heading = `[activation-lift] window=${windowDays}d limit=${limit} per table`,
  },
) {
  const lines = [
    heading,
    "",
    `Presentations: ${analysis.totalPresentations} exported, ${analysis.shown} outcome-instrumented and shown, ${analysis.mature} with a complete ${windowDays}d window.`,
    `  excluded as pre-instrumentation: ${analysis.uninstrumented}`,
    `  excluded as immature: ${analysis.immature}`,
    `  mature sessions without a recorded exit: ${analysis.incompleteExits} (included from durable presentation/progress state)`,
    // Rendered even at 0 so the line's absence always means "old build", never
    // "no denials" (#5617).
    `Push denials: ${analysis.pushDenial.denied}/${analysis.pushDenial.observable}` +
      `${analysis.pushDenial.rate === null ? "" : ` (${(analysis.pushDenial.rate * 100).toFixed(1)}%)`}` +
      ` — permanent dead ends; re-prompting these accounts is worth nothing.` +
      `${analysis.pushDenial.unreportable > 0 ? ` [${analysis.pushDenial.unreportable} row(s) predate the bucket and cannot testify]` : ""}`,
  ];

  if (analysis.verdict === "incomplete-export") {
    lines.push(
      "",
      "--- Verdict ---",
      `Inconclusive: these exports reached the ${limit}-row cap and may be incomplete: ${analysis.truncatedTables.join(", ")}. Re-run with a higher limit; no adoption rates were computed.`,
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    "--- Adoption within the complete window, by engagement ---",
    ...formatGroup("Engaged", analysis.engaged, windowDays, minGroupSize),
    ...formatGroup("Presented-only", analysis.presentedOnly, windowDays, minGroupSize),
    "",
    "--- Verdict ---",
  );
  if (analysis.verdict === "no-mature-outcomes") {
    lines.push(
      `No presentations have completed the full ${windowDays}-day observation window yet.`,
    );
  } else if (analysis.verdict === "below-sample-floor") {
    lines.push(
      "Not enough mature presentations in one or both groups to make a comparison yet.",
    );
  } else {
    lines.push(
      `Engaged-group adoption rate is ${(analysis.lift * 100).toFixed(1)} percentage points ${
        analysis.lift >= 0 ? "higher" : "lower"
      } than presented-only.`,
      "This is an engagement comparison within one exposed population, not a randomized control; selection effects are not ruled out.",
    );
  }
  return lines.join("\n");
}

/** One section per cohort, each with its own verdict (#5621). */
export function formatActivationLiftReportByCohort(analysisByCohort, options) {
  const sections = ACTIVATION_COHORTS.map((cohort) =>
    formatActivationLiftReport(analysisByCohort[cohort], {
      ...options,
      heading: `=== ${COHORT_LABELS[cohort]} — window=${options.windowDays}d limit=${options.limit} per table ===`,
    }),
  );
  return sections.join("\n\n");
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[activation-lift] --${name} must be a positive number`);
  }
  return parsed;
}

export function runCli(argv = process.argv.slice(2), env = process.env) {
  if (!env.CONVEX_DEPLOY_KEY || !env.CONVEX_DEPLOYMENT) {
    throw new Error(
      "[activation-lift] CONVEX_DEPLOY_KEY and CONVEX_DEPLOYMENT env vars required. " +
        "Run with `node --env-file=.env.local` (see file header).",
    );
  }
  const args = new Map(
    argv.map((arg) => {
      const [key, value] = arg.replace(/^--/, "").split("=");
      return [key, value ?? true];
    }),
  );
  const windowDays = parsePositiveNumber(args.get("window-days") ?? 14, "window-days");
  const limit = parsePositiveNumber(args.get("limit") ?? 20_000, "limit");
  const timeoutMs = parsePositiveNumber(
    args.get("timeout-ms") ?? DEFAULT_EXPORT_TIMEOUT_MS,
    "timeout-ms",
  );
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const tableNames = ["proActivationPresentations", ...FEATURE_TABLES];
  const exports = Object.fromEntries(
    tableNames.map((table) => [table, fetchTable(table, { limit, timeoutMs })]),
  );
  const truncatedTables = tableNames.filter((table) => exports[table].truncated);
  const featureRowsByTable = Object.fromEntries(
    FEATURE_TABLES.map((table) => [table, exports[table].rows]),
  );
  const analysisByCohort = analyzeActivationLiftByCohort({
    presentations: exports.proActivationPresentations.rows,
    featureRowsByTable,
    truncatedTables,
    reportNow: Date.now(),
    windowMs,
  });
  return formatActivationLiftReportByCohort(analysisByCohort, { windowDays, limit });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    console.log(runCli());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
