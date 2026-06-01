import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = new URL('..', import.meta.url).pathname;

// Keep this scoped to project-license docs so third-party source license notes
// do not create false positives.
const PROJECT_LICENSE_DOCS = [
  'README.md',
  'docs/license.mdx',
  'docs/trademark-policy.mdx',
  'docs/documentation.mdx',
  'docs/getting-started.mdx',
];

function readProjectLicenseDocs() {
  return PROJECT_LICENSE_DOCS.map((relativePath) => ({
    relativePath,
    text: readFileSync(join(root, relativePath), 'utf8'),
  }));
}

function snippet(text, index, radius = 80) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function assertNoMatch(relativePath, text, pattern, label) {
  const match = pattern.exec(text);
  const diagnostic = match ? snippet(text, match.index, Math.max(120, match[0].length + 40)) : '';

  assert.equal(
    match,
    null,
    `${relativePath} still contains ${label}: ${diagnostic}`,
  );
}

describe('project license docs', () => {
  it('do not claim AGPL prohibits commercial use', () => {
    for (const { relativePath, text } of readProjectLicenseDocs()) {
      assertNoMatch(relativePath, text, /AGPL[\s\S]{0,160}non-?commercial/i, 'AGPL non-commercial framing');
      assertNoMatch(relativePath, text, /non-?commercial[\s\S]{0,160}AGPL/i, 'non-commercial AGPL framing');
      assertNoMatch(relativePath, text, /commercial use requires/i, 'commercial-use-required wording');
      assertNoMatch(relativePath, text, /violation of the AGPL[\s\S]{0,160}make money/i, 'make-money AGPL violation wording');
      assertNoMatch(relativePath, text, /make money[\s\S]{0,160}violation of the AGPL/i, 'make-money AGPL violation wording');
      assertNoMatch(relativePath, text, /cannot use[\s\S]{0,160}commercial purposes/i, 'commercial-purpose prohibition wording');
    }
  });

  it('states the corrected AGPL, network-source, and commercial-license positions', () => {
    const license = readFileSync(join(root, 'docs/license.mdx'), 'utf8');

    assert.match(
      license,
      /Commercial use is permitted under the AGPL/i,
      'license docs must say AGPL permits commercial use',
    );
    assert.match(
      license,
      /modified public network deployment/i,
      'license docs must mention modified public network deployments',
    );
    assert.match(
      license,
      /commercial licensing is an alternative option/i,
      'license docs must frame commercial licensing as an alternative option',
    );
    assert.match(
      license,
      /does not grant rights to use the World Monitor name, logo, visual identity, or official project branding/i,
      'license docs must separate trademark rights from AGPL code rights',
    );
  });
});
