import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..');
const manifestPath = resolve(repoRoot, 'api/api-route-exceptions.json');

const VALID_CATEGORIES = new Set([
  'external-protocol',
  'non-json',
  'upstream-proxy',
  'ops-admin',
  'internal-helper',
  'deferred',
  'migration-pending',
]);

// If a rationale names one of these subsystems, the route source must mention it
// too — catches copy-paste rationales that describe the wrong software (#7127).
const ANCHORED_REASON_TERMS = ['tauri', 'sidecar', 'desktop updater'];

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const ROUTE_EXPECTATIONS = [
  {
    path: 'api/fwdstart.js',
    reasonTerms: ['fwdstart.me', 'rss/xml', 'application/xml'],
    sourceTerms: ['fwdstart.me', 'rss', 'application/xml'],
  },
  {
    path: 'api/youtube/embed.js',
    reasonTerms: ['youtube', 'iframe', 'html', 'text/html'],
    sourceTerms: ['youtube.com', 'iframe', 'text/html'],
  },
];

function assertRouteSpecificException(entry, { path, reasonTerms, sourceTerms }) {
  assert.equal(entry.path, path);
  assert.equal(entry.category, 'non-json');
  for (const term of reasonTerms) {
    assert.ok(
      entry.reason.toLowerCase().includes(term),
      `${path} reason must mention ${term}`,
    );
  }
  const source = readFileSync(resolve(repoRoot, entry.path), 'utf8').toLowerCase();
  for (const term of sourceTerms) {
    assert.ok(source.includes(term), `${path} source must mention ${term}`);
  }
}

describe('api-route-exceptions manifest', () => {
  it('has a non-empty exceptions array', () => {
    assert.ok(Array.isArray(manifest.exceptions));
    assert.ok(manifest.exceptions.length > 0);
  });

  for (const expectation of ROUTE_EXPECTATIONS) {
    it(`${expectation.path} retains its route-specific non-JSON rationale`, () => {
      const entry = manifest.exceptions.find(({ path }) => path === expectation.path);
      assert.ok(entry, `missing exception for ${expectation.path}`);
      assertRouteSpecificException(entry, expectation);
    });
  }

  it('rejects category and rationale regressions for route-specific exceptions', () => {
    const fwdstart = manifest.exceptions.find(({ path }) => path === 'api/fwdstart.js');
    const youtubeEmbed = manifest.exceptions.find(({ path }) => path === 'api/youtube/embed.js');

    assert.ok(fwdstart);
    assert.ok(youtubeEmbed);
    assert.throws(() => {
      assertRouteSpecificException(
        { ...fwdstart, category: 'upstream-proxy' },
        ROUTE_EXPECTATIONS[0],
      );
    });
    assert.throws(() => {
      assertRouteSpecificException(
        {
          ...youtubeEmbed,
          reason: 'YouTube oEmbed proxy returns metadata as application/json.',
        },
        ROUTE_EXPECTATIONS[1],
      );
    });
  });

  for (const [idx, entry] of manifest.exceptions.entries()) {
    const label = `api-route-exceptions.json[${idx}] (${entry.path ?? 'missing path'})`;

    it(`${label} points to an existing route file`, () => {
      assert.equal(typeof entry.path, 'string');
      assert.ok(entry.path.length > 0);
      assert.ok(
        existsSync(resolve(repoRoot, entry.path)),
        `expected ${entry.path} to exist`,
      );
    });

    it(`${label} has a substantive reason and valid metadata`, () => {
      assert.ok(VALID_CATEGORIES.has(entry.category), `invalid category ${entry.category}`);
      assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length >= 10);
      assert.match(entry.owner ?? '', /^@\w+/);
      assert.ok(!/^(tbd|todo|fixme|placeholder)\b/i.test(entry.reason.trim()));
    });

    it(`${label} rationale is anchored in the route source when it cites desktop plumbing`, () => {
      const source = readFileSync(resolve(repoRoot, entry.path), 'utf8').toLowerCase();
      const reason = entry.reason.toLowerCase();
      for (const term of ANCHORED_REASON_TERMS) {
        if (reason.includes(term)) {
          assert.ok(
            source.includes(term),
            `reason mentions "${term}" but ${entry.path} does not`,
          );
        }
      }
    });
  }
});
