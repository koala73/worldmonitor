// Pins the intentionally-duplicated billing marker TTL constants and the
// Retry-After clamp bounds between server/_shared/entitlement-check.ts (TS,
// gateway/session surfaces) and api/_user-api-key.js (plain JS, bootstrap
// surface — cannot import the TS module under node --test). A unilateral edit
// to either copy desyncs the denial contract between surfaces; this test
// makes that drift red instead of silent.
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { strict as assert } from 'node:assert';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function constant(src, file, name) {
  const match = src.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(match, `${name} not found in ${file}`);
  return Number(match[1]);
}

test('billing marker TTL constants stay identical across the TS/JS mirror', () => {
  const ts = read('server/_shared/entitlement-check.ts');
  const js = read('api/_user-api-key.js');

  for (const name of [
    'LAPSED_BILLING_MARKER_TTL_SECONDS',
    'NOT_APPLICABLE_VERIFICATION_TTL_SECONDS',
    'ENTITLEMENT_CACHE_TTL_SECONDS',
  ]) {
    assert.equal(
      constant(ts, 'entitlement-check.ts', name),
      constant(js, '_user-api-key.js', name),
      `${name} drifted between entitlement-check.ts and _user-api-key.js`,
    );
  }
});

test('Retry-After clamp bounds match across the TS/JS mirror', () => {
  for (const rel of ['server/_shared/entitlement-check.ts', 'api/_user-api-key.js']) {
    assert.match(
      read(rel),
      /Math\.max\(1, Math\.min\(60,/,
      `${rel} lost the [1,60] Retry-After clamp`,
    );
  }
});

test('Retry-After fallback default matches across the TS/JS mirror', () => {
  const ts = read('server/_shared/entitlement-check.ts');
  const js = read('api/_user-api-key.js');

  // The TS clampRetryAfterSeconds falls back to a hardcoded literal while the
  // JS mirror falls back to VALIDATION_RETRY_AFTER_SECONDS — previously
  // unpinned, so the two surfaces could quote different Retry-After hints for
  // the same failure without any test going red.
  const tsFallback = ts.match(/function clampRetryAfterSeconds[\s\S]*?:\s*(\d+);\n\}/);
  assert.ok(tsFallback, 'clampRetryAfterSeconds fallback literal not found in entitlement-check.ts');
  assert.equal(
    Number(tsFallback[1]),
    constant(js, '_user-api-key.js', 'VALIDATION_RETRY_AFTER_SECONDS'),
    'Retry-After fallback default drifted between entitlement-check.ts and _user-api-key.js',
  );
});
