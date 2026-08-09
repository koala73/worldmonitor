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

  // Cross-mirror equality alone is not enough: a SYMMETRIC drift (both files
  // moved 60 -> 45) satisfies every assertion above and also satisfies the
  // `ttl > 30 && ttl <= 60` window checks in the sibling suites, so nothing
  // would go red. Pin the absolute values here — this is the single place that
  // states what the marker TTLs actually are. Retuning one is a deliberate act:
  // update this expectation and the window assertions in
  // server/__tests__/entitlement-check.test.ts + api/_user-api-key.test.mjs.
  const expected = {
    // #5600: bounds the wrongful-denial window for a buyer whose Dodo webhook
    // has not landed yet.
    NOT_APPLICABLE_VERIFICATION_TTL_SECONDS: 60,
    LAPSED_BILLING_MARKER_TTL_SECONDS: 60,
  };
  for (const [name, want] of Object.entries(expected)) {
    assert.equal(
      constant(ts, 'entitlement-check.ts', name),
      want,
      `${name} is no longer ${want}s — if this retune is intentional, update this pin and the sibling window assertions`,
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

test('entitlement cache key prefix is derived identically by every writer and reader', () => {
  // #5600's aggravator: the Dodo webhook's corrective Redis sync wrote
  // `entitlements:live:*` while the edge read `entitlements:test:*`, so the
  // poisoned free entry was never overwritten. The env var itself is deploy
  // config, but the three independent derivations of the prefix are code — and
  // nothing pinned them together. A drift here silently splits the namespace
  // again, with the same symptom and the same 15-minute blast radius.
  const sources = [
    ['server/_shared/entitlement-check.ts', read('server/_shared/entitlement-check.ts')],
    ['api/_user-api-key.js', read('api/_user-api-key.js')],
    ['convex/payments/cacheActions.ts', read('convex/payments/cacheActions.ts')],
  ];

  // The two assertions below must BIND, not merely co-occur. An earlier version
  // checked "the ternary appears somewhere" AND "some `entitlements:${a}:${b}`
  // appears somewhere" as independent regexes — which passes with #5600's bug
  // restored verbatim, because nothing tied the ternary's assignment target to
  // the identifier actually interpolated into the key. Proven by mutation: a
  // reader on the env-aware var plus a writer on a hardcoded 'test' var, with
  // the ternary left intact as dead code, went green 4/4. So: capture the
  // variable the ternary assigns, then require EVERY entitlements-key template
  // in the file to interpolate that exact name.
  for (const [file, src] of sources) {
    const derivation = src.match(
      /const ([A-Za-z_][A-Za-z0-9_]*) = process\.env\.DODO_PAYMENTS_ENVIRONMENT === ['"]live_mode['"]\s*\?\s*['"]live['"]\s*:\s*['"]test['"]/,
    );
    assert.ok(
      derivation,
      `${file} no longer derives the entitlement env prefix as live_mode -> 'live', else 'test'`,
    );
    const envVar = derivation[1];

    const keys = [...src.matchAll(/`entitlements:\$\{([A-Za-z_][A-Za-z0-9_]*)\}:\$\{([A-Za-z_][A-Za-z0-9_]*)\}`/g)];
    assert.ok(
      keys.length > 0,
      `${file} no longer builds the entitlements key as entitlements:{env}:{userId}`,
    );
    for (const key of keys) {
      assert.equal(
        key[1],
        envVar,
        `${file} builds an entitlements key from \`${key[1]}\` instead of the env-derived \`${envVar}\` — this is exactly #5600's live/test namespace split`,
      );
    }

    // No second, divergent derivation may exist in the same file: a mutant that
    // adds `const legacy = 'test'` and keys off it would otherwise be caught
    // above, but one that re-derives the prefix a second way would not.
    const derivations = [
      ...src.matchAll(/process\.env\.DODO_PAYMENTS_ENVIRONMENT === ['"]live_mode['"]/g),
    ];
    assert.equal(
      derivations.length,
      1,
      `${file} derives the entitlement env prefix ${derivations.length} times — keep exactly one derivation per file`,
    );
  }
});

test('exactly three files derive the entitlements cache key', async () => {
  // The `sources` list above is hardcoded, so a FOURTH derivation added anywhere
  // in the repo would be invisible to it — the drift would be silent in exactly
  // the way #5600 was. Pin the count repo-wide.
  const { execFileSync } = await import('node:child_process');
  const root = new URL('../', import.meta.url).pathname;
  const out = execFileSync(
    'git',
    ['grep', '-l', '-F', 'entitlements:${', '--', 'api', 'server', 'convex', 'src', 'scripts'],
    { cwd: root, encoding: 'utf8' },
  );
  const files = out.split('\n').filter(Boolean).sort();
  assert.deepEqual(files, [
    'api/_user-api-key.js',
    'convex/payments/cacheActions.ts',
    'server/_shared/entitlement-check.ts',
  ], 'a new entitlements-cache-key derivation appeared; add it to the parity list above');
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
