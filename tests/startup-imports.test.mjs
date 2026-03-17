import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const urlStateSrc = readFileSync(
  path.join(repoRoot, 'src/utils/urlState.ts'),
  'utf8',
);
const viteConfigSrc = readFileSync(
  path.join(repoRoot, 'vite.config.ts'),
  'utf8',
);

describe('startup-safe imports', () => {
  it('avoids a raw default import for lz-string in the map URL state helper', () => {
    assert.doesNotMatch(
      urlStateSrc,
      /import LZString from 'lz-string';/,
      'urlState should not default-import lz-string under the current package shape',
    );
    assert.match(
      urlStateSrc,
      /import \* as LZString from 'lz-string';/,
      'urlState should keep importing compression helpers from lz-string',
    );
    assert.match(
      urlStateSrc,
      /compressToEncodedURIComponent\(/,
      'urlState should call the named compression helper directly',
    );
    assert.match(
      urlStateSrc,
      /decompressFromEncodedURIComponent\(/,
      'urlState should call the named decompression helper directly',
    );
  });

  it('prebundles lz-string when dependency auto-discovery is disabled', () => {
    assert.match(
      viteConfigSrc,
      /noDiscovery:\s*true/,
      'this repo relies on an explicit optimizeDeps allowlist',
    );
    assert.match(
      viteConfigSrc,
      /'lz-string'/,
      'lz-string should be prebundled so Vite serves an interop wrapper instead of the raw CJS file',
    );
  });
});
