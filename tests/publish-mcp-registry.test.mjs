import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizeMcpRegistryJson,
  decideMcpRegistryPublishAction,
  describeManifestDiff,
  extractPublishedServer,
  extractPublishedStatus,
  isDuplicateVersionPublishError,
  loadDesiredMcpRegistryManifest,
  manifestsAreEquivalent,
  parsePublishMcpRegistryCli,
  publishMcpRegistryIdempotent,
  registryVersionUrl,
  requireNonEmptyString,
  stableMcpRegistryStringify,
} from '../scripts/publish-mcp-registry.mjs';

const DESIRED = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: 'app.worldmonitor/mcp',
  title: 'World Monitor',
  description: 'Live markets, conflicts, country risk, chokepoints, energy, and China decision signals. 69 tools.',
  websiteUrl: 'https://www.worldmonitor.app',
  repository: {
    url: 'https://github.com/koala73/worldmonitor',
    source: 'github',
  },
  version: '1.17.0',
  remotes: [{ type: 'streamable-http', url: 'https://worldmonitor.app/mcp' }],
};

function shuffledDesired() {
  return {
    version: DESIRED.version,
    remotes: DESIRED.remotes,
    repository: { source: 'github', url: DESIRED.repository.url },
    websiteUrl: DESIRED.websiteUrl,
    description: DESIRED.description,
    title: DESIRED.title,
    name: DESIRED.name,
    $schema: DESIRED.$schema,
  };
}

function registryEnvelope(server = shuffledDesired(), status = 'active') {
  return {
    server,
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status,
        publishedAt: '2026-07-05T12:27:24.160068Z',
        isLatest: true,
      },
    },
  };
}

function writeManifest(server = DESIRED) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-mcp-registry-'));
  const path = join(dir, 'registry-server.json');
  writeFileSync(path, `${JSON.stringify(server, null, 2)}\n`);
  return path;
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

describe('publish-mcp-registry helpers', () => {
  it('rejects empty required strings', () => {
    assert.throws(() => requireNonEmptyString('', 'name'), /name must be a non-empty string/);
    assert.throws(() => requireNonEmptyString('   ', 'name'), /name must be a non-empty string/);
    assert.throws(() => requireNonEmptyString(1, 'name'), /name must be a non-empty string/);
  });

  it('encodes the official version lookup URL', () => {
    assert.equal(
      registryVersionUrl('app.worldmonitor/mcp', '1.17.0'),
      'https://registry.modelcontextprotocol.io/v0.1/servers/app.worldmonitor%2Fmcp/versions/1.17.0',
    );
    assert.throws(() => registryVersionUrl('', '1.17.0'), /name must be a non-empty string/);
    assert.throws(() => registryVersionUrl('app.worldmonitor/mcp', ''), /version must be a non-empty string/);
    assert.throws(() => registryVersionUrl('app.worldmonitor/mcp', '1.17.0', 'ftp://x'), /http\(s\)/);
  });

  it('canonicalizes key order so equivalent payloads compare equal', () => {
    assert.equal(stableMcpRegistryStringify(DESIRED), stableMcpRegistryStringify(shuffledDesired()));
    assert.deepEqual(
      canonicalizeMcpRegistryJson({ b: 1, a: { d: 2, c: 3 } }),
      { a: { c: 3, d: 2 }, b: 1 },
    );
  });

  it('extracts the server object and official status from a registry envelope', () => {
    const payload = registryEnvelope();
    assert.equal(extractPublishedServer(payload).version, '1.17.0');
    assert.equal(extractPublishedStatus(payload), 'active');
    assert.equal(extractPublishedServer(DESIRED).name, DESIRED.name);
    assert.equal(extractPublishedStatus(DESIRED), null);
    assert.throws(() => extractPublishedServer(null), /must be an object/);
    assert.throws(() => extractPublishedServer({}), /missing a server object/);
  });

  it('treats key-reordered payloads as equivalent and names differing fields', () => {
    assert.equal(manifestsAreEquivalent(DESIRED, shuffledDesired()), true);
    const drifted = { ...DESIRED, description: 'different description' };
    assert.equal(manifestsAreEquivalent(DESIRED, drifted), false);
    assert.deepEqual(describeManifestDiff(DESIRED, drifted), ['description']);
  });

  it('skips an equivalent active version and fails closed on drift or non-active status', () => {
    assert.deepEqual(
      decideMcpRegistryPublishAction(DESIRED, { found: false }),
      { action: 'publish', reason: 'version-absent' },
    );
    assert.deepEqual(
      decideMcpRegistryPublishAction(DESIRED, { found: true, server: shuffledDesired(), status: 'active' }),
      { action: 'skip', reason: 'equivalent-existing-version' },
    );
    assert.throws(
      () => decideMcpRegistryPublishAction(DESIRED, {
        found: true,
        server: { ...DESIRED, remotes: [{ type: 'streamable-http', url: 'https://evil.example/mcp' }] },
        status: 'active',
      }),
      /payload differs \(remotes\)/,
    );
    assert.throws(
      () => decideMcpRegistryPublishAction(DESIRED, {
        found: true,
        server: shuffledDesired(),
        status: 'deleted',
      }),
      /status deleted/,
    );
  });

  it('recognizes the v1.7.9 duplicate-version publisher error', () => {
    assert.equal(
      isDuplicateVersionPublishError('publish failed: server returned status 400: invalid version: cannot publish duplicate version'),
      true,
    );
    assert.equal(isDuplicateVersionPublishError('{"error":"invalid-version"}'), true);
    assert.equal(isDuplicateVersionPublishError('cannot publish duplicate version'), true);
    assert.equal(isDuplicateVersionPublishError('authentication failed'), false);
    assert.equal(isDuplicateVersionPublishError(null), false);
  });

  it('loads and validates the desired manifest file', () => {
    const path = writeManifest();
    assert.equal(loadDesiredMcpRegistryManifest(path).version, '1.17.0');
    assert.throws(() => loadDesiredMcpRegistryManifest(writeManifest({ ...DESIRED, name: '' })), /name/);
    assert.throws(() => loadDesiredMcpRegistryManifest(''), /manifestPath/);
  });

  it('parses an explicit publisher command after --', () => {
    const parsed = parsePublishMcpRegistryCli([
      'node',
      'scripts/publish-mcp-registry.mjs',
      'registry-server.json',
      '--',
      './mcp-publisher',
      'publish',
      'registry-server.json',
    ]);
    assert.match(parsed.manifestPath, /registry-server\.json$/);
    assert.deepEqual(parsed.publishCommand, ['./mcp-publisher', 'publish', 'registry-server.json']);
    assert.throws(
      () => parsePublishMcpRegistryCli(['node', 'scripts/publish-mcp-registry.mjs', 'a.json', 'b.json']),
      /usage/,
    );
  });
});

describe('publishMcpRegistryIdempotent', () => {
  it('skips publish when the registry already has the equivalent version', async () => {
    let publishes = 0;
    const result = await publishMcpRegistryIdempotent({
      manifestPath: writeManifest(),
      publishCommand: ['./mcp-publisher', 'publish', 'registry-server.json'],
      fetchImpl: async () => jsonResponse(200, registryEnvelope()),
      spawnSyncImpl: () => {
        publishes += 1;
        return { status: 0, stdout: 'published', stderr: '' };
      },
    });
    assert.equal(result.outcome, 'already-published');
    assert.equal(publishes, 0);
  });

  it('publishes when the version is absent', async () => {
    let publishes = 0;
    const result = await publishMcpRegistryIdempotent({
      manifestPath: writeManifest(),
      publishCommand: ['./mcp-publisher', 'publish', 'registry-server.json'],
      fetchImpl: async () => jsonResponse(404, { error: 'not found' }),
      spawnSyncImpl: () => {
        publishes += 1;
        return { status: 0, stdout: '✓ Successfully published', stderr: '' };
      },
    });
    assert.equal(result.outcome, 'published');
    assert.equal(publishes, 1);
  });

  it('fails closed when an existing version has a different payload', async () => {
    let publishes = 0;
    await assert.rejects(
      () => publishMcpRegistryIdempotent({
        manifestPath: writeManifest(),
        publishCommand: ['./mcp-publisher', 'publish', 'registry-server.json'],
        fetchImpl: async () => jsonResponse(200, registryEnvelope({
          ...shuffledDesired(),
          description: 'Live global intelligence. 39 tools.',
        })),
        spawnSyncImpl: () => {
          publishes += 1;
          return { status: 0, stdout: '', stderr: '' };
        },
      }),
      /payload differs \(description\)/,
    );
    assert.equal(publishes, 0);
  });

  it('treats an invalid-version publish error as success when the stored payload matches', async () => {
    let lookups = 0;
    const result = await publishMcpRegistryIdempotent({
      manifestPath: writeManifest(),
      publishCommand: ['./mcp-publisher', 'publish', 'registry-server.json'],
      fetchImpl: async () => {
        lookups += 1;
        if (lookups === 1) return jsonResponse(404, { error: 'not found' });
        return jsonResponse(200, registryEnvelope());
      },
      spawnSyncImpl: () => ({
        status: 1,
        stdout: 'Publishing to https://registry.modelcontextprotocol.io...\n',
        stderr: 'publish failed: server returned status 400: invalid version: cannot publish duplicate version\n',
      }),
    });
    assert.equal(result.outcome, 'already-published-after-conflict');
    assert.equal(lookups, 2);
  });

  it('fails closed when an invalid-version error stores a different payload', async () => {
    let lookups = 0;
    await assert.rejects(
      () => publishMcpRegistryIdempotent({
        manifestPath: writeManifest(),
        publishCommand: ['./mcp-publisher', 'publish', 'registry-server.json'],
        fetchImpl: async () => {
          lookups += 1;
          if (lookups === 1) return jsonResponse(404, { error: 'not found' });
          return jsonResponse(200, registryEnvelope({
            ...shuffledDesired(),
            websiteUrl: 'https://evil.example',
          }));
        },
        spawnSyncImpl: () => ({
          status: 1,
          stdout: '',
          stderr: 'invalid version: cannot publish duplicate version',
        }),
      }),
      /payload differs \(websiteUrl\)/,
    );
    assert.equal(lookups, 2);
  });

  it('fails closed when an invalid-version error cannot be confirmed in the registry', async () => {
    await assert.rejects(
      () => publishMcpRegistryIdempotent({
        manifestPath: writeManifest(),
        publishCommand: ['./mcp-publisher', 'publish', 'registry-server.json'],
        fetchImpl: async () => jsonResponse(404, { error: 'not found' }),
        spawnSyncImpl: () => ({
          status: 1,
          stdout: '',
          stderr: 'invalid-version',
        }),
      }),
      /does not currently return that version/,
    );
  });

  it('surfaces a non-duplicate publisher failure', async () => {
    await assert.rejects(
      () => publishMcpRegistryIdempotent({
        manifestPath: writeManifest(),
        publishCommand: ['./mcp-publisher', 'publish', 'registry-server.json'],
        fetchImpl: async () => jsonResponse(404, { error: 'not found' }),
        spawnSyncImpl: () => ({
          status: 1,
          stdout: '',
          stderr: 'authentication failed',
        }),
      }),
      /authentication failed/,
    );
  });

  it('publishes after a transient registry lookup failure', async () => {
    const result = await publishMcpRegistryIdempotent({
      manifestPath: writeManifest(),
      publishCommand: ['./mcp-publisher', 'publish', 'registry-server.json'],
      fetchImpl: async () => jsonResponse(503, 'unavailable'),
      spawnSyncImpl: () => ({ status: 0, stdout: 'ok', stderr: '' }),
    });
    assert.equal(result.outcome, 'published-after-lookup-failure');
  });
});
