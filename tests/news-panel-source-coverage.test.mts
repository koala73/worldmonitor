/**
 * Unit tests for the news panel's source-coverage disclosure
 * (src/components/news/source-coverage.ts).
 *
 * The second half of #5873. A custom news category — a panel the user added
 * from another variant — is never in the per-variant server digest, so it
 * fetches a capped, rotating window of its sources per refresh cycle and
 * accumulates. For the first cycles the panel is therefore genuinely showing
 * only part of its source list, while the Sources manager lists every one of
 * them as enabled. The badge has to say so; the alternative is a panel that
 * under-delivers while presenting itself as complete.
 *
 * This module owns the DECISION (disclose or stay quiet, and with what text).
 * The panel owns only the painting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { coverageBadgeString } from '../src/components/news/source-coverage.ts';

/** Stand-in for i18n `t()`: renders the key with its interpolations applied. */
const translate = (key: string, vars: Record<string, string>) =>
  `${key}[${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}]`;

/** A dictionary that hasn't loaded yet — i18next returns the key untouched. */
const unresolved = (key: string) => key;

describe('coverageBadgeString', () => {
  it('discloses a partial source count', () => {
    assert.equal(
      coverageBadgeString({ covered: 3, total: 10 }, 'sourceCoverage', translate),
      'components.newsPanel.sourceCoverage[covered=3,total=10]',
    );
  });

  it('renders the explanatory hint from the same coverage', () => {
    assert.equal(
      coverageBadgeString({ covered: 3, total: 10 }, 'sourceCoverageHint', translate),
      'components.newsPanel.sourceCoverageHint[covered=3,total=10]',
    );
  });

  it('stays quiet when every source is represented', () => {
    // Rotation reaches full coverage after a few cycles. A badge that kept
    // reading "10/10 sources" forever would be noise on every custom panel.
    assert.equal(coverageBadgeString({ covered: 10, total: 10 }, 'sourceCoverage', translate), undefined);
  });

  it('stays quiet when there is no coverage to report', () => {
    // `null` is the digest-backed / preset case — the overwhelming majority of
    // panels. They must keep reading plain LIVE.
    assert.equal(coverageBadgeString(null, 'sourceCoverage', translate), undefined);
  });

  it('stays quiet rather than dividing by an empty source list', () => {
    assert.equal(coverageBadgeString({ covered: 0, total: 0 }, 'sourceCoverage', translate), undefined);
    assert.equal(coverageBadgeString({ covered: 0, total: -1 }, 'sourceCoverage', translate), undefined);
  });

  it('discloses zero coverage — a panel showing none of its sources is the loudest case', () => {
    assert.notEqual(coverageBadgeString({ covered: 0, total: 10 }, 'sourceCoverage', translate), undefined);
  });

  it('stays quiet when a covered count somehow exceeds the total', () => {
    // Defensive: `covered` is derived from rendered items and `total` from the
    // enabled feed list, and a source can be disabled between the two reads.
    // "11/10 sources" would be worse than no badge at all.
    assert.equal(coverageBadgeString({ covered: 11, total: 10 }, 'sourceCoverage', translate), undefined);
  });

  it('drops the detail when the dictionary cannot resolve the key', () => {
    // These strings live outside the first-paint i18n shell. An unresolved key
    // composes into `LIVE · components.newsPanel.sourceCoverage`, which the
    // raw-key healer cannot repair — it only rewrites EXACT key matches. A
    // plain LIVE badge beats a badge showing an i18n key to the user.
    assert.equal(coverageBadgeString({ covered: 3, total: 10 }, 'sourceCoverage', unresolved), undefined);
    assert.equal(coverageBadgeString({ covered: 3, total: 10 }, 'sourceCoverageHint', unresolved), undefined);
  });

  it('passes the counts as strings, the shape i18next interpolation expects', () => {
    const seen: Array<Record<string, string>> = [];
    coverageBadgeString({ covered: 3, total: 10 }, 'sourceCoverage', (key, vars) => {
      seen.push(vars);
      return key + '!';
    });
    assert.deepEqual(seen, [{ covered: '3', total: '10' }]);
  });
});
