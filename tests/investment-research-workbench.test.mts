import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createResearchWorkbenchAdapter,
  getFixtureResearchReport,
  RESEARCH_WORKBENCH_VERSION,
  validateInvestmentResearchReport,
} from '../src/services/investment-research-workbench.ts';

describe('investment research workbench contract', () => {
  it('ships a traceable ASTS fixture with no dangling source ids', () => {
    const report = getFixtureResearchReport('asts');
    assert.equal(report.schema, RESEARCH_WORKBENCH_VERSION);
    assert.equal(report.symbol, 'ASTS');
    assert.equal(report.readiness, 'not-decision-grade');
    assert.deepEqual(validateInvestmentResearchReport(report), []);
    assert.ok(report.stages.some((stage) => stage.provider === 'OpenBB'));
    assert.ok(report.stages.some((stage) => stage.provider === 'Langflow'));
  });

  it('rejects unsupported local symbols rather than fabricating research', async () => {
    const adapter = createResearchWorkbenchAdapter();
    await assert.rejects(adapter.run('UNKNOWN'), /No local fixture/);
  });

  it('rejects live responses with dangling citations', async () => {
    const invalid = getFixtureResearchReport('ASTS');
    invalid.stages[0]!.findings[0]!.sourceIds = ['MISSING'];
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(invalid), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const adapter = createResearchWorkbenchAdapter({ endpoint: 'https://research.example.test/run', fetchImpl });
    await assert.rejects(adapter.run('ASTS'), /Unknown source id/);
  });
});

