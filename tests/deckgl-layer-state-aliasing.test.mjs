import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = readFileSync(resolve(root, 'src/components/DeckGLMap.ts'), 'utf-8');

describe('DeckGLMap layer state isolation', () => {
  it('clones initial layer state in the constructor', () => {
    assert.match(
      src,
      /constructor\(container: HTMLElement, initialState: DeckMapState\)[\s\S]*this\.state = \{[\s\S]*layers: \{ \.\.\.initialState\.layers \},[\s\S]*\}/,
      'DeckGLMap constructor should copy initialState.layers instead of retaining the caller object'
    );
  });

  it('clones incoming layers in setLayers before storing them', () => {
    assert.match(
      src,
      /public setLayers\(layers: MapLayers\): void \{[\s\S]*const nextLayers = \{ \.\.\.layers \};[\s\S]*this\.state\.layers = nextLayers;/,
      'setLayers should copy the incoming layers object before storing it'
    );
  });
});
