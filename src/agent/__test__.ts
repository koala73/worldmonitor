/**
 * Quick inline test runner — validates the agent system works end-to-end.
 * Run via: npx vite-node src/agent/__test__.ts
 */

import { runDiagnostics } from './diagnostics';

const report = runDiagnostics();
console.log(report.summary);

if (report.failed > 0) {
  console.log('\nFailed tests:');
  for (const t of report.tests.filter(t => !t.passed)) {
    console.log(`  ✗ ${t.name}: ${t.details}`);
  }
  throw new Error(`${report.failed} test(s) failed`);
}
