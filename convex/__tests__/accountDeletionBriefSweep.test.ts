import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { sweepBriefEnvelopes } from "../accountDeletion/sideEffects";
import { modules, schema } from "./companyMonitoring.helpers";

const USER = "user_sweep";
const keys = new Set<string>();
const fetchMock = vi.fn<typeof fetch>();
/** Redis MATCH glob (with backslash escapes) as a RegExp. */
function globRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "\\") source += glob[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "*") source += ".*";
    else if (c === "?") source += ".";
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
beforeEach(() => {
  vi.useFakeTimers();
  keys.clear();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.test");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test");
  vi.stubEnv("CLERK_SECRET_KEY", "test");
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.clerk.com") return new Response(null, { status: 204 });
    if (url.pathname.startsWith("/get/")) return Response.json({ result: null });
    if (url.pathname.startsWith("/zrange/")) return Response.json({ result: ["late"] });
    const commands = JSON.parse(String(init?.body)) as string[] | string[][];
    if (commands[0] === "SCAN") {
      const match = globRegExp(String(commands[3]));
      return Response.json({ result: ["0", [...keys].filter(key => match.test(key))] });
    }
    return Response.json((commands as string[][]).map(command => {
      if (command[0] === "DEL") keys.delete(command[1]);
      return { result: 1 };
    }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function erase() {
  const t = convexTest(schema, modules);
  const deletionId = await t.run(ctx => ctx.db.insert("accountDeletions", {
    userId: USER, userIdHash: "hash", source: "self", status: "pending", step: "external",
    startedAt: Date.now(), updatedAt: Date.now(),
  }));
  expect(await t.action(internal.accountDeletion.sideEffects.runExternalErase, { deletionId }))
    .toEqual({ status: "complete" });
  return { t, deletionId };
}

test("delayed sweep removes orphan envelopes, slot index and pointer written after the first index snapshot", async () => {
  const { t, deletionId } = await erase();
  keys.add(`brief:${USER}:late`);
  keys.add(`brief:l10n:${USER}:late`);
  keys.add(`brief:slots:${USER}`);
  keys.add(`brief:latest:${USER}`);
  keys.add(`brief:erased:${USER}`);
  keys.add(`brief:${USER}x:late`);
  keys.add("brief:user_other:late");
  await vi.advanceTimersByTimeAsync(14 * 60_000);
  await t.finishInProgressScheduledFunctions();
  expect(keys.has(`brief:${USER}:late`)).toBe(true);
  await t.mutation(internal.accountDeletion.erase.markExternalComplete, { deletionId });
  const jobs = await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
  expect(jobs).toHaveLength(1);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  // The erase tombstone outlives the sweep on purpose: a compose still running
  // reads it to remove its own brief. Another account sharing the id prefix
  // keeps its envelope.
  expect([...keys].sort()).toEqual([`brief:erased:${USER}`, `brief:${USER}x:late`, "brief:user_other:late"].sort());
});

test("one pass covers the whole account on a keyspace larger than half the page budget", async () => {
  const { t } = await erase();
  // Production holds ~580k keys: ~580 SCAN pages at COUNT 1000. A sweep that
  // scans the keyspace once per namespace needs ~1,160 pages and truncates.
  const PAGES = 520;
  const keyspace: string[][] = Array.from({ length: PAGES }, (_, i) => [`cache:${i}`]);
  keyspace[PAGES - 1]!.push(`brief:${USER}:late`, `brief:l10n:${USER}:late`,
    `brief:slots:${USER}`, `brief:latest:${USER}`, `brief:erased:${USER}`, "brief:user_other:late");
  const normal = fetchMock.getMockImplementation()!;
  let scans = 0;
  fetchMock.mockImplementation(async (input, init) => {
    const command = JSON.parse(String(init?.body));
    if (command[0] === "SCAN") {
      scans++;
      const index = Number(command[1]);
      const match = globRegExp(String(command[3]));
      const next = index + 1 >= PAGES ? "0" : String(index + 1);
      return Response.json({ result: [next, keyspace[index]!.filter(key => match.test(key))] });
    }
    if (command[0]?.[0] === "DEL") {
      for (const [, key] of command) for (const page of keyspace) {
        const at = page.indexOf(key);
        if (at >= 0) page.splice(at, 1);
      }
    }
    return normal(input, init);
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await t.finishAllScheduledFunctions(vi.runAllTimers, 2 * PAGES + 10);
  expect(log).not.toHaveBeenCalledWith(expect.stringContaining("account_deletion_brief_sweep_truncated"));
  log.mockRestore();
  expect(scans).toBe(PAGES);
  expect(keyspace[PAGES - 1]!.filter(key => key.startsWith("brief:")).sort())
    .toEqual([`brief:erased:${USER}`, "brief:user_other:late"]);
  // ~520 scheduled actions: seconds on a loaded runner, above the 5 s default.
}, 30_000);

test("continues empty SCAN pages and retains failed deletes without rescanning", async () => {
  const { t } = await erase();
  keys.add(`brief:${USER}:late`);
  const normal = fetchMock.getMockImplementation()!;
  const cursors: string[] = [];
  let failed = false;
  fetchMock.mockImplementation(async (input, init) => {
    const command = JSON.parse(String(init?.body));
    if (command[0] === "SCAN") {
      cursors.push(command[1]);
      return Response.json({ result: command[1] === "0"
        ? ["17", []] : ["0", cursors.length === 2 ? [`brief:${USER}:late`] : []] });
    }
    if (command[0]?.[0] === "DEL" && !failed) {
      failed = true;
      return Response.json([{ error: "ERR unavailable" }]);
    }
    return normal(input, init);
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(keys.size).toBe(0);
  expect(cursors).toEqual(["0", "17"]);
});

test.each([
  { result: ["0", ["cache:unrelated"]] },
  { result: ["bad-cursor", []] },
  { error: "ERR unavailable" },
])("rejects invalid SCAN results and stops after the retry budget: %j", async response => {
  const { t, deletionId } = await erase();
  fetchMock.mockReset().mockResolvedValue(Response.json(response));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(t.action(internal.accountDeletion.sideEffects.sweepBriefEnvelopes, {
    deletionId, cursor: "0", attempt: 4,
  })).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("account_deletion_brief_sweep_failed"));
  log.mockRestore();
});

test("a persistent SCAN failure retries from attempt 0 through the budget, then reports once", async () => {
  const t = convexTest(schema, modules);
  const deletionId = await t.run(ctx => ctx.db.insert("accountDeletions", {
    userId: USER, userIdHash: "hash", source: "self", status: "complete", step: "complete",
    startedAt: Date.now(), updatedAt: Date.now(),
  }));
  fetchMock.mockReset().mockImplementation(async () => Response.json({ error: "ERR unavailable" }));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await t.action(internal.accountDeletion.sideEffects.sweepBriefEnvelopes, {
    deletionId, cursor: "0", attempt: 0,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(fetchMock).toHaveBeenCalledTimes(5);
  const failures = log.mock.calls.filter(([line]) => String(line).includes("account_deletion_brief_sweep_failed"));
  expect(failures).toHaveLength(1);
  log.mockRestore();
});

test("reports the failure with a resumable cursor when the retry cannot be scheduled", async () => {
  fetchMock.mockReset().mockImplementation(async () => Response.json({ error: "ERR unavailable" }));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const ctx = {
    runQuery: async () => ({ userId: USER }),
    scheduler: { runAfter: async () => { throw new Error("SCHEDULER_UNAVAILABLE"); } },
  };
  const handler = (sweepBriefEnvelopes as unknown as {
    _handler: (ctx: unknown, args: unknown) => Promise<null>;
  })._handler;
  await expect(handler(ctx, { deletionId: "id", cursor: "42", attempt: 0, pages: 7 }))
    .rejects.toThrow("SCHEDULER_UNAVAILABLE");
  const failure = log.mock.calls.map(([line]) => String(line))
    .find(line => line.includes("account_deletion_brief_sweep_failed"));
  expect(JSON.parse(failure!)).toMatchObject({ deletionId: "id", cursor: "42", pages: 7 });
  log.mockRestore();
});

test("logs the page's own cursor, not the next one, when a partial delete fails and the retry cannot be scheduled", async () => {
  const envelopes = Array.from({ length: 101 }, (_, i) => `brief:${USER}:${i}`);
  const scans: string[][] = [];
  const pipelines: string[][][] = [];
  fetchMock.mockReset().mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as string[] | string[][];
    if (body[0] === "SCAN") {
      scans.push(body as string[]);
      return Response.json({ result: ["84", envelopes] });
    }
    const pipeline = body as string[][];
    pipelines.push(pipeline);
    return Response.json(pipelines.length === 1
      ? pipeline.map(() => ({ result: 1 })) : [{ error: "ERR unavailable" }]);
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const scheduled: unknown[] = [];
  const ctx = {
    runQuery: async () => ({ userId: USER }),
    scheduler: { runAfter: async (_delay: number, _fn: unknown, args: unknown) => {
      scheduled.push(args);
      throw new Error("SCHEDULER_UNAVAILABLE");
    } },
  };
  const handler = (sweepBriefEnvelopes as unknown as {
    _handler: (ctx: unknown, args: unknown) => Promise<null>;
  })._handler;
  await expect(handler(ctx, { deletionId: "id", cursor: "42", attempt: 0 }))
    .rejects.toThrow("SCHEDULER_UNAVAILABLE");
  expect(scans.map(scan => scan[1])).toEqual(["42"]);
  expect(pipelines).toEqual([
    envelopes.slice(0, 100).map(key => ["DEL", key]),
    [["DEL", envelopes[100]]],
  ]);
  const failure = log.mock.calls.map(([line]) => String(line))
    .find(line => line.includes("account_deletion_brief_sweep_failed"));
  expect(JSON.parse(failure!)).toMatchObject({ cursor: "42" });
  // The failed DEL schedules a retry of this page, never the next page.
  expect(scheduled).toEqual([expect.objectContaining({
    cursor: "42", attempt: 1, page: { cursor: "84", keys: envelopes },
  })]);
});

test("escapes glob characters in the account identity and bounds delete batches", async () => {
  const { t, deletionId } = await erase();
  const userId = "user_[a]*?\\x";
  await t.run(ctx => ctx.db.patch(deletionId, { userId }));
  const envelopes = Array.from({ length: 205 }, (_, i) => `brief:${userId}:${i}`);
  const requests: string[][][] = [];
  fetchMock.mockImplementation(async (_input, init) => {
    const command = JSON.parse(String(init?.body));
    if (command[0] === "SCAN") {
      expect(command[3]).toBe('brief:*user_\\[a\\]\\*\\?\\\\x*');
      return Response.json({ result: ["0", envelopes] });
    }
    requests.push(command);
    return Response.json(command.map(() => ({ result: 1 })));
  });
  await t.action(internal.accountDeletion.sideEffects.sweepBriefEnvelopes, {
    deletionId, cursor: "0", attempt: 0,
  });
  expect(requests.map(batch => batch.length)).toEqual([100, 100, 5]);
  expect(requests.flat().map(command => command[1])).toEqual(envelopes);
});

test.each(["pending", "failed"] as const)("billing cleanup reopening as %s does not abandon the scheduled sweep", async status => {
  const { t, deletionId } = await erase();
  keys.add(`brief:${USER}:late`);
  keys.add(`brief:l10n:${USER}:late`);
  await t.run(ctx => ctx.db.patch(deletionId, { status, step: "external", completedAt: undefined }));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(keys.size).toBe(0);
});

test("stops at the total page budget and reports a resumable cursor", async () => {
  const t = convexTest(schema, modules);
  const deletionId = await t.run(ctx => ctx.db.insert("accountDeletions", {
    userId: USER, userIdHash: "hash", source: "self", status: "complete", step: "complete",
    startedAt: Date.now(), updatedAt: Date.now(),
  }));
  let scans = 0;
  fetchMock.mockImplementation(async () => {
    scans++;
    return Response.json({ result: [String(scans), []] });
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await t.action(internal.accountDeletion.sideEffects.sweepBriefEnvelopes, {
    deletionId, cursor: "100", attempt: 0, pages: 998,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(scans).toBe(2);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('"breadcrumb":"account_deletion_brief_sweep_truncated"'));
  expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ cursor: "2", pages: 1_000 });
  log.mockRestore();
});
