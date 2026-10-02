#!/usr/bin/env -S npx tsx

// CRI golden output baseline (issue #7728).
//
// `tests/five-factor-scorecard-cri-isolation.test.mts` compares CRI output
// before/after scorecard fields with the SAME live scorer on both sides, so it
// cannot detect a CRI scorer change (both sides move together). This module is
// the independent half of that proof: a committed golden artifact holding the
// exact country-score and ranking bytes one accepted `main` commit produced.
// `tests/resilience-cri-golden-baseline.test.mts` recomputes the same frozen
// harness live and demands byte-identity against the committed artifact, so any
// CRI methodology change fails until the baseline is intentionally regenerated.
//
// This module exports the frozen harness (clock, reader, byte computation) so
// the generator and the test share one implementation and cannot drift apart.
// The CLI entry (guarded main below) writes the artifact. Rationale, artifact
// fields, and the regeneration flows:
// docs/methodology/country-resilience-index/golden-baseline.md
//
//   npm run freeze:resilience-cri-golden
//
// Run it from an up-to-date accepted `main` checkout, or — when regenerating as
// part of the PR that makes an intentional CRI methodology change — on that
// branch with --allow-non-main (the recorded acceptedSourceCommit becomes the
// accepted commit on merge). --allow-dirty-fixture separately overrides the
// working-tree dirtiness gate; both guards refuse by default.
//
// The artifact records the accepted source commit, the CRI cache identity
// (formula tag + score cache prefix), the frozen clock, the frozen feature
// flags, and the input-fixture identity. Regenerate it only for an intentional
// CRI methodology change; never to make a failing test pass. The artifact is a
// pure function of (accepted commit, input fixture, scorer, frozen harness
// constants) — it carries no wall-clock timestamp — so regenerating on the
// same commit is a git no-op.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import wholeIndexFixture from '../tests/fixtures/resilience-whole-index-pairs-2026-08-13.json' with { type: 'json' };
import {
  scoreAllDimensions,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import {
  RESILIENCE_HISTORY_KEY_PREFIX,
  RESILIENCE_SCHEMA_V2_ENABLED,
  RESILIENCE_SCORE_CACHE_PREFIX,
  buildDimensionList,
  buildDomainList,
  getCurrentCacheFormula,
  penalizedPillarScore,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import { buildPillarList } from '../server/worldmonitor/resilience/v1/_pillar-membership.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const INPUT_FIXTURE_RELATIVE_PATH =
  'tests/fixtures/resilience-whole-index-pairs-2026-08-13.json';
const GOLDEN_ARTIFACT_RELATIVE_PATH =
  'tests/fixtures/resilience-cri-golden-baseline-2026-08-13.json';
const REGENERATION_COMMAND = 'npm run freeze:resilience-cri-golden';

// Same fixed flag configuration as the five-factor CRI isolation test: this is
// the frozen #6441 comparison configuration (pillar-combined formula, education
// serialized, fin-sys-exposure and energy-v2 dark). These four are the only
// DYNAMIC (read-per-call) RESILIENCE_* env reads in the scoring path, so pinning
// them pins the flag-dependent byte behavior. One more RESILIENCE_* read exists
// but is different in kind: RESILIENCE_SCHEMA_V2_ENABLED is captured at
// _shared.ts module load (before any env pinning can apply), so it cannot be
// pinned here — assertFrozenScorerDefaults() below fails fast on it instead.
export const GOLDEN_ENV_FLAGS: Readonly<Record<string, string>> = {
  RESILIENCE_EDUCATION_ENABLED: 'true',
  RESILIENCE_FIN_SYS_EXPOSURE_ENABLED: 'false',
  RESILIENCE_PILLAR_COMBINE_ENABLED: 'true',
  RESILIENCE_ENERGY_V2_ENABLED: 'false',
};

// Fail fast when the ambient environment captured the module-load
// RESILIENCE_SCHEMA_V2_ENABLED const as false. The golden bytes do not depend
// on that const (the byte-path scorers never read it), but the recorded formula
// tag does: an ambient `false` makes getCurrentCacheFormula() report 'd6' and
// turns the golden test's formula assertion into a wrong-advice "regenerate"
// failure. Requiring the default 'true' keeps generation and comparison on one
// deterministic interpretation. Called before any scoring runs.
export function assertFrozenScorerDefaults(): void {
  if (!RESILIENCE_SCHEMA_V2_ENABLED) {
    throw new Error(
      'RESILIENCE_SCHEMA_V2_ENABLED was captured as false from the ambient environment. ' +
        'The golden CRI harness requires the default (unset RESILIENCE_SCHEMA_V2_ENABLED in your shell or CI); ' +
        'unset it and re-run.',
    );
  }
}

// The wall clock is pinned to the same instant the isolation test pins the
// frozen seed-meta fetchedAt to, so seed-meta staleness preflights, cyber
// discovery decay, and the year-based certainty derates (education attainment,
// import-HHI) all compare against one fixed instant instead of the running
// wall clock. Without this the golden bytes would drift as time passes even
// with an unchanged scorer.
export const FROZEN_CLOCK_ISO = '2026-08-29T00:00:00.000Z';
const FROZEN_NOW_MS = Date.parse(FROZEN_CLOCK_ISO);

const RealDate = globalThis.Date;

// Subclass so `new Date()` (no args) reads the frozen instant while
// `new Date(value)` passthroughs keep working; static inheritance keeps
// `Date.parse` and friends on the frozen constructor too.
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) {
      super(FROZEN_NOW_MS);
      return;
    }
    if (args.length === 1) {
      super(args[0] as string | number | Date);
      return;
    }
    super(
      args[0] as number,
      args[1] as number,
      args[2] as number | undefined,
      args[3] as number | undefined,
      args[4] as number | undefined,
      args[5] as number | undefined,
      args[6] as number | undefined,
    );
  }

  static now(): number {
    return FROZEN_NOW_MS;
  }
}

export function installFrozenClock(): void {
  globalThis.Date = FrozenDate as unknown as DateConstructor;
}

export function restoreRealClock(): void {
  globalThis.Date = RealDate;
}

export function applyGoldenEnvFlags(): Record<string, string | undefined> {
  assertFrozenScorerDefaults();
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(GOLDEN_ENV_FLAGS)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return previous;
}

export function restoreEnvFlags(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface FixtureWithMeta {
  __fixture: { countries: string[]; capturedAt: string };
}

const fixture = wholeIndexFixture as typeof wholeIndexFixture & FixtureWithMeta;
const fixturePayload: Record<string, unknown> = Object.fromEntries(
  Object.entries(wholeIndexFixture),
);

const TECH_READINESS_KEY = 'economic:worldbank-techreadiness:v1';

// The frozen fixture predates the tech-readiness source key, the same input gap
// the isolation test bridges with a synthetic deterministic payload. Carry that
// payload over (the baseline side, observations absent) so the golden
// characterizes the same frozen input state the #6441 comparison ran on,
// instead of silently imputing the dimension from a null key.
function baselineTechReadiness(): unknown {
  return {
    countries: Object.fromEntries(fixture.__fixture.countries.map((countryCode, index) => [
      countryCode,
      {
        score: 40 + index,
        rank: index + 1,
        components: { internet: 50, mobile: 60, broadband: 40, rdSpend: 30 },
      },
    ])),
  };
}

export function createBaselineReader(): ResilienceSeedReader {
  return async (key) => {
    if (key === TECH_READINESS_KEY) return baselineTechReadiness();
    const value = fixturePayload[key];
    if (!key.startsWith('seed-meta:')) return value ?? null;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, fetchedAt: FROZEN_NOW_MS }
      : null;
  };
}

export interface FrozenCriBytes {
  countryScores: string;
  ranking: string;
}

export async function computeFrozenCriBytes(
  reader: ResilienceSeedReader,
  countries: readonly string[],
): Promise<FrozenCriBytes> {
  const countryEntries = [];
  for (const countryCode of countries) {
    const scoreMap = await scoreAllDimensions(countryCode, reader);
    const dimensions = buildDimensionList(scoreMap);
    const domains = buildDomainList(dimensions);
    const pillars = buildPillarList(domains, true);
    countryEntries.push({
      countryCode,
      overallScore: penalizedPillarScore(pillars.map(({ score, weight }) => ({ score, weight }))),
      dimensions,
    });
  }
  // Code-unit comparison instead of the isolation test's localeCompare: ICU
  // locale data can differ between Node builds, and the committed golden bytes
  // must be reproducible on every platform that runs the test. All cohort
  // country codes are ASCII, so plain code-unit order is stable everywhere.
  const ranking = countryEntries
    .map(({ countryCode, overallScore }) => ({ countryCode, overallScore }))
    .sort((left, right) =>
      right.overallScore - left.overallScore
      || (left.countryCode < right.countryCode ? -1 : left.countryCode > right.countryCode ? 1 : 0),
    );
  return {
    countryScores: JSON.stringify(countryEntries),
    ranking: JSON.stringify(ranking),
  };
}

interface GoldenBaselineArtifact {
  schemaVersion: 1;
  artifactKind: 'cri-golden-baseline';
  issue: number;
  acceptedSourceCommit: string;
  formula: ReturnType<typeof getCurrentCacheFormula>;
  scorerCacheIdentity: {
    scoreCachePrefix: string;
    historyKeyPrefix: string;
  };
  frozenClockIso: string;
  envFlags: Readonly<Record<string, string>>;
  inputFixture: {
    path: string;
    capturedAt: string;
    sha256: string;
  };
  inputOverrides: Record<string, string>;
  serialization: {
    rankingTieBreak: string;
  };
  regenerationCommand: string;
  golden: FrozenCriBytes;
}

function sha256Hex(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  return sha256Hex(await readFile(filePath));
}

function git(args: string[], options: { allowFailure?: boolean; cwd?: string } = {}): string | null {
  try {
    return execFileSync('git', args, {
      cwd: options.cwd ?? REPO_ROOT,
      encoding: 'utf8',
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    }).trim();
  } catch (err) {
    if (options.allowFailure) return null;
    throw err;
  }
}

function currentHeadCommit(): string {
  const sha = git(['rev-parse', 'HEAD']);
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`could not resolve a 40-hex HEAD commit (got: ${sha ?? 'null'})`);
  }
  return sha;
}

function isHeadAncestorOfOriginMain(): boolean {
  // `git merge-base --is-ancestor` exits 0 when HEAD is an ancestor and exits
  // 1 (throwing out of execFileSync) when it is not or when the ref is
  // unavailable, so a null result means "cannot prove ancestry".
  return git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { allowFailure: true }) !== null;
}

export function readGenerationDirtyStatus(repoRoot = REPO_ROOT): string[] | null {
  // The output may already differ after regeneration; every other path can be an input.
  const status = git([
    'status', '--porcelain', '--untracked-files=all', '--', '.',
    `:(exclude)${GOLDEN_ARTIFACT_RELATIVE_PATH}`,
  ], { allowFailure: true, cwd: repoRoot });
  return status === null ? null : status.split('\n').filter(Boolean);
}

export interface GenerationGuards {
  headSha: string;
  headIsAncestorOfOriginMain: boolean;
  dirtyStatusLines: string[] | null;
  allowNonMain: boolean;
  allowDirtyTree: boolean;
}

// Pure so the guard semantics are unit-testable with an injected git runner at
// the CLI boundary (see tests/cri-golden-baseline-guards.test.mts).
export function assertGenerationGuards(guards: GenerationGuards): void {
  // The baseline must describe scorer behavior an accepted commit contains.
  // Running it from a feature branch would commit a golden that describes
  // unreviewed changes; the sanctioned in-PR path is --allow-non-main, whose
  // recorded acceptedSourceCommit becomes the accepted commit on merge.
  if (!guards.headIsAncestorOfOriginMain && !guards.allowNonMain) {
    throw new Error(
      `HEAD ${guards.headSha} is not an ancestor of origin/main (or origin/main is unavailable). ` +
        'For an intentional CRI methodology change, run the generator on the branch making the change with --allow-non-main ' +
        '(the recorded acceptedSourceCommit becomes the accepted commit on merge), ' +
        'or run it from an up-to-date accepted main checkout.',
    );
  }
  if (guards.dirtyStatusLines === null) {
    throw new Error('could not determine working-tree dirtiness via git status');
  }
  if (guards.dirtyStatusLines.length > 0 && !guards.allowDirtyTree) {
    throw new Error(
      'the golden depends on files with uncommitted changes:\n  ' +
        guards.dirtyStatusLines.join('\n  ') +
        '\nGenerate from committed scorer, harness, and fixture state, or pass --allow-dirty-fixture explicitly.',
    );
  }
}

async function main(): Promise<void> {
  const allowNonMain = process.argv.includes('--allow-non-main');
  const allowDirtyTree = process.argv.includes('--allow-dirty-fixture');
  const headSha = currentHeadCommit();
  assertGenerationGuards({
    headSha,
    headIsAncestorOfOriginMain: isHeadAncestorOfOriginMain(),
    dirtyStatusLines: readGenerationDirtyStatus(),
    allowNonMain,
    allowDirtyTree,
  });
  if (!isHeadAncestorOfOriginMain()) {
    console.warn(
      `[generate-cri-golden-baseline] accepting non-main commit ${headSha} via --allow-non-main`,
    );
  }

  const inputFixturePath = path.join(REPO_ROOT, INPUT_FIXTURE_RELATIVE_PATH);
  const previousFlags = applyGoldenEnvFlags();
  installFrozenClock();
  let artifact: GoldenBaselineArtifact;
  try {
    const golden = await computeFrozenCriBytes(
      createBaselineReader(),
      fixture.__fixture.countries,
    );
    artifact = {
      schemaVersion: 1,
      artifactKind: 'cri-golden-baseline',
      issue: 7728,
      acceptedSourceCommit: headSha,
      formula: getCurrentCacheFormula(),
      scorerCacheIdentity: {
        scoreCachePrefix: RESILIENCE_SCORE_CACHE_PREFIX,
        historyKeyPrefix: RESILIENCE_HISTORY_KEY_PREFIX,
      },
      frozenClockIso: FROZEN_CLOCK_ISO,
      envFlags: GOLDEN_ENV_FLAGS,
      inputFixture: {
        path: INPUT_FIXTURE_RELATIVE_PATH,
        capturedAt: fixture.__fixture.capturedAt,
        sha256: await sha256File(inputFixturePath),
      },
      inputOverrides: {
        [TECH_READINESS_KEY]:
          'synthetic deterministic payload (fixture input gap), carried over from tests/five-factor-scorecard-cri-isolation.test.mts baseline side',
      },
      serialization: {
        rankingTieBreak: 'overallScore descending, then countryCode code-unit ascending',
      },
      regenerationCommand: REGENERATION_COMMAND,
      golden,
    };
  } finally {
    restoreRealClock();
    restoreEnvFlags(previousFlags);
  }

  const outPath = path.join(REPO_ROOT, GOLDEN_ARTIFACT_RELATIVE_PATH);
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`[generate-cri-golden-baseline] wrote ${GOLDEN_ARTIFACT_RELATIVE_PATH}`);
  console.log(`[generate-cri-golden-baseline] commit=${headSha} formula=${artifact.formula} fixtureSha256=${artifact.inputFixture.sha256}`);
}

// Hardened main-guard: resolve both sides through realpathSync so invoking the
// script through a symlinked path (e.g. /tmp -> /private/tmp on macOS) still
// executes main instead of silently no-oping.
export function isDirectRun(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
  } catch {
    return pathToFileURL(argv1).href === moduleUrl;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  await main().catch((err) => {
    console.error('[generate-cri-golden-baseline] failed:', err);
    process.exit(1);
  });
}
