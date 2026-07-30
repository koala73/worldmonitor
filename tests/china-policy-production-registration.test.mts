import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { BOOTSTRAP_CACHE_KEYS } from '../shared/bootstrap-tier-keys.js';
import { DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS } from '../shared/decision-signal-provenance-families';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('China policy production registration (#5576)', () => {
  it('launches the typed-document family and schedules the bounded seed lane', () => {
    assert.equal(
      DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS.typed_document_event.launchStatus,
      'launched',
    );
    const bundle = read('scripts/seed-bundle-macro.mjs');
    assert.match(bundle, /script:\s*'seed-china-policy-events\.mjs'/);
    assert.match(bundle, /canonicalKey:\s*'china:policy-events:v1'/);
  });

  it('registers bootstrap, independent seed health, and China coverage surfaces', () => {
    assert.equal(BOOTSTRAP_CACHE_KEYS.chinaPolicyEvents, 'china:policy-events:v1');
    assert.match(read('api/health.js'), /chinaPolicyEvents:\s*\{\s*key:\s*'seed-meta:china:policy-events'/);
    assert.match(
      read('api/seed-health.js'),
      /'china:policy-events':\s*\{\s*key:\s*'seed-meta:china:policy-events',\s*intervalMin:\s*360\s*\}/,
    );
    assert.match(
      read('scripts/china-coverage-manifest.mjs'),
      /id:\s*'policy\.official-events'[\s\S]*?launchStatus:\s*'launched'/,
    );
  });
});
