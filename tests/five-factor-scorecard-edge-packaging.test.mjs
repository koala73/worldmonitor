import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  renderScorecardEdgeMirror,
  SCORECARD_EDGE_MIRRORS,
} from '../scripts/generate-scorecard-edge-mirrors.mjs';

const EDGE_DIR = new URL('../server/worldmonitor/scorecard/v1/', import.meta.url);
const SOURCE_DIR = new URL('../scripts/scorecard/v1/', import.meta.url);

describe('five-factor Edge packaging', () => {
  it('mirrors the complete canonical scorecard module set', () => {
    const canonicalModules = readdirSync(SOURCE_DIR)
      .filter((file) => file.endsWith('.mts'))
      .map((file) => file.slice(0, -'.mts'.length))
      .sort();
    assert.deepEqual(canonicalModules, [...SCORECARD_EDGE_MIRRORS].sort());
  });

  it('keeps the Edge runtime graph inside the server tree', () => {
    for (const name of SCORECARD_EDGE_MIRRORS) {
      const file = `${name}.ts`;
      const url = new URL(file, EDGE_DIR);
      assert.equal(existsSync(url), true, `${file} must be present in the Edge tree`);
      const source = readFileSync(url, 'utf8');
      assert.doesNotMatch(
        source,
        /from\s+['"][^'"]*scripts\/scorecard\/v1/,
        `${file} must not import the Railway-only source tree`,
      );
      assert.doesNotMatch(
        source,
        /(?:from\s+|import\s*\(\s*)['"][^'"]+\.mts['"]/,
        `${file} must not retain Railway TypeScript import specifiers`,
      );
    }
  });

  it('keeps every Edge mirror byte-current with the canonical Railway source', () => {
    for (const name of SCORECARD_EDGE_MIRRORS) {
      const canonical = readFileSync(new URL(`${name}.mts`, SOURCE_DIR), 'utf8');
      const edge = readFileSync(new URL(`${name}.ts`, EDGE_DIR), 'utf8');
      assert.equal(edge, renderScorecardEdgeMirror(name, canonical), `${name}.ts is stale`);
    }
  });
});
