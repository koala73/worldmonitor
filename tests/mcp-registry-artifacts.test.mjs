import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { buildMcpRegistryManifest } from '../scripts/prepare-mcp-registry-manifest.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

// Guards for the official MCP registry publication artifacts
// (registry.modelcontextprotocol.io, namespace app.worldmonitor):
// - public/.well-known/mcp-registry-auth is the HTTP domain-verification
//   surface. If it 404s or its format drifts, every future `mcp-publisher
//   login http` fails and the namespace is unrecoverable without DNS access.
// - server.json is the source registry entry. The publish workflow derives
//   its tool count from the server card, then uses the protected domain key
//   when a release is published.
describe('mcp registry publication artifacts', () => {
  const authFile = readFileSync(join(ROOT, 'public/.well-known/mcp-registry-auth'), 'utf-8');
  const serverJson = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf-8'));
  const serverCard = JSON.parse(
    readFileSync(join(ROOT, 'public/.well-known/mcp/server-card.json'), 'utf-8'),
  );

  it('mcp-registry-auth carries a single MCPv1 ed25519 key line', () => {
    assert.match(
      authFile,
      /^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=\n$/,
      'format must stay `v=MCPv1; k=ed25519; p=<base64>` — the registry parses it verbatim',
    );
  });

  it('server.json stays in the app.worldmonitor namespace with the canonical remote', () => {
    assert.equal(serverJson.name, 'app.worldmonitor/mcp');
    assert.equal(serverJson.remotes.length, 1);
    assert.equal(serverJson.remotes[0].type, 'streamable-http');
    assert.equal(
      serverJson.remotes[0].url,
      serverCard.url,
      'registry remote must match the server card MCP endpoint',
    );
    assert.equal(serverJson.websiteUrl, 'https://www.worldmonitor.app');
  });

  it('server.json version tracks the server card (bump both + republish on SERVER_VERSION change)', () => {
    assert.equal(
      serverJson.version,
      serverCard.version,
      'SERVER_VERSION bumped without bumping server.json — update it and republish to registry.modelcontextprotocol.io (see test header)',
    );
  });

  it('builds the published registry description from the live MCP tool count', () => {
    const published = buildMcpRegistryManifest(serverJson, serverCard);
    assert.match(
      published.description,
      new RegExp(`\\b${serverCard.tools.length} tools\\b`),
      'registry description must report the tool inventory in the server card',
    );
    assert.ok(published.description.length <= 100, 'registry description must fit the official limit');
  });

  it('runs the publication CLI and writes the derived manifest', () => {
    const outputPath = join(tmpdir(), `worldmonitor-mcp-registry-${process.pid}.json`);
    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/prepare-mcp-registry-manifest.mjs', outputPath],
        { cwd: ROOT, encoding: 'utf-8' },
      );
      assert.equal(result.status, 0, result.stderr);

      const published = JSON.parse(readFileSync(outputPath, 'utf-8'));
      assert.match(published.description, new RegExp(`\\b${serverCard.tools.length} tools\\b`));
    } finally {
      rmSync(outputPath, { force: true });
    }
  });

  it('publishes registry metadata on release with protected HTTP credentials', () => {
    const workflowPath = join(ROOT, '.github/workflows/publish-mcp-registry.yml');
    assert.equal(existsSync(workflowPath), true, 'missing MCP registry publish workflow');

    const source = readFileSync(workflowPath, 'utf-8');
    const workflow = loadYaml(source);
    const triggers = workflow.on ?? workflow[true];
    const steps = workflow.jobs.publish.steps;
    const stepNamed = (name) => {
      const matches = steps.filter((step) => step.name === name);
      assert.equal(matches.length, 1, `expected one workflow step named ${name}`);
      return matches[0];
    };

    assert.deepEqual(triggers.release.types, ['published']);
    assert.equal(Object.hasOwn(triggers, 'push'), false);
    assert.ok(Object.hasOwn(triggers, 'workflow_dispatch'));
    assert.equal(Object.hasOwn(triggers, 'pull_request'), false);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.equal(workflow.jobs.publish.environment, 'mcp-registry-publish');
    assert.equal(workflow.jobs.publish['timeout-minutes'], 10);
    assert.match(workflow.jobs.publish.if, /github\.event_name == 'release'/);
    assert.match(workflow.jobs.publish.if, /github\.ref == 'refs\/heads\/main'/);
    const install = stepNamed('Install mcp-publisher');
    assert.match(install.env.MCP_PUBLISHER_VERSION, /^v\d+\.\d+\.\d+$/);
    assert.match(install.env.MCP_PUBLISHER_SHA256, /^[a-f0-9]{64}$/);
    assert.match(install.run, /releases\/download\/\$\{MCP_PUBLISHER_VERSION\}\//);
    assert.match(install.run, /--connect-timeout 15/);
    assert.match(install.run, /--max-time 90/);
    assert.match(install.run, /--retry 3/);
    assert.match(install.run, /--retry-delay 2/);
    assert.match(install.run, /sha256sum --check/);
    assert.match(stepNamed('Authenticate to MCP Registry').run, /login http/);
    assert.match(stepNamed('Authenticate to MCP Registry').run, /--domain worldmonitor\.app/);
    assert.match(source, /secrets\.MCP_REGISTRY_PRIVATE_KEY/);
    assert.match(
      stepNamed('Prepare registry manifest').run,
      /prepare-mcp-registry-manifest\.mjs registry-server\.json/,
    );
    assert.match(stepNamed('Publish server').run, /mcp-publisher publish registry-server\.json/);

    for (const step of steps.filter((entry) => entry.run)) {
      const shellCheck = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf-8' });
      assert.equal(shellCheck.status, 0, `${step.name}: ${shellCheck.stderr}`);
    }
  });
});
