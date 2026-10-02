import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateEmbedKey } from '../src/services/embed-keys.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

/** The edge shape gate in server/_shared/embed-key.ts. */
const EMBED_KEY_RE = /^wme_[a-f0-9]{40}$/;
/** The display-prefix gate in convex/embedKeys.ts. */
const EMBED_PREFIX_RE = /^wme_[a-f0-9]{5}$/;

test('generateEmbedKey produces distinct, high-entropy keys the edge accepts', () => {
  const keys = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const key = generateEmbedKey();
    assert.match(key, EMBED_KEY_RE);
    keys.add(key);
  }
  assert.equal(keys.size, 100, 'expected 100 unique keys');
});

test('the minted prefix satisfies the Convex prefix gate', () => {
  // createEmbedKey slices this prefix before the mutation; a slice tuned for
  // `wm_` (8 chars) would send `wme_abcd` and be rejected as INVALID_PREFIX.
  for (let i = 0; i < 50; i++) {
    assert.match(generateEmbedKey().slice(0, 9), EMBED_PREFIX_RE);
  }
});

test('a wme_ key never satisfies the wm_ user-key shape, and vice versa', () => {
  // The whole credential split rests on these two never overlapping: a wm_ key
  // unlocks the paid REST surface, a wme_ key is published in partner HTML.
  const USER_API_KEY_RE = /^wm_[a-f0-9]{40}$/;
  const embed = generateEmbedKey();
  assert.equal(USER_API_KEY_RE.test(embed), false);
  assert.equal(embed.startsWith('wm_'), false);
  assert.equal(EMBED_KEY_RE.test(`wm_${'a'.repeat(40)}`), false);
});

test('the client service never stores or re-reads the plaintext key', () => {
  const source = readFileSync(resolve(root, 'src/services/embed-keys.ts'), 'utf-8');
  for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB']) {
    assert.equal(
      source.includes(forbidden),
      false,
      `embed-keys must not persist plaintext (found ${forbidden})`,
    );
  }
  assert.ok(source.includes('sha256Hex(plaintext)'), 'only the hash may leave the browser');
  assert.equal(
    /client\.mutation\([^)]*keyHash: plaintext/.test(source),
    false,
    'the plaintext must never be sent to Convex',
  );
});

test('listEmbedKeys cannot recover a plaintext key', () => {
  // The dashboard embed dialog depends on this: it can name a key by prefix
  // but must send the user to Settings -> Embeds to paste the real one.
  const convexSource = readFileSync(resolve(root, 'convex/embedKeys.ts'), 'utf-8');
  const listBody = convexSource.slice(
    convexSource.indexOf('export const listEmbedKeys'),
    convexSource.indexOf('export const revokeEmbedKey'),
  );
  assert.ok(listBody.includes('keyPrefix: k.keyPrefix'), 'the list returns the display prefix');
  assert.equal(listBody.includes('keyHash'), false, 'the list must not return the hash');
});
