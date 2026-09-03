import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/mcp-live-smoke.yml', import.meta.url),
  'utf8',
);

describe('MCP live smoke workflow', () => {
  it('runs after the matching Vercel production deployment is ready', () => {
    assert.match(workflow, /^ {2}deployment_status:$/m);
    assert.doesNotMatch(workflow, /^ {2}push:$/m);
    assert.match(workflow, /github\.event\.deployment_status\.state == 'success'/);
    assert.match(workflow, /github\.event\.deployment\.environment == 'Production'/);
    assert.match(workflow, /github\.event\.deployment\.creator\.login == 'vercel\[bot\]'/);
    assert.match(
      workflow,
      /ref: \$\{\{ github\.event_name == 'deployment_status' && github\.event\.deployment\.sha \|\| github\.sha \}\}/,
    );
  });

  it('installs the locked AJV dependency before running the smoke', () => {
    assert.match(workflow, /cache: 'npm'/);
    assert.match(workflow, /npm ci --ignore-scripts/);
    assert.match(workflow, /node scripts\/mcp-live-smoke\.mjs/);
  });

  it('keeps scheduled and manual production checks', () => {
    assert.match(workflow, /^ {2}schedule:$/m);
    assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  });
});
