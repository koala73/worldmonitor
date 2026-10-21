import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import {
  assertPinnedManifestPayload,
  assertPinnedToolInventory,
  buildMcpRegistryManifest,
  mcpRegistryManifestFingerprint,
} from '../scripts/prepare-mcp-registry-manifest.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

// Guards for the official MCP registry publication artifacts
// (registry.modelcontextprotocol.io, namespace app.worldmonitor):
// - public/.well-known/mcp-registry-auth is the HTTP domain-verification
//   surface. If it 404s or its format drifts, every future `mcp-publisher
//   login http` fails and the namespace is unrecoverable without DNS access.
// - server.json is the source registry entry. The publish workflow derives
//   its tool count from the server card, then uses the protected domain key.
// - The workflow must fire on the cadence this repo actually has. #7372
//   published on `release: published` only; the last GitHub release predated
//   that wiring by ~6 months, the workflow logged zero runs, and the registry
//   sat at 1.13.0/39 tools against a live 1.17.0/72. Publication is driven by
//   pushes that change the manifest inputs, with a daily self-healing
//   backstop, mirroring desktop-release-train.yml.
// - scripts/mcp-registry-published-versions.json pins the tool count each
//   SERVER_VERSION declares. server-card.json::tools is held in lockstep with
//   the code registry (tests/public-product-facts.test.mjs), so every added
//   tool changes the published description while SERVER_VERSION stays put —
//   68 -> 69 -> 71 -> 72 all shipped under 1.17.0. The registry refuses a
//   changed payload for an existing version, so that drift is what turns the
//   publish job permanently red. Changing the inventory must bump the version.
describe('mcp registry publication artifacts', () => {
  const authFile = readFileSync(join(ROOT, 'public/.well-known/mcp-registry-auth'), 'utf-8');
  const serverJson = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf-8'));
  const serverCard = JSON.parse(
    readFileSync(join(ROOT, 'public/.well-known/mcp/server-card.json'), 'utf-8'),
  );
  const ledger = JSON.parse(
    readFileSync(join(ROOT, 'scripts/mcp-registry-published-versions.json'), 'utf-8'),
  );
  const publishedVersions = ledger.versions;

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
    const published = buildMcpRegistryManifest(serverJson, serverCard, ledger);
    assert.match(
      published.description,
      new RegExp(`\\b${serverCard.tools.length} tools\\b`),
      'registry description must report the tool inventory in the server card',
    );
    assert.ok(published.description.length <= 100, 'registry description must fit the official limit');
  });

  it('pins each SERVER_VERSION to the tool inventory it published', () => {
    const versions = Object.keys(publishedVersions ?? {});
    assert.ok(versions.length > 0, 'the published-version ledger must not be empty');
    assert.match(ledger.$comment ?? '', /SERVER_VERSION/, 'the ledger must document why it exists');
    for (const [version, pinned] of Object.entries(publishedVersions)) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${version} is not a semver version`);
      assert.ok(
        Number.isInteger(pinned.tools) && pinned.tools > 0,
        `${version} must pin a positive integer tool count`,
      );
      assert.match(
        pinned.manifestSha256 ?? '',
        /^[a-f0-9]{64}$/,
        `${version} must pin a sha256 over the manifest it published`,
      );
    }
    assert.deepEqual(
      versions,
      [...versions].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      'ledger entries must stay in ascending version order',
    );
    assert.equal(
      versions.at(-1),
      serverCard.version,
      'the newest ledger entry must be the version the server card declares',
    );
    assert.equal(
      publishedVersions[serverCard.version].tools,
      serverCard.tools.length,
      'adding or removing an MCP tool changes the published registry description; '
        + 'bump SERVER_VERSION and add a ledger entry instead of editing the pinned count',
    );
  });

  it('refuses to build a manifest whose tool count contradicts its pinned version', () => {
    const drifted = {
      ...serverCard,
      tools: [...serverCard.tools, { name: 'get_unpinned_tool' }],
    };
    assert.throws(
      () => assertPinnedToolInventory(drifted, ledger),
      /SERVER_VERSION/,
      'a tool added without a version bump must fail the manifest generator, not the publish job',
    );
    assert.throws(
      () => assertPinnedToolInventory({ ...serverCard, version: '9.9.9' }, ledger),
      /9\.9\.9/,
      'an unpinned version must fail closed rather than publish an unreviewed inventory',
    );
    assert.doesNotThrow(() => assertPinnedToolInventory(serverCard, ledger));
    assert.throws(
      () => assertPinnedToolInventory(serverCard, {}),
      /versions/,
      'a ledger without a versions map must fail closed, not skip the pin',
    );
    assert.throws(
      () => buildMcpRegistryManifest(serverJson, serverCard, undefined),
      /versions/,
      'omitting the ledger must fail closed rather than build an unpinned manifest',
    );
  });

  it('refuses a payload edit under a published version, not just a tool-count change', () => {
    // The tool count is one field of a payload the registry stores whole and
    // refuses to replace. A copy edit to the description under a frozen
    // version reproduces the same permanently-red publish job, with none of
    // the version-bump smell — and server.json is in the workflow's push paths.
    const reworded = { ...serverJson, description: 'Live markets, conflicts, and country risk.' };
    assert.throws(
      () => buildMcpRegistryManifest(reworded, serverCard, ledger),
      /published payload for version .* changed/,
      'a reworded description under a published version must fail in the PR, not in the publish job',
    );
    assert.throws(
      () => buildMcpRegistryManifest({ ...serverJson, title: 'World Monitor MCP' }, serverCard, ledger),
      /published payload for version .* changed/,
      'every published field is pinned, not only the derived tool count',
    );
    assert.throws(
      () => buildMcpRegistryManifest({ ...serverJson, version: '1.16.0' }, serverCard, ledger),
      /does not match server card version/,
      'publishing a version other than the pinned one must fail closed',
    );
  });

  it('pins the fingerprint of the manifest actually published', () => {
    const manifest = buildMcpRegistryManifest(serverJson, serverCard, ledger);
    assert.equal(
      mcpRegistryManifestFingerprint(manifest),
      publishedVersions[serverCard.version].manifestSha256,
      'the pinned sha256 must be the fingerprint of the manifest the generator emits',
    );
    assert.doesNotThrow(() => assertPinnedManifestPayload(manifest, ledger));
    assert.throws(
      () => assertPinnedManifestPayload({ ...manifest, websiteUrl: 'https://example.test' }, ledger),
      /published payload for version .* changed/,
    );
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

  it('publishes registry metadata on manifest changes with protected HTTP credentials', () => {
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
    assert.ok(Object.hasOwn(triggers, 'workflow_dispatch'));
    assert.equal(Object.hasOwn(triggers, 'pull_request'), false);
    assert.deepEqual(
      triggers.push?.branches,
      ['main'],
      'publication must follow merges to main — `release: published` alone logged zero runs (#7372)',
    );
    for (const manifestInput of [
      '.github/workflows/publish-mcp-registry.yml',
      'public/.well-known/mcp/server-card.json',
      'scripts/mcp-registry-published-versions.json',
      'scripts/prepare-mcp-registry-manifest.mjs',
      'scripts/publish-mcp-registry.mjs',
      'server.json',
    ]) {
      assert.ok(
        triggers.push?.paths?.includes(manifestInput),
        `${manifestInput} changes the published manifest and must trigger publication`,
      );
    }
    assert.ok(
      Array.isArray(triggers.schedule) && triggers.schedule.length > 0,
      'a scheduled backstop must re-attempt publication when a merge-time run is lost',
    );
    assert.equal(triggers.schedule.length, 1, 'one daily backstop, not a cadence guess');
    assert.match(
      triggers.schedule[0].cron,
      /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* \*$/,
      `the backstop must be a valid daily cron, got: ${triggers.schedule[0].cron}`,
    );
    assert.equal(
      workflow.concurrency['cancel-in-progress'],
      false,
      'a publish in flight must not be cancelled by a following merge',
    );
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
    const setupNode = stepNamed('Set up Node.js');
    assert.match(setupNode.uses, /^actions\/setup-node@[a-f0-9]{40}$/);
    assert.equal(setupNode.with['node-version'], '24');
    assert.ok(
      steps.findIndex((step) => step.name === 'Set up Node.js')
        < steps.findIndex((step) => step.name === 'Prepare registry manifest'),
      'Node 24 must be pinned before the registry manifest generator runs',
    );
    assert.match(stepNamed('Authenticate to MCP Registry').run, /login http/);
    assert.match(stepNamed('Authenticate to MCP Registry').run, /--domain worldmonitor\.app/);
    assert.match(source, /secrets\.MCP_REGISTRY_PRIVATE_KEY/);
    assert.match(
      stepNamed('Prepare registry manifest').run,
      /prepare-mcp-registry-manifest\.mjs registry-server\.json/,
    );
    assert.match(
      stepNamed('Publish server').run,
      /publish-mcp-registry\.mjs registry-server\.json/,
    );
    assert.match(stepNamed('Publish server').run, /mcp-publisher publish registry-server\.json/);

    for (const step of steps.filter((entry) => entry.run)) {
      const shellCheck = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf-8' });
      assert.equal(shellCheck.status, 0, `${step.name}: ${shellCheck.stderr}`);
    }
  });
});
