import { existsSync } from 'node:fs';

const EXPECT_BUILT_OUTPUT = 'WM_EXPECT_BUILT_OUTPUT';
const DEFAULT_REBUILD_HINT = 'Run VITE_VARIANT=full vite build first';

function expectsBuiltOutput() {
  return process.env[EXPECT_BUILT_OUTPUT] === '1';
}

export function shouldSkipBuiltOutput(builtPath, expectBuiltOutput = expectsBuiltOutput()) {
  if (existsSync(builtPath)) return false;
  return !expectBuiltOutput;
}

export function guardBuiltOutput(
  builtPath,
  expectBuiltOutput = expectsBuiltOutput(),
  rebuildHint = DEFAULT_REBUILD_HINT,
) {
  if (!existsSync(builtPath) && expectBuiltOutput) {
    throw new Error(
      `${builtPath} is missing but ${EXPECT_BUILT_OUTPUT}=1 indicates CI expected a build. ` +
      `${rebuildHint}, or check that the build step still produces it.`,
    );
  }
}
