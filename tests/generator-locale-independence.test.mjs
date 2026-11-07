// Derived files and reviewed digests must not depend on the developer's locale.
// A bare String#localeCompare() follows the host locale: under cs_CZ "ch" sorts
// after "h", which broke the provider identity sha256 (failing `npm install`)
// and moved CH after HU in api/_country-corpus-slugs.generated.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CZECH_ENV = { ...process.env, LANG: 'cs_CZ.UTF-8', LC_ALL: 'cs_CZ.UTF-8' };

const GENERATOR_FILES = [
  'scripts/build-welcome-teasers.mjs',
  'scripts/generate-country-corpus-slugs.mjs',
  'scripts/generate-entitlement-crosswalk.mjs',
  'scripts/generate-no2-regions.mjs',
  'scripts/generate-request-validation.mjs',
  'scripts/generate-third-party-notices.mjs',
  'scripts/source-attribution.mjs',
  'scripts/source-catalog-identity.mjs',
];

function runUnderCzechLocale(source) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: ROOT,
    env: CZECH_ENV,
    encoding: 'utf8',
  }).trim();
}

describe('generator locale independence', () => {
  it('child process really collates as Czech', () => {
    // Guards the test itself: without full ICU or with the env ignored, the
    // checks below would pass vacuously.
    assert.equal(runUnderCzechLocale("console.log(['ch', 'hz'].sort((a, b) => a.localeCompare(b)).join(','))"), 'hz,ch');
  });

  it('provider identity digest matches the reviewed sha256 under cs_CZ', () => {
    const out = runUnderCzechLocale(`
      import { providerIdentityDigest, PROVIDER_IDENTITY_REVIEW } from './scripts/source-attribution.mjs';
      console.log(JSON.stringify([providerIdentityDigest(), PROVIDER_IDENTITY_REVIEW.sha256]));
    `);
    const [digest, reviewed] = JSON.parse(out);
    assert.equal(digest, reviewed);
  });

  it('country corpus slugs are current when checked under cs_CZ', () => {
    execFileSync(process.execPath, ['scripts/generate-country-corpus-slugs.mjs', '--check'], {
      cwd: ROOT,
      env: CZECH_ENV,
      stdio: 'pipe',
    });
  });

  it('generators pin a collation locale on every localeCompare', () => {
    for (const file of GENERATOR_FILES) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const bare = source.split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => !line.trim().startsWith('//'))
        .filter(({ line }) => /\.localeCompare\((?:[^(),]|\[[^\]]*\]|\([^()]*\))+\)/.test(line));
      assert.deepEqual(bare.map(({ number, line }) => `${file}:${number}: ${line.trim()}`), []);
    }
  });
});
