import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeActivationLift,
  fetchTable,
  formatActivationLiftReport,
  indexFeatureRows,
  runCli,
} from "../scripts/report-activation-lift.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 25);
const WINDOW_MS = 14 * DAY_MS;

function emptyFeatureRows() {
  return {
    notificationChannels: [],
    alertRules: [],
    userApiKeys: [],
    mcpProTokens: [],
  };
}

test("CLI points operators at Node's dotenv loader when credentials are absent", () => {
  assert.throws(
    () => runCli([], {}),
    /node --env-file=\.env\.local/,
  );
});

test("fetchTable bounds a hung Convex export and reports the table", () => {
  const timeout = Object.assign(new Error("spawnSync npx ETIMEDOUT"), { code: "ETIMEDOUT" });
  assert.throws(
    () => fetchTable("alertRules", {
      limit: 20_000,
      timeoutMs: 1234,
      runner: () => ({
        error: timeout,
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
      }),
    }),
    /alertRules timed out after 1234ms/,
  );
});

test("fetchTable marks a cap hit instead of treating a newest-first slice as complete", () => {
  const result = fetchTable("userApiKeys", {
    limit: 2,
    runner: () => ({
      status: 0,
      signal: null,
      stdout: '{"userId":"a"}\n{"userId":"b"}\n',
      stderr: "",
    }),
  });
  assert.equal(result.truncated, true);
  assert.equal(result.rows.length, 2);
});

test("analysis uses only mature presentations and table-specific adoption timestamps", () => {
  const observationStartedAt = NOW - WINDOW_MS;
  const presentedBeforeExit = observationStartedAt - DAY_MS;
  const presentations = [
    {
      userId: "engaged",
      presentedAt: presentedBeforeExit,
      outcomeTrackingVersion: 1,
      confirmedSteps: ["brief"],
      exitedAt: observationStartedAt,
    },
    {
      userId: "presented-only",
      presentedAt: observationStartedAt,
      outcomeTrackingVersion: 1,
      confirmedSteps: [],
      // Deliberately no exitedAt: lost exits stay in the cohort.
    },
    {
      userId: "immature",
      presentedAt: NOW - WINDOW_MS + 1,
      outcomeTrackingVersion: 1,
      confirmedSteps: ["brief"],
    },
    {
      userId: "progress-immature",
      presentedAt: presentedBeforeExit,
      outcomeTrackingVersion: 1,
      confirmedSteps: ["brief"],
      outcomeUpdatedAt: NOW - WINDOW_MS + 1,
    },
    {
      userId: "legacy-pre-instrumentation",
      presentedAt: presentedBeforeExit,
      confirmedSteps: [],
    },
  ];
  const featureRowsByTable = {
    ...emptyFeatureRows(),
    notificationChannels: [
      {
        userId: "engaged",
        verified: true,
        // Existing row re-verified at the inclusive end boundary.
        linkedAt: observationStartedAt + WINDOW_MS,
        _creationTime: observationStartedAt - 100 * DAY_MS,
      },
      {
        userId: "presented-only",
        verified: false,
        linkedAt: observationStartedAt + DAY_MS,
      },
    ],
    alertRules: [
      {
        userId: "presented-only",
        enabled: true,
        // Existing rule updated just outside the observation window.
        updatedAt: observationStartedAt + WINDOW_MS + 1,
        _creationTime: observationStartedAt - 100 * DAY_MS,
      },
    ],
    userApiKeys: [
      {
        userId: "engaged",
        // A row created inside the wizard, before exit, is not downstream adoption.
        createdAt: presentedBeforeExit + 1,
      },
    ],
  };

  const analysis = analyzeActivationLift({
    presentations,
    featureRowsByTable,
    reportNow: NOW,
    windowMs: WINDOW_MS,
    minGroupSize: 1,
  });

  assert.equal(analysis.verdict, "comparison");
  assert.equal(analysis.totalPresentations, 5);
  assert.equal(analysis.uninstrumented, 1);
  assert.equal(analysis.mature, 2);
  assert.equal(analysis.immature, 2);
  assert.equal(analysis.incompleteExits, 1);
  assert.deepEqual(analysis.engaged, {
    n: 1,
    anyCount: 1,
    rate: 1,
    perTable: {
      notificationChannels: 1,
      alertRules: 0,
      userApiKeys: 0,
      mcpProTokens: 0,
    },
  });
  assert.equal(analysis.presentedOnly.anyCount, 0);
  assert.equal(analysis.lift, 1);
});

test("analysis reports no-mature-outcomes when every presentation is still within its observation window", () => {
  const presentations = [
    {
      userId: "too-recent-1",
      // One ms short of maturing: observationStartedAt + windowMs > reportNow.
      presentedAt: NOW - WINDOW_MS + 1,
      outcomeTrackingVersion: 1,
      confirmedSteps: ["brief"],
    },
    {
      userId: "too-recent-2",
      presentedAt: NOW,
      outcomeTrackingVersion: 1,
      confirmedSteps: [],
    },
  ];

  const analysis = analyzeActivationLift({
    presentations,
    featureRowsByTable: emptyFeatureRows(),
    reportNow: NOW,
    windowMs: WINDOW_MS,
  });

  assert.equal(analysis.verdict, "no-mature-outcomes");
  assert.equal(analysis.mature, 0);
  assert.equal(analysis.immature, 2);
  const emptyGroup = {
    n: 0,
    anyCount: 0,
    rate: 0,
    perTable: { notificationChannels: 0, alertRules: 0, userApiKeys: 0, mcpProTokens: 0 },
  };
  assert.deepEqual(analysis.engaged, emptyGroup);
  assert.deepEqual(analysis.presentedOnly, emptyGroup);

  assert.match(
    formatActivationLiftReport(analysis, { windowDays: 14, limit: 20_000 }),
    /No presentations have completed the full 14-day observation window yet\./,
  );
});

test("analysis refuses capped exports before rates and enforces the mature sample floor", () => {
  const presentations = Array.from({ length: 59 }, (_, index) => ({
    userId: `user-${index}`,
    presentedAt: NOW - WINDOW_MS,
    outcomeTrackingVersion: 1,
    confirmedSteps: index < 29 ? ["brief"] : [],
  }));

  const capped = analyzeActivationLift({
    presentations,
    featureRowsByTable: emptyFeatureRows(),
    truncatedTables: ["alertRules"],
    reportNow: NOW,
    windowMs: WINDOW_MS,
  });
  assert.equal(capped.verdict, "incomplete-export");
  assert.equal(capped.engaged, null);
  assert.match(
    formatActivationLiftReport(capped, { windowDays: 14, limit: 20_000 }),
    /Inconclusive.*alertRules.*no adoption rates were computed/s,
  );

  const complete = analyzeActivationLift({
    presentations,
    featureRowsByTable: emptyFeatureRows(),
    reportNow: NOW,
    windowMs: WINDOW_MS,
  });
  assert.equal(complete.engaged.n, 29);
  assert.equal(complete.presentedOnly.n, 30);
  assert.equal(complete.verdict, "below-sample-floor");
});

test("feature indexing performs one pass and excludes inactive credentials", () => {
  const featureRows = emptyFeatureRows();
  featureRows.userApiKeys = Array.from({ length: 20_000 }, (_, index) => ({
    userId: `user-${index}`,
    createdAt: index,
    ...(index % 2 === 0 ? {} : { revokedAt: index + 1 }),
  }));
  const index = indexFeatureRows(featureRows);
  assert.deepEqual(index.userApiKeys.get("user-0"), [0]);
  assert.equal(index.userApiKeys.has("user-1"), false);
  assert.equal(index.userApiKeys.size, 10_000);
});

// #5617. Before the blockedSteps bucket existed, a browser-refused step was
// byte-identical to a voluntary skip in this table, so this report could not
// produce a denial count at all. The cohort matters because a denial is a
// permanent dead end -- the browser never re-prompts once permission is
// `denied` -- so it is exactly the population for whom re-prompting is worth
// nothing.
test("push-denial cohort is sized, and clients that could not report are excluded from the rate", () => {
  const observationStartedAt = NOW - WINDOW_MS;
  const presentations = [
    {
      userId: "denied",
      presentedAt: observationStartedAt,
      outcomeTrackingVersion: 1,
      confirmedSteps: ["brief"],
      skippedSteps: [],
      blockedSteps: ["alerts"],
      exitedAt: observationStartedAt,
    },
    {
      userId: "looked-and-found-none",
      presentedAt: observationStartedAt,
      outcomeTrackingVersion: 1,
      confirmedSteps: ["brief"],
      skippedSteps: ["alerts"],
      blockedSteps: [],
      exitedAt: observationStartedAt,
    },
    {
      // Written by a client too old to know the bucket: absent, not empty.
      // Counting it as "no denial" would silently deflate the rate.
      userId: "could-not-report",
      presentedAt: observationStartedAt,
      outcomeTrackingVersion: 1,
      confirmedSteps: [],
      skippedSteps: ["alerts"],
      exitedAt: observationStartedAt,
    },
  ];

  const analysis = analyzeActivationLift({
    presentations,
    featureRowsByTable: emptyFeatureRows(),
    reportNow: NOW,
    windowMs: WINDOW_MS,
    minGroupSize: 1,
  });

  assert.deepEqual(analysis.pushDenial, {
    observable: 2,
    denied: 1,
    unreportable: 1,
    rate: 0.5,
  });
});

test("push-denial rate is null rather than 0 when no row can testify", () => {
  const observationStartedAt = NOW - WINDOW_MS;
  const analysis = analyzeActivationLift({
    presentations: [
      {
        userId: "legacy-only",
        presentedAt: observationStartedAt,
        outcomeTrackingVersion: 1,
        confirmedSteps: [],
        exitedAt: observationStartedAt,
      },
    ],
    featureRowsByTable: emptyFeatureRows(),
    reportNow: NOW,
    windowMs: WINDOW_MS,
    minGroupSize: 1,
  });

  // A 0% denial rate and "nobody could tell us" are different claims.
  assert.equal(analysis.pushDenial.rate, null);
  assert.equal(analysis.pushDenial.observable, 0);
  assert.equal(analysis.pushDenial.unreportable, 1);
});
