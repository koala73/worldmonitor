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
// WHY rootDirectory IS LOAD-BEARING BELOW
//
// #6141 read Railway's `SKIPPED` deployments as refusals of pushes that plainly
// matched the watch-path glob. Re-measured fleet-wide it is not: 57 of the 60
// apparent refusals matched a pattern whose every matched file lay OUTSIDE the
// service's build context. A `nixpacks-root-scripts` service is built with the
// context rooted at scripts/, so scripts/ IS the container — the same
// containment tests/nixpacks-seeder-import-graph.test.mjs enforces on imports —
// and a commit touching only repository-root `shared/` cannot change that image
// however the watch patterns read. A matcher that ignores the build context
// reports those 57 as false rejections.
//
// The full measurement and its methodology live in
// docs/solutions/integration-issues/railway-seeder-watch-paths-can-skip-deployments.md,
// which is the one place they are maintained.
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
// deploy into a skip. It is the dominant lag source, and self-reinforcing: the
// freshness monitor goes red precisely when the fleet is behind. Numbers in the
// solutions document named above.
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

  // Railway's own documentation writes watch paths rooted at the repository as
  // `/src/**` and `/*.go`. Repository-relative paths carry no leading slash, so
  // compiling that shape literally produces a regex that can never match — a
  // closure silently narrowed to nothing, which is the one direction this
  // module must never fail in. Strip it instead. Same for a `./` prefix.
  const normalized = pattern.replace(/^\.?\/+/, '');
  if (normalized.length === 0) return null;

  // Compiled per PATH SEGMENT, not per character. `**` means "zero or more
  // segments", and a character-wise compiler cannot express the zero case: it
  // turns `scripts/**/*.mjs` into `scripts/.*/[^/]*\.mjs`, whose literal `/`
  // around the `.*` demands at least one intervening directory. That pattern
  // then silently stops matching `scripts/seed-foo.mjs` — a closure narrowed by
  // the compiler rather than by anything the service declared, which is the one
  // direction this module must never fail in.
  const segments = normalized.split('/');
  let source = '';
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;
    if (segment === '**') {
      // Trailing `**` (the fleet's common `scripts/**`) is everything below.
      // Interior `**/` swallows its own separator so it can also match nothing.
      source += isLast ? '.+' : '(?:[^/]+/)*';
      continue;
    }
    for (const char of segment) {
      if (char === '*') source += '[^/]*';
      else if (char === '?') source += '[^/]';
      else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    if (!isLast) source += '/';
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

// Where each registry deployMode roots its build context. Mirrors the map
// audit-railway-watch-paths.mjs enforces against live Railway config; kept here
// rather than imported so this module stays dependency-free, and pinned to that
// map by a test so the two cannot drift.
export const ROOT_DIRECTORY_BY_DEPLOY_MODE = Object.freeze({
  'nixpacks-root-scripts': 'scripts',
  'nixpacks-root-repo': '',
  dockerfile: '',
});

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

  // Live config first, because that is what Railway actually builds from. The
  // registry expresses the same thing as `deployMode`, never as a
  // `rootDirectory` key — reading one would be a branch that can never fire and
  // would leave a registry-only service silently rooted at the repository, i.e.
  // with containment switched off.
  const rootDirectory = normalizeRootDirectory(
    liveService?.source?.rootDirectory
      ?? ROOT_DIRECTORY_BY_DEPLOY_MODE[registryEntry?.deployMode]
      ?? '',
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
 *
 * `--no-renames` is load-bearing, not tidiness. Rename detection is on by
 * default (git >= 2.9) and makes `--name-only` print ONLY a renamed file's
 * DESTINATION path. A service whose closure names the old path exactly — which
 * is most of the exact closures in the registry — would then not see the change
 * at all and would sit on stale code, which is the precise failure this module
 * exists to prevent. Verified against 3abc27af9: with detection on, the old
 * path drops out of the change set entirely.
 */
export function createChangedPathsReader(headSha, { git } = {}) {
  if (typeof git !== 'function') throw new TypeError('createChangedPathsReader requires a git runner');
  const cache = new Map();
  return (fromSha) => {
    if (!cache.has(fromSha)) {
      let paths = null;
      try {
        paths = git(['diff', '--name-only', '--no-renames', `${fromSha}..${headSha}`])
          .split('\n')
          .filter(Boolean);
      } catch {
        paths = null;
      }
      cache.set(fromSha, paths);
    }
    return cache.get(fromSha);
  };
}

/**
 * Tri-state ancestry: is `ancestor` an ancestor of (or equal to) `descendant`?
 *
 * Returns `'yes'`, `'no'`, or `'unknown'`. The third value is the point.
 * `git merge-base --is-ancestor` exits 1 for a definitive NO and 128 when an
 * object is missing, and collapsing those two into `false` loses exactly the
 * distinction a deploy decision turns on:
 *
 *   - `'no'`  — proven not an ancestor. Safe to reason about.
 *   - `'unknown'` — the commit is not in this checkout, so we cannot prove the
 *     service is not already running something NEWER than the head we read.
 *     Deploying head there would roll production BACKWARDS. Railway builds a
 *     merge in seconds, so a commit that landed after checkout and was built
 *     immediately is the ordinary case, not a corner one.
 *
 * `fetchMissing` is given one chance to obtain an unknown commit before the
 * answer is settled — "fetch more history" is a better response to `'unknown'`
 * than either guess.
 */
export function createAncestryResolver({ git, fetchMissing = null } = {}) {
  if (typeof git !== 'function') throw new TypeError('createAncestryResolver requires a git runner');
  const cache = new Map();
  const fetched = new Set();

  const probe = (ancestor, descendant) => {
    try {
      git(['merge-base', '--is-ancestor', ancestor, descendant]);
      return 'yes';
    } catch (error) {
      // Only a clean exit 1 is a definitive "no". Anything else — a missing
      // object (128), a timeout, a broken repository — is "we could not tell".
      return error?.status === 1 ? 'no' : 'unknown';
    }
  };

  return (ancestor, descendant) => {
    const key = `${ancestor}..${descendant}`;
    if (cache.has(key)) return cache.get(key);
    let answer = probe(ancestor, descendant);
    if (answer === 'unknown' && fetchMissing) {
      for (const sha of [ancestor, descendant]) {
        if (fetched.has(sha)) continue;
        fetched.add(sha);
        try {
          fetchMissing(sha);
        } catch {
          // Best effort. A fetch that fails leaves the answer unknown, which is
          // the safe value.
        }
      }
      answer = probe(ancestor, descendant);
    }
    cache.set(key, answer);
    return answer;
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
        // --no-renames for the same reason as above: a renamed file's old path
        // must stay in the set, or a closure that names it stops matching.
        paths = git(['show', '--name-only', '--format=', '--first-parent', '--no-renames', sha])
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
