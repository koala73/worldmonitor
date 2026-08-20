import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Keep this scoped to project-license docs so third-party source license notes
// do not create false positives.
const PROJECT_LICENSE_DOCS = [
  'README.md',
  'docs/license.mdx',
  'docs/eula.mdx',
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
  it('keeps the canonical AGPL header first and project notices below the complete text', () => {
    const license = readFileSync(join(root, 'LICENSE'), 'utf8');
    const firstContentLine = license.split('\n').find((line) => line.trim().length > 0);
    const agplEnd = license.indexOf('END OF TERMS AND CONDITIONS');
    const projectHeader = license.indexOf('World Monitor — Real-time global intelligence dashboard');
    const projectCopyright = license.indexOf('Copyright (C) 2024-2026 Elie Habib');
    const projectNotice = license.indexOf('\nThis program is free software:');

    assert.equal(firstContentLine?.trim(), 'GNU AFFERO GENERAL PUBLIC LICENSE', 'root LICENSE must start with the canonical AGPL header');
    assert.ok(agplEnd >= 0, 'root LICENSE must contain the complete AGPL text');
    assert.ok(projectHeader > agplEnd, 'project header must follow the complete AGPL text');
    assert.ok(projectCopyright > agplEnd, 'project copyright must follow the complete AGPL text');
    assert.ok(projectNotice > agplEnd, 'project notice must follow the complete AGPL text');
  });

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

  const PLAN_LABELS = [
    'Personal license (Pro)',
    'Commercial license (Pro Business)',
    'Commercial license — for your organization (API Starter)',
    'Commercial license — for your customers (API Business)',
  ];

  it('defines each hosted-service plan license in the EULA without conflating it with the code license', () => {
    const eula = readFileSync(join(root, 'docs/eula.mdx'), 'utf8');

    for (const label of PLAN_LABELS) {
      assert.match(eula, new RegExp(label.replace(/[()]/g, '\\$&'), 'i'));
    }
    assert.match(eula, /customer-facing product/i);
    assert.match(eula, /standalone database or substantially similar feed/i);
    assert.match(
      eula,
      /Nothing in this Agreement removes, narrows, or adds conditions to any right the AGPL or MIT licenses grant you in that code/i,
      'the EULA must state that it does not narrow the source-code licenses',
    );
  });

  it('keeps the Terms pointing at the EULA instead of re-deciding plan scope', () => {
    const terms = readFileSync(join(root, 'docs/terms.mdx'), 'utf8');

    assert.match(terms, /\[End User License Agreement\]\(\/eula\)/, 'Terms must link the EULA');
    assert.match(terms, /\/eula#41-plan-license-scopes/, 'Terms must deep-link the plan scopes in the EULA');
    for (const label of PLAN_LABELS) {
      assert.match(terms, new RegExp(label.replace(/[()]/g, '\\$&'), 'i'));
    }
    assert.match(terms, /source code remains subject to AGPL-3\.0-only/i);
    assert.match(terms, /official thin client packages remain subject to MIT/i);

    // The Terms may summarise the plans, never restate the normative table —
    // two tables drift, and the EULA is the one that controls.
    assert.equal(
      /\|\s*Plan license\s*\|/i.test(terms),
      false,
      'the plan-scope table belongs in docs/eula.mdx only',
    );
  });

  it('licenses every access surface in one agreement, not one per surface', () => {
    const eula = readFileSync(join(root, 'docs/eula.mdx'), 'utf8');

    for (const surface of [
      /web dashboard/i,
      /desktop applications?/i,
      /REST API/i,
      /MCP server/i,
      /SDKs? and CLI/i,
      /embeds? and widgets/i,
      /alerts, webhooks/i,
    ]) {
      assert.match(eula, surface, `EULA must cover ${surface}`);
    }

    assert.match(
      eula,
      /The application binary is licensed to you under AGPL-3\.0-only, not under this Agreement/i,
      'the desktop section must not claim EULA authority over the AGPL binary',
    );
    assert.match(
      eula,
      /the same license, not two/i,
      'desktop and web must be stated as one license',
    );

    for (const cls of [/R1 — Derived facts and scores/i, /R2 — Structured events/i, /R3 — Headline and snippet/i, /R4 — Full source content/i]) {
      assert.match(eula, cls, `EULA output-rights schedule must define ${cls}`);
    }
    assert.match(eula, /Retention and caching are granted, not merely tolerated/i);
  });

  it('keeps hosted-service attribution guidance consistent across legal and pricing docs', () => {
    const documents = [
      {
        relativePath: 'docs/eula.mdx',
        sourceNoticePattern: /must still preserve any source-specific citation/i,
      },
      {
        relativePath: 'docs/pricing.mdx',
        sourceNoticePattern: /Source-specific notices supplied with an output still apply/i,
      },
      {
        relativePath: 'public/pricing.md',
        sourceNoticePattern: /Source-specific notices supplied with an output still apply/i,
      },
    ];

    for (const { relativePath, sourceNoticePattern } of documents) {
      const text = readFileSync(join(root, relativePath), 'utf8');

      assert.match(text, /(?:Attribution to World Monitor|World Monitor attribution) is optional/i);
      assert.match(text, /"Source: World Monitor" or "via World Monitor" is sufficient/i);
      assert.match(text, sourceNoticePattern);
    }
  });
});
