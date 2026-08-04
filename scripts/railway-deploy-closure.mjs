// Which repository changes can actually reach a given Railway service.
//
// One definition, shared by the two sides that must agree (#6142):
//
//   - scripts/trigger-railway-deploys.mjs decides which services a merge has to
//     build, and triggers those builds from CI.
//   - scripts/check-railway-deploy-drift.mjs decides whether a service running
//     an older commit is behind or simply untouched by everything since.
//
// Splitting that judgement across two implementations is how the two surfaces
// drift into disagreeing about the same service, so both import this file.
//
// WHAT THE PRODUCTION RECORD ACTUALLY SHOWS
//
// #6141 read Railway's `SKIPPED` deployments as refusals of pushes that plainly
// matched the watch-path glob. Re-measured across the whole 77-service fleet
// (7,391 path-reason skips, 600 commits of main), that is not what they are:
//
//   7,331  correctly skipped — the commit touches nothing the service watches
//      57  every matched file lies OUTSIDE the service's build context
//       3  the closure was declared in the registry but not yet applied to
//          Railway, so Railway matched against its older, narrower filter
//       0  unexplained
//
// The 57 are the interesting ones and they are the reason `rootDirectory` is
// load-bearing below. A `nixpacks-root-scripts` service is built with the build
// context rooted at scripts/, so scripts/ IS the container — the same
// containment tests/nixpacks-seeder-import-graph.test.mjs enforces on imports.
// A commit that only touches repository-root `shared/` therefore cannot change
// that image no matter what the service's watch patterns say, and the several
// scripts-rooted services that list `shared/**` are asking to be rebuilt for
// files their container has never been able to see. Skipping them is correct,
// and a matcher that ignores the build context reports 57 false rejections.
//
// DIRECTION OF FAILURE
//
// Every uncertain case here resolves to "this change affects the service".
// Over-reporting costs a build; under-reporting silently strands a service on
// old code, which is the failure both callers exist to prevent.

// Railway records a refused push as a deployment whose status is SKIPPED, with
// the reason it refused. The two reasons mean opposite things and must not be
// collapsed: this one is the filter working as configured.
export const NO_MATCHING_PATHS_REASON = 'No changes to watched files';

// ...while this one is a deferral that has nothing to do with paths. Railway
// evaluates the commit's whole GitHub check suite, so a scheduled workflow that
// re-reports a failure onto main's head SHA after the merge — the freshness
// monitor, the security audit, the storage monitor — turns every service's
// deploy into a skip. Measured over 600 commits it is the dominant lag source:
// 1,068 of 6,037 closure-relevant merges, p90 4.7h against p90 0.01h when
// Railway simply builds. It is also self-reinforcing, because the freshness
// monitor goes red precisely when the fleet is behind.
export const CHECK_SUITE_FAILED_REASON = 'CI check suite failed';

/**
 * Compile one Railway watch pattern to a regular expression.
 *
 * `**` spans path separators, `*` and `?` do not. Returns null for shapes this
 * matcher does not implement (negation, brace alternation, character classes),
 * which callers must treat as "assume it matches" rather than "does not match".
 */
export function watchPatternToRegExp(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  if (/[!{}[\]]/.test(pattern)) return null;

  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const compiled = new Map();

function compile(pattern) {
  if (!compiled.has(pattern)) compiled.set(pattern, watchPatternToRegExp(pattern));
  return compiled.get(pattern);
}

/** Strip the leading and trailing slashes Railway tolerates in a root directory. */
export function normalizeRootDirectory(value) {
  return typeof value === 'string' ? value.replace(/^\/+|\/+$/g, '') : '';
}

/** Repository-relative prefix of a service's build context (`''` for the root). */
export function buildContextPrefix(rootDirectory) {
  const normalized = normalizeRootDirectory(rootDirectory);
  return normalized ? `${normalized}/` : '';
}

/**
 * Merge what the repository declares about a service with what Railway is
 * configured to do.
 *
 * `null` patterns mean "no filter — every change in the build context reaches
 * this service", which is Railway's own behaviour for a service with no watch
 * paths and the registry's meaning for an explicitly empty array (umami and the
 * bootstrap publisher both use it deliberately).
 *
 * The two sources are UNIONED rather than one winning, because they can
 * legitimately disagree: the registry is edited in a PR and only reaches
 * Railway when someone runs the audit with --apply, so between those two events
 * each source knows a path the other does not. Three of the fleet's apparent
 * refusals were exactly this window. A union is wrong only in the direction
 * that builds too much.
 */
export function resolveServiceClosure({ registryEntry = null, liveService = null } = {}) {
  const declared = [];
  let watchesEverything = false;
  let opinionated = false;

  // The registry omitting the key entirely is "no opinion" — 30 of its 41
  // entries predate watch-path management and say nothing about triggers. An
  // explicitly empty array is an opinion, and it means "everything".
  if (registryEntry && Object.hasOwn(registryEntry, 'watchPatterns')) {
    opinionated = true;
    const patterns = registryEntry.watchPatterns;
    if (!Array.isArray(patterns) || patterns.length === 0) watchesEverything = true;
    else declared.push(...patterns.filter((pattern) => typeof pattern === 'string'));
  }

  // Railway, by contrast, has no way to say "no opinion": a service either
  // carries a filter or builds on every push.
  if (liveService) {
    opinionated = true;
    const patterns = liveService.build?.watchPatterns;
    if (!Array.isArray(patterns) || patterns.length === 0) watchesEverything = true;
    else declared.push(...patterns.filter((pattern) => typeof pattern === 'string'));
  }

  // A service neither source can describe is one we must not narrow.
  if (!opinionated || (!watchesEverything && declared.length === 0)) watchesEverything = true;

  const rootDirectory = normalizeRootDirectory(
    liveService?.source?.rootDirectory ?? registryEntry?.rootDirectory ?? '',
  );
  return {
    patterns: watchesEverything ? null : [...new Set(declared)].sort(),
    rootDirectory,
  };
}

/**
 * Which of `changedPaths` can reach a service with this closure.
 *
 * Containment is applied before pattern matching and is not negotiable: a file
 * outside the build context is not part of the image, so no watch pattern can
 * make it relevant.
 */
export function pathsReachingService(closure, changedPaths) {
  if (!Array.isArray(changedPaths)) return [];
  const prefix = buildContextPrefix(closure?.rootDirectory);
  const inContext = changedPaths.filter(
    (path) => typeof path === 'string' && path.startsWith(prefix),
  );
  const patterns = closure?.patterns;
  if (patterns == null) return inContext;
  return inContext.filter((path) => patterns.some((pattern) => {
    const expression = compile(pattern);
    // An unsupported pattern shape must not silently narrow the closure.
    return expression === null || expression.test(path);
  }));
}

/** Whether any of `changedPaths` can reach a service with this closure. */
export function changeReachesService(closure, changedPaths) {
  return pathsReachingService(closure, changedPaths).length > 0;
}

/**
 * Memoised reader for "what has changed between the commit a service is running
 * and head", shared so the trigger and the drift check cannot disagree about
 * what a service is missing.
 *
 * `git` runs a git command and returns stdout; it is injected rather than
 * imported so this module stays free of process concerns. Returns null when the
 * checkout cannot reach `fromSha`, which callers must treat as "cannot tell"
 * rather than "nothing changed" — a service can legitimately be running a
 * commit older than the fetch depth, and that is exactly the service most
 * likely to be genuinely behind.
 */
export function createChangedPathsReader(headSha, { git } = {}) {
  if (typeof git !== 'function') throw new TypeError('createChangedPathsReader requires a git runner');
  const cache = new Map();
  return (fromSha) => {
    if (!cache.has(fromSha)) {
      let paths = null;
      try {
        paths = git(['diff', '--name-only', `${fromSha}..${headSha}`]).split('\n').filter(Boolean);
      } catch {
        paths = null;
      }
      cache.set(fromSha, paths);
    }
    return cache.get(fromSha);
  };
}

/**
 * Memoised reader for "what did this one commit change", used to judge a single
 * refusal rather than the whole backlog.
 *
 * `--first-parent` so a merge commit reports the change it brought to main
 * rather than nothing, which is what a bare `git show` prints for a merge.
 */
export function createCommitPathsReader({ git } = {}) {
  if (typeof git !== 'function') throw new TypeError('createCommitPathsReader requires a git runner');
  const cache = new Map();
  return (sha) => {
    if (!cache.has(sha)) {
      let paths = null;
      try {
        paths = git(['show', '--name-only', '--format=', '--first-parent', sha])
          .split('\n')
          .filter(Boolean);
      } catch {
        paths = null;
      }
      cache.set(sha, paths);
    }
    return cache.get(sha);
  };
}

/**
 * Whether a `SKIPPED` deployment record is Railway's filter doing its job.
 *
 * Only the path reason is legitimate, and only when our own matcher agrees that
 * the commit touches nothing the service watches. Anything else — a failed
 * check suite, a reason Railway adds later, a path skip our matcher disputes —
 * is a deferral that leaves the service on old code for a change that was
 * meant for it.
 */
export function isLegitimatePathSkip(deployment, closure, changedPaths) {
  if (deployment?.status !== 'SKIPPED') return false;
  if (deployment?.meta?.skippedReason !== NO_MATCHING_PATHS_REASON) return false;
  // Without the commit's file list we cannot second-guess Railway, and calling
  // it legitimate would excuse the service. Withhold the excuse instead.
  if (!Array.isArray(changedPaths)) return false;
  return !changeReachesService(closure, changedPaths);
}
