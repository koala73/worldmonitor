import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const deckGlMapSrc = readFileSync(resolve(__dirname, '../src/components/DeckGLMap.ts'), 'utf-8');

function extractRegexConst(name, source = deckGlMapSrc) {
  const match = source.match(new RegExp(`const ${name} = (/[^;]+/[dgimsuvy]*);`));
  assert.ok(match, `${name} must remain a regex literal`);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${match[1]}`)();
}

const messageRe = extractRegexConst('DECK_INTERLEAVED_RACE_MESSAGE_RE');
const sourceRe = extractRegexConst('DECK_INTERLEAVED_RACE_SOURCE_RE');

function shouldSuppress({ message, filename = '', stack = '' }) {
  return messageRe.test(message) && sourceRe.test(`${filename}\n${stack}`);
}

describe('DeckGLMap interleaved render race console filter', () => {
  it('matches the deck.gl null-id race when Sentry owns ev.filename but deck-stack is in the stack', () => {
    const stack = [
      "TypeError: Cannot read properties of null (reading 'id')",
      '    at DeckRenderer._drawLayers (https://app.worldmonitor.app/assets/deck-stack-Dq2qX5Bt.js:1606:18)',
      '    at LayerManager.renderLayers (https://app.worldmonitor.app/assets/deck-stack-Dq2qX5Bt.js:5000:12)',
      '    at r (https://app.worldmonitor.app/assets/sentry-DMxp_zBn.js:488:7)',
    ].join('\n');

    assert.equal(shouldSuppress({
      message: "Cannot read properties of null (reading 'id')",
      filename: 'https://app.worldmonitor.app/assets/sentry-DMxp_zBn.js',
      stack,
    }), true);
  });

  it('still matches direct deck-stack filenames, including bare chunk names', () => {
    assert.equal(shouldSuppress({
      message: "Cannot read properties of null (reading 'id')",
      filename: 'deck-stack-Dq2qX5Bt.js',
    }), true);
    assert.equal(shouldSuppress({
      message: "Cannot read properties of null (reading 'id')",
      filename: 'https://app.worldmonitor.app/assets/deck-stack-Dq2qX5Bt.js',
    }), true);
  });

  it('does not suppress the same null-id message without deck-stack evidence', () => {
    assert.equal(shouldSuppress({
      message: "Cannot read properties of null (reading 'id')",
      filename: 'https://app.worldmonitor.app/assets/main-Dq2qX5Bt.js',
      stack: '    at firstPartyRender (https://app.worldmonitor.app/assets/main-Dq2qX5Bt.js:10:2)',
    }), false);
  });

  it('does not suppress unrelated errors from deck-stack chunks', () => {
    assert.equal(shouldSuppress({
      message: "Cannot read properties of null (reading 'type')",
      filename: 'https://app.worldmonitor.app/assets/deck-stack-Dq2qX5Bt.js',
    }), false);
  });

  it('uses ev.error.stack in the installed error listener', () => {
    assert.match(deckGlMapSrc, /ev\.error\?\.stack/);
    assert.match(deckGlMapSrc, /DECK_INTERLEAVED_RACE_SOURCE_RE\.test\(source\)/);
  });

  it('preserves regex flags when extracting literals from source', () => {
    const re = extractRegexConst('EXAMPLE_RE', 'const EXAMPLE_RE = /^deck-stack-.+\\.js$/m;');
    assert.equal(re.flags, 'm');
    assert.equal(re.test('first line\ndeck-stack-Dq2qX5Bt.js'), true);
  });
});
