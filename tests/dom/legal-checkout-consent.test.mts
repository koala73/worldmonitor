/**
 * Behavioral coverage for the pre-payment assent line (#6976).
 *
 * The dashboard renders it two ways — an HTML string for the template-built
 * surfaces (settings, gates) and a DOM node for the element-factory ones (the
 * locked panel). Two renderers is one drift away from a checkout button that
 * shows a different sentence, or the wrong destination, from its neighbour.
 * These cases compare the two against each other rather than each against a
 * hand-copied expectation, so any edit to one that the other does not follow
 * fails here.
 */
import { describe, expect, it } from 'vitest';

import {
  checkoutConsentHtml,
  createCheckoutConsentElement,
  legalLinksHtml,
  LEGAL_LINK_ATTR,
} from '@/utils/legal-links';
import { CHECKOUT_CONSENT_TEXT, EULA_PATH, PRIVACY_PATH, TERMS_PATH } from '../../shared/legal';

const ORIGIN = 'https://worldmonitor.app';

function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const hrefs = (root: HTMLElement) =>
  [...root.querySelectorAll('a')].map(a => a.getAttribute('href'));

describe('checkout consent renderers agree', () => {
  it('render the same sentence', () => {
    const fromHtml = normalize(parse(checkoutConsentHtml(ORIGIN)).textContent ?? '');
    const fromNode = normalize(createCheckoutConsentElement(ORIGIN).textContent ?? '');
    expect(fromHtml).toBe(CHECKOUT_CONSENT_TEXT);
    expect(fromNode).toBe(fromHtml);
  });

  it('render the same destinations, in the same order', () => {
    const expected = [`${ORIGIN}${EULA_PATH}`, `${ORIGIN}${PRIVACY_PATH}`];
    expect(hrefs(parse(checkoutConsentHtml(ORIGIN)))).toEqual(expected);
    expect(hrefs(createCheckoutConsentElement(ORIGIN))).toEqual(expected);
  });

  it('both mark their anchors for the desktop external-URL handoff', () => {
    for (const root of [parse(checkoutConsentHtml(ORIGIN)), createCheckoutConsentElement(ORIGIN)]) {
      const anchors = [...root.querySelectorAll('a')];
      expect(anchors).toHaveLength(2);
      for (const a of anchors) {
        expect(a.hasAttribute(LEGAL_LINK_ATTR)).toBe(true);
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
        expect(a.getAttribute('target')).toBe('_blank');
      }
    }
  });

  it('the legal row and the consent line agree on where each document lives', () => {
    // One typo'd path in one of the two builders is the failure this catches:
    // the footer would still work while the pre-payment link 404s, or vice versa.
    // The consent line links the EULA (#6983); the footer row carries both, so
    // the shared destination to pin is the licence the consent line names.
    const row = parse(legalLinksHtml(ORIGIN));
    const consent = createCheckoutConsentElement(ORIGIN);
    expect(hrefs(row)).toContain(`${ORIGIN}${EULA_PATH}`);
    expect(hrefs(row)).toContain(`${ORIGIN}${TERMS_PATH}`);
    expect(hrefs(consent)).toContain(`${ORIGIN}${EULA_PATH}`);
  });

  it('escape a hostile origin instead of breaking out of the href', () => {
    const html = checkoutConsentHtml('https://evil"><script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(parse(html).querySelector('script')).toBeNull();
  });
});
