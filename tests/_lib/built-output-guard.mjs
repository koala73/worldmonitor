import { existsSync } from 'node:fs';

const EXPECT_BUILT_OUTPUT = 'WM_EXPECT_BUILT_OUTPUT';

function expectsBuiltOutput() {
  return process.env[EXPECT_BUILT_OUTPUT] === '1';
}

export function shouldSkipBuiltOutput(dashboardHtml, expectBuiltOutput = expectsBuiltOutput()) {
  if (existsSync(dashboardHtml)) return false;
  return !expectBuiltOutput;
}

export function guardBuiltOutput(dashboardHtml, expectBuiltOutput = expectsBuiltOutput()) {
  if (!existsSync(dashboardHtml) && expectBuiltOutput) {
    throw new Error(
      'dist/dashboard.html is missing but WM_EXPECT_BUILT_OUTPUT=1 indicates CI expected a build. ' +
      'Run VITE_VARIANT=full vite build first, or check that the build step still produces dist/dashboard.html.',
    );
  }
}
