/**
 * Walk a paginated internal Convex query through `npx convex run`.
 *
 * The cross-tenant `alertRules` reads (`getByEnabled`, `getDigestRules`,
 * `listShapeViolations`, ...) are internal (GHSA-r649-4cqj-w93h) and
 * paginated: each call returns `{ page, continueCursor, isDone }` and a page
 * is byte-bounded (4 MiB of rows plus the row that crossed it) so one
 * oversized row cannot push a transaction past the Convex read limit.
 * Operator scripts run them with the deploy key, one `npx convex run` per
 * page.
 *
 * `run` is injectable so the paging loop is unit-testable without a
 * deployment; `command` / `commandArgs` are injectable so the real runner's
 * large-output path is testable with a local process in place of `npx`.
 */
import { spawnSync } from "node:child_process";

// A page can serialize to ~5 MiB (4 MiB byte bound + one 1 MiB row, plus JSON
// escaping). spawnSync's default maxBuffer is 1 MiB and kills the child
// with a truncated stdout, which read as "unparseable output".
export const CONVEX_RUN_MAX_BUFFER = 64 * 1024 * 1024;

export function runConvexFunction(fn, args, {
  env = process.env,
  extraArgs = [],
  timeoutMs = 60_000,
  command = "npx",
  commandArgs = ["convex", "run"],
} = {}) {
  const result = spawnSync(
    command,
    [...commandArgs, ...extraArgs, fn, JSON.stringify(args)],
    { env, encoding: "utf-8", timeout: timeoutMs, maxBuffer: CONVEX_RUN_MAX_BUFFER },
  );
  if (result.error) {
    throw new Error(`${fn} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" | ");
    throw new Error(`${fn} failed (exit ${result.status})${tail ? `: ${tail}` : ""}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    const tail = (result.stdout || "").trim().split("\n").slice(-5).join(" | ");
    throw new Error(`${fn} returned unparseable output: ${tail}`);
  }
}

/**
 * Returns every page's result in order. `onPage(result, index)` runs after each
 * page so callers can stream progress or tally side data (row counts).
 */
export function collectConvexPages(fn, baseArgs = {}, { run = runConvexFunction, onPage, maxPages = 10_000, ...runOptions } = {}) {
  const pages = [];
  let cursor = null;
  for (let index = 0; index < maxPages; index++) {
    const result = run(fn, { ...baseArgs, cursor }, runOptions);
    if (!result || !Array.isArray(result.page) || typeof result.isDone !== "boolean") {
      throw new Error(`${fn} did not return a page ({ page, continueCursor, isDone })`);
    }
    pages.push(result);
    if (onPage) onPage(result, index);
    if (result.isDone) return pages;
    if (typeof result.continueCursor !== "string") {
      throw new Error(`${fn} page ${index} is not done but carries no continueCursor`);
    }
    cursor = result.continueCursor;
  }
  throw new Error(`${fn} did not finish within ${maxPages} pages`);
}

/** Flattens every page's rows. */
export function collectConvexRows(fn, baseArgs = {}, options = {}) {
  return collectConvexPages(fn, baseArgs, options).flatMap((result) => result.page);
}
