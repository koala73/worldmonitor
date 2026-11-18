import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { modules, schema } from "./companyMonitoring.helpers";

const USER = "user_sweep";
const keys = new Set<string>();
const fetchMock = vi.fn<typeof fetch>();
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
      const prefix = String(commands[3]).slice(0, -1);
      return Response.json({ result: ["0", [...keys].filter(key => key.startsWith(prefix))] });
    }
    return Response.json((commands as string[][]).map(command => {
      if (command[0] === "DEL") keys.delete(command[1]);
      return { result: 1 };
    }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
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

test("delayed sweep removes orphan envelopes written after the first index snapshot", async () => {
  const { t, deletionId } = await erase();
  keys.add(`brief:${USER}:late`);
  keys.add(`brief:l10n:${USER}:late`);
  keys.add("brief:user_other:late");
  await vi.advanceTimersByTimeAsync(14 * 60_000);
  await t.finishInProgressScheduledFunctions();
  expect(keys.has(`brief:${USER}:late`)).toBe(true);
  await t.mutation(internal.accountDeletion.erase.markExternalComplete, { deletionId });
  const jobs = await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
  expect(jobs).toHaveLength(1);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect([...keys]).toEqual(["brief:user_other:late"]);
});

test("continues empty SCAN pages and retries a failed DEL without losing its cursor", async () => {
  const { t } = await erase();
  keys.add(`brief:${USER}:late`);
  const normal = fetchMock.getMockImplementation()!;
  const cursors: string[] = [];
  let failed = false;
  fetchMock.mockImplementation(async (input, init) => {
    const command = JSON.parse(String(init?.body));
    if (command[0] === "SCAN" && command[3] === `brief:${USER}:*`) {
      cursors.push(command[1]);
      return Response.json({ result: command[1] === "0"
        ? ["17", []] : ["0", [`brief:${USER}:late`]] });
    }
    if (command[0]?.[0] === "DEL" && !failed) {
      failed = true;
      return Response.json([{ error: "ERR unavailable" }]);
    }
    return normal(input, init);
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(cursors).toEqual(["0", "17", "17"]);
  expect(keys.size).toBe(0);
});

test.each([
  { result: ["0", ["brief:user_other:late"]] },
  { result: ["bad-cursor", []] },
  { error: "ERR unavailable" },
])("rejects invalid SCAN results and stops after the retry budget: %j", async response => {
  const { t, deletionId } = await erase();
  fetchMock.mockReset().mockResolvedValue(Response.json(response));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(t.action(internal.accountDeletion.sideEffects.sweepBriefEnvelopes, {
    deletionId, localized: false, cursor: "0", attempt: 4,
  })).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("account_deletion_brief_sweep_failed"));
  log.mockRestore();
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
      expect(command[3]).toBe('brief:user_\\[a\\]\\*\\?\\\\x:*');
      return Response.json({ result: ["0", envelopes] });
    }
    requests.push(command);
    return Response.json(command.map(() => ({ result: 1 })));
  });
  await t.action(internal.accountDeletion.sideEffects.sweepBriefEnvelopes, {
    deletionId, localized: false, cursor: "0", attempt: 0,
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
    deletionId, localized: true, cursor: "100", attempt: 0, pages: 998,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(scans).toBe(2);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('"breadcrumb":"account_deletion_brief_sweep_truncated"'));
  expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ cursor: "2", localized: true, pages: 1_000 });
  log.mockRestore();
});
