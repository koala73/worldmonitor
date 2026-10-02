# CRI golden output baseline

The Country Resilience Index (CRI) has two independent proof layers in
`tests/`:

1. **Isolation control** — `tests/five-factor-scorecard-cri-isolation.test.mts`
   proves the five-factor scorecard's additive fields do not perturb CRI by
   comparing before/after output. Both sides run the same live scorer, so a
   shared-scorer defect moves them together and passes. It cannot detect a CRI
   scorer change.
2. **Golden non-regression baseline** —
   `tests/resilience-cri-golden-baseline.test.mts` compares the live scorer's
   country-score and ranking bytes against a committed golden artifact. The
   expected bytes never come from the live scorer, so any CRI methodology
   change fails this test until the baseline is intentionally regenerated.

## Artifact

`tests/fixtures/resilience-cri-golden-baseline-2026-08-13.json` holds the
golden bytes plus the identity needed to interpret them:

- `acceptedSourceCommit` — the accepted `main` commit the bytes were generated
  from.
- `formula` and `scorerCacheIdentity` — the CRI cache identity at generation
  time (formula tag and score cache prefix from
  `server/worldmonitor/resilience/v1/_shared.ts`).
- `frozenClockIso` and `envFlags` — the fixed clock and feature flags the
  comparison runs under.
- `inputFixture` — path, capture date, and sha256 of the frozen input fixture
  `tests/fixtures/resilience-whole-index-pairs-2026-08-13.json`.
- `golden` — the exact `JSON.stringify` bytes for country scores and ranking.

The artifact is a pure function of (accepted commit, input fixture, scorer,
frozen harness constants): it carries no wall-clock timestamp, so regenerating
on the same commit is a git no-op.

## Frozen harness

`scripts/generate-cri-golden-baseline.mts` exports the shared harness — frozen
clock (all `Date.now()` / `new Date()` reads pin to the frozen instant, which
covers seed-meta staleness preflights, cyber discovery decay, and the
year-based education and import-HHI certainty derates), frozen env flags, the
fixture-backed reader (including the synthetic tech-readiness override the
isolation test uses for the same input gap), and the byte computation with a
code-unit ranking tie-break (locale-independent, unlike `localeCompare`).
The generator and the test import the same module, so they cannot drift.

## Regenerating

Only for an **intentional CRI methodology change**:

```bash
npm run freeze:resilience-cri-golden
```

Two flows, by checkout:

- **Accepted main checkout** (up to date with `origin/main`): run the command
  directly. The artifact records that commit as `acceptedSourceCommit`.
- **The PR that makes the methodology change** (the usual case): the golden
  test fails on that PR by design, and the generator refuses to run there by
  default. Run the command **on that branch with `--allow-non-main`**; the
  artifact records the branch HEAD, which becomes the accepted commit on
  merge. This is the sanctioned in-PR regeneration path.

By default the generator refuses to run when the worktree has staged, unstaged,
or untracked changes. This includes shared scorer dependencies and configuration
files. Only the output artifact is excluded, so repeating generation on the
same commit is permitted. `--allow-dirty-fixture` overrides that gate explicitly; the
two flags are independent. Never regenerate merely to make a failing test
pass; a golden failure is a signal to review the scorer change first.

The artifact is a pure function of (accepted commit, input fixture, scorer,
frozen harness constants): it carries no wall-clock timestamp, so regenerating
on the same commit is a git no-op.

The test also asserts the recorded formula tag and score cache prefixes still
match the live scorer, so a cache-identity change surfaces as an explicit
"regenerate the baseline" failure instead of a raw byte diff. Byte
reproducibility assumes the repository's Node.js 24 toolchain (`.nvmrc`); the
rounded two- and four-decimal serialization keeps the bytes stable against
floating-point last-bit drift, but a Node/V8 upgrade that changes rounding at
a boundary would surface as a baseline failure to review.
