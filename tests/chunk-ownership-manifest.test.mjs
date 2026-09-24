// Build-time chunk ownership manifest — classifier, emitted snippet, and the
// contract between the build (vite.config.ts) and the runtime reader
// (src/bootstrap/sentry-init.ts).
//
// Why this exists: `beforeSend` runs in the browser before sourcemapping, so a
// hashed filename was the only ownership signal and it was read with a
// hand-maintained name regex. That is unsound — Rollup names a chunk after its
// seed module and then hoists shared modules into it, so on a real build
// `i18n-<hash>.js` held 12/12 first-party modules while a SECOND, genuinely
// pure chunk shared the name `i18n`. Two chunks, one name, opposite ownership:
// no name rule can separate them, so the build stamps each chunk instead.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHUNK_OWNERSHIP_GLOBAL,
  CHUNK_FIRST_PARTY,
  CHUNK_VENDOR,
  appendChunkOwnership,
  buildChunkOwnershipSnippet,
  chunkHasFirstPartyModule,
} from '../shared/chunk-ownership.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sentryInitSrc = readFileSync(resolve(here, '../src/bootstrap/sentry-init.ts'), 'utf8');
const viteConfigSrc = readFileSync(resolve(here, '../vite.config.ts'), 'utf8');

describe('chunkHasFirstPartyModule', () => {
  it('classifies a pure node_modules chunk as vendor', () => {
    assert.equal(chunkHasFirstPartyModule([
      '/repo/node_modules/h3-js/dist/h3-js.esm.js',
      '/repo/node_modules/protomaps/index.js',
    ]), false);
  });

  it('classifies a chunk holding one of our modules as first-party', () => {
    // The live i18n case: vendor-named, overwhelmingly ours.
    assert.equal(chunkHasFirstPartyModule([
      '/repo/node_modules/i18next/dist/esm/i18next.js',
      '/repo/src/utils/safe-storage.ts',
    ]), true);
  });

  it('ignores rollup virtual/helper ids, which belong to no one', () => {
    assert.equal(chunkHasFirstPartyModule(['\0vite/preload-helper']), false);
    assert.equal(chunkHasFirstPartyModule(['\0commonjsHelpers.js']), false);
  });

  it('treats an empty chunk as vendor rather than guessing', () => {
    assert.equal(chunkHasFirstPartyModule([]), false);
  });

  it('does not let a node_modules path anywhere in the id make our file vendor', () => {
    // A repo checked out under a directory containing `node_modules` would be
    // pathological, but a plain src path must never be misread.
    assert.equal(chunkHasFirstPartyModule(['/repo/src/components/DeckGLMap.ts']), true);
  });
});

describe('buildChunkOwnershipSnippet', () => {
  it('emits an idempotent registration keyed by basename', () => {
    const snippet = buildChunkOwnershipSnippet('i18n-0kRCkTIm.js', true);
    assert.match(snippet, /globalThis\.__WM_CHUNK_OWNERSHIP__/);
    assert.match(snippet, /"i18n-0kRCkTIm\.js"\]=1;/);
    // Must not clobber an already-populated manifest from another chunk.
    assert.match(snippet, /\|\|\(globalThis\.__WM_CHUNK_OWNERSHIP__=\{\}\)/);
  });

  it('marks vendor chunks with 0', () => {
    assert.match(buildChunkOwnershipSnippet('h3-js-BR3gmGp0.js', false), /\]=0;/);
  });

  it('actually accumulates when several chunks evaluate in sequence', () => {
    const scope = {};
    const run = (code) => new Function('globalThis', code)(scope);
    run(buildChunkOwnershipSnippet('i18n-0kRCkTIm.js', true));
    run(buildChunkOwnershipSnippet('h3-js-BR3gmGp0.js', false));
    run(buildChunkOwnershipSnippet('deck-stack-BTXFZgJo.js', true));
    assert.deepEqual(scope[CHUNK_OWNERSHIP_GLOBAL], {
      'i18n-0kRCkTIm.js': CHUNK_FIRST_PARTY,
      'h3-js-BR3gmGp0.js': CHUNK_VENDOR,
      'deck-stack-BTXFZgJo.js': CHUNK_FIRST_PARTY,
    });
  });

  it('starts with a statement separator so it cannot fuse with the chunk tail', () => {
    // Minified chunks routinely end without a semicolon; appending `(globalThis…`
    // straight onto `…}` would parse as a call and throw at runtime.
    assert.match(buildChunkOwnershipSnippet('x-1.js', true), /^\n;\(/);
  });
});

describe('appendChunkOwnership', () => {
  const MAP = '\n//# sourceMappingURL=x-1.js.map';

  it('keeps the sourceMappingURL comment last', () => {
    const out = appendChunkOwnership(`export const a=1;${MAP}`, 'x-1.js', true);
    assert.ok(out.endsWith(MAP), 'sourcemap comment must remain the final line');
    assert.match(out, /"x-1\.js"\]=1;\n\/\/# sourceMappingURL=/);
  });

  it('appends at the end when there is no sourcemap comment', () => {
    const out = appendChunkOwnership('export const a=1;', 'x-1.js', false);
    assert.ok(out.startsWith('export const a=1;'));
    assert.match(out, /"x-1\.js"\]=0;$/);
  });

  it('does not disturb earlier offsets, so sourcemap columns stay valid', () => {
    // The whole reason this appends rather than prepends: chunks are one
    // minified line and a prefix would shift every mapping on it.
    const body = 'export const a=1;';
    const out = appendChunkOwnership(`${body}${MAP}`, 'x-1.js', true);
    assert.equal(out.slice(0, body.length), body);
  });

  it('only matches a sourcemap comment at the start of a line', () => {
    // A `//# sourceMappingURL=` substring inside a string literal must not be
    // mistaken for the trailing comment and split the code there.
    const tricky = 'export const s="//# sourceMappingURL=not-real";';
    const out = appendChunkOwnership(tricky, 'x-1.js', true);
    assert.ok(out.startsWith(tricky), 'must not splice inside the literal');
  });

  it('produces code that still parses after stamping', () => {
    // Minified chunks often end without a semicolon.
    const out = appendChunkOwnership('const a=1', 'x-1.js', true);
    assert.doesNotThrow(() => new Function('globalThis', out));
  });
});

describe('build <-> runtime contract', () => {
  it('sentry-init reads exactly the global the manifest writes', () => {
    assert.ok(
      sentryInitSrc.includes(`globalThis.${CHUNK_OWNERSHIP_GLOBAL}`),
      `sentry-init.ts must read globalThis.${CHUNK_OWNERSHIP_GLOBAL}`,
    );
  });

  it('the vite plugin is registered and CALLS the shared helpers', () => {
    assert.ok(viteConfigSrc.includes('firstPartyChunkManifestPlugin()'), 'plugin must be registered');
    // Assert the call sites, not the import line. An earlier version of this
    // test matched the bare identifiers and stayed green while the plugin body
    // called a helper that was no longer imported — the build caught it, the
    // test did not.
    assert.ok(viteConfigSrc.includes('appendChunkOwnership('), 'plugin must call the shared splicer');
    assert.ok(viteConfigSrc.includes('chunkHasFirstPartyModule('), 'plugin must call the shared classifier');
  });

  it('the runtime still keeps the name regex as an explicit fallback', () => {
    // A chunk that has not evaluated yet is UNKNOWN, not vendor. Dropping the
    // fallback would make an unregistered chunk suppressible and regress the
    // dev/serve path, where no manifest exists at all.
    assert.ok(sentryInitSrc.includes('const vendorChunk = /'), 'fallback regex must remain');
  });
});
