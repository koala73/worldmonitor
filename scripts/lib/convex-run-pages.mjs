/**
 * Walk a paginated internal Convex query through `npx convex run`.
 *
 * The cross-tenant `alertRules` reads (`getByEnabled`, `getDigestRules`,
 * `getBriefOnlyUsers`, `listShapeViolations`) are internal (GHSA-r649-4cqj-w93h)
 * and paginated: each call returns `{ page, continueCursor, isDone }` and a page
 * is byte-bounded so one oversized row cannot push a transaction past the
 * Convex read limit. Operator scripts run them with the deploy key, one
 * `npx convex run` per page.
 *
 * `run` is injectable so the loop is unit-testable without a deployment.
 */
import { spawnSync } from "node:child_process";

export function runConvexFunction(fn, args, { env = process.env, extraArgs = [], timeoutMs = 60_000 } = {}) {
  const result = spawnSync(
    "npx",
    ["convex", "run", ...extraArgs, fn, JSON.stringify(args)],
    { env, encoding: "utf-8", timeout: timeoutMs },
  );
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
