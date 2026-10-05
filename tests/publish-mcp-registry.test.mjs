import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizeMcpRegistryJson,
  decideMcpRegistryPublishAction,
  describeManifestDiff,
  extractPublishedServer,
  extractPublishedStatus,
  fetchPublishedMcpRegistryVersion,
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

describe('registry lookup recovery', () => {
  const lookupOptions = { name: DESIRED.name, version: DESIRED.version, sleepImpl: async () => {} };

  it('retries transient HTTP responses and transport errors', async () => {
    const failures = [
      ...[408, 429, 500, 502, 503, 504].map((status) => () => jsonResponse(status, 'unavailable')),
      ...['ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']
        .map((code) => () => { throw new TypeError('fetch failed', { cause: { code } }); }),
      () => { throw new DOMException('aborted', 'AbortError'); },
    ];
    for (const fail of failures) {
      let calls = 0;
      const result = await fetchPublishedMcpRegistryVersion({
        ...lookupOptions,
        fetchImpl: async () => ++calls === 1 ? fail() : jsonResponse(200, registryEnvelope()),
      });
      assert.equal(result.found, true);
      assert.equal(calls, 2);
    }
  });

  it('stops after three attempts and preserves the cause and lookup context', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const delays = [];
    const signals = [];
    await assert.rejects(fetchPublishedMcpRegistryVersion({
      ...lookupOptions,
      fetchImpl: async (_url, { signal }) => { signals.push(signal); throw timeout; },
      sleepImpl: async (ms) => { delays.push(ms); },
    }), (error) => {
      assert.equal(error.cause, timeout);
      assert.match(error.message, /GET https:\/\/registry\.modelcontextprotocol\.io\/.*attempt 3\/3, timeout 15000ms/);
      return true;
    });
    assert.equal(new Set(signals).size, 3);
    assert.deepEqual(delays, [1000, 2000]);
  });

  it('does not retry absence, permanent HTTP failures, TLS failures, or invalid payloads', async () => {
    const responses = [
      ...[400, 401, 403, 404, 422, 501].map((status) => () => jsonResponse(status, 'not retryable')),
      () => { throw new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }); },
      () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } }),
      () => jsonResponse(200, { missing: 'server' }),
    ];
    for (const response of responses) {
      let calls = 0;
      const result = fetchPublishedMcpRegistryVersion({
        ...lookupOptions,
        fetchImpl: async () => { calls += 1; return response(); },
        sleepImpl: async () => assert.fail('must not retry'),
      });
      try {
        assert.equal((await result).found, false);
      } catch (error) {
        assert.match(error.message, /HTTP (400|401|403|422|501)|fetch failed|invalid JSON|missing a server object/);
      }
      assert.equal(calls, 1);
    }
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

  it('avoids publication when a retried initial lookup finds the equivalent version', async () => {
    let lookups = 0;
    const result = await publishMcpRegistryIdempotent({
      manifestPath: writeManifest(),
      fetchImpl: async () => ++lookups === 1 ? jsonResponse(503, 'unavailable') : jsonResponse(200, registryEnvelope()),
      sleepImpl: async () => {},
      spawnSyncImpl: () => assert.fail('must not publish an equivalent version'),
    });
    assert.equal(result.outcome, 'already-published');
    assert.equal(lookups, 2);
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

  it('recovers a timeout while confirming a duplicate without publishing again', async () => {
    let lookups = 0;
    let publishes = 0;
    const signals = [];
    const delays = [];
    const result = await publishMcpRegistryIdempotent({
      manifestPath: writeManifest(),
      fetchImpl: async (_url, { signal }) => {
        lookups += 1;
        signals.push(signal);
        if (lookups === 1) return jsonResponse(404, {});
        if (lookups === 2) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        return jsonResponse(200, registryEnvelope());
      },
      sleepImpl: async (ms) => { delays.push(ms); },
      spawnSyncImpl: () => {
        publishes += 1;
        return { status: 1, stderr: 'invalid version: cannot publish duplicate version' };
      },
    });
    assert.equal(result.outcome, 'already-published-after-conflict');
    assert.equal(lookups, 3);
    assert.equal(publishes, 1);
    assert.equal(new Set(signals).size, 3);
    assert.deepEqual(delays, [1000]);
  });

  it('recovers an actual HTTP body timeout during conflict verification', async (t) => {
    let lookups = 0;
    let publishes = 0;
    const server = createServer((_request, response) => {
      lookups += 1;
      if (lookups === 1) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (lookups === 2) { response.write('{"server":'); return; }
      response.end(JSON.stringify(registryEnvelope()));
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const result = await publishMcpRegistryIdempotent({
      manifestPath: writeManifest(),
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      timeoutMs: 500,
      sleepImpl: async () => {},
      spawnSyncImpl: () => {
        publishes += 1;
        return { status: 1, stderr: 'cannot publish duplicate version' };
      },
    });
    assert.equal(result.outcome, 'already-published-after-conflict');
    assert.equal(lookups, 3);
    assert.equal(publishes, 1);
  });

  it('fails closed after retry exhaustion, payload drift, or inactive conflict records', async () => {
    for (const [recovery, expectedLookups, expectedError] of [
      [() => { throw new DOMException('timed out', 'TimeoutError'); }, 4, /attempt 3\/3/],
      [() => jsonResponse(200, registryEnvelope({ ...DESIRED, description: 'different' })), 3, /payload differs/],
      [() => jsonResponse(200, registryEnvelope(DESIRED, 'deleted')), 3, /status deleted/],
    ]) {
      let lookups = 0;
      let publishes = 0;
      await assert.rejects(publishMcpRegistryIdempotent({
        manifestPath: writeManifest(),
        fetchImpl: async () => {
          lookups += 1;
          if (lookups === 1) return jsonResponse(404, {});
          if (lookups === 2) throw new DOMException('timed out', 'TimeoutError');
          return recovery();
        },
        sleepImpl: async () => {},
        spawnSyncImpl: () => { publishes += 1; return { status: 1, stderr: 'invalid-version' }; },
      }), expectedError);
      assert.equal(publishes, 1);
      assert.equal(lookups, expectedLookups);
    }
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
      sleepImpl: async () => {},
      spawnSyncImpl: () => ({ status: 0, stdout: 'ok', stderr: '' }),
    });
    assert.equal(result.outcome, 'published-after-lookup-failure');
  });
});
