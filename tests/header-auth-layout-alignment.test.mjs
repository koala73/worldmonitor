/**
 * Pin header auth layout thresholds so CSS / e2e literals cannot drift (#10464).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  HEADER_AUTH_FREE_REASON_HIDE_MAX_PX,
  HEADER_AUTH_FREE_REASON_HIDE_MIN_PX,
  HEADER_AUTH_SLOT_MAX_WIDTH_PX,
  HEADER_AUTH_SLOT_MIN_WIDTH_PX,
} from '../src/config/header-auth-layout.ts';

const headerCss = readFileSync(new URL('../src/styles/header.css', import.meta.url), 'utf8');
const reservation = readFileSync(new URL('../e2e/header-reservation.ts', import.meta.url), 'utf8');

describe('header auth layout alignment', () => {
  it('keeps CSS auth-slot floor and preferred width aligned with the TS constants', () => {
    assert.match(headerCss, new RegExp(`--header-auth-slot-width:\\s*${HEADER_AUTH_SLOT_MAX_WIDTH_PX}px`));
    assert.match(headerCss, new RegExp(`min-width:\\s*${HEADER_AUTH_SLOT_MIN_WIDTH_PX}px`));
  });

  it('does not clip #authWidgetMount: the signed-in UserButton popover must stay visible', () => {
    // Strip comments, then match selector blocks that are not at-rules. Nested
    // `#authWidgetMount` rules inside @media / @container are inspected too —
    // a prior regex swallowed the media wrapper and skipped those bodies.
    const withoutComments = headerCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const mountRules = [...withoutComments.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)].filter(([, selector]) =>
      selector
        .split(',')
        .map((part) => part.trim())
        .includes('#authWidgetMount'),
    );
    assert.ok(
      mountRules.length >= 3,
      'finds the shared, sizing, and 981–1199px #authWidgetMount rules',
    );
    for (const [, selector, body] of mountRules) {
      assert.doesNotMatch(
        body,
        /overflow\s*:/,
        `only the pending placeholder may clip, not the mount (${selector.trim()})`,
      );
    }
  });

  it('keeps the free-reason hide band aligned with the TS constants', () => {
    assert.match(
      headerCss,
      new RegExp(
        `@media \\(min-width:\\s*${HEADER_AUTH_FREE_REASON_HIDE_MIN_PX}px\\) and \\(max-width:\\s*${HEADER_AUTH_FREE_REASON_HIDE_MAX_PX}px\\)`,
      ),
    );
  });

  it('keeps the e2e reservation slot width aligned with the preferred auth width', () => {
    assert.match(reservation, new RegExp(`HEADER_AUTH_SLOT_WIDTH\\s*=\\s*${HEADER_AUTH_SLOT_MAX_WIDTH_PX}`));
    assert.match(reservation, new RegExp(`toBe\\('${HEADER_AUTH_SLOT_MIN_WIDTH_PX}px'\\)`));
  });
});
