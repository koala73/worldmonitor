import { describe, expect, it } from 'vitest';

import { DEDUCTION_PURIFY_CONFIG } from '../../src/components/DeductionPanel';

// DeductionPanel renders LLM markdown that was grounded on untrusted RSS
// headlines. Default DOMPurify keeps <img> and <a href>, which is enough for a
// prompt-injected headline to plant a tracking pixel or an outbound link in
// the analysis. The panel's config must reduce the output to text structure.
//
// This pins the config object rather than DOMPurify's output: happy-dom's
// NodeIterator breaks DOMPurify's walk (it keeps <img> and drops the parent),
// so sanitizer output under this runner proves nothing. DOMPurify's own suite
// covers ALLOWED_TAGS / ALLOWED_ATTR semantics against a real DOM.
describe('DEDUCTION_PURIFY_CONFIG', () => {
  const tags = new Set(DEDUCTION_PURIFY_CONFIG.ALLOWED_TAGS);

  it('allows no element that can load a subresource or navigate', () => {
    for (const tag of ['img', 'a', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed',
      'svg', 'use', 'form', 'input', 'button', 'link', 'style', 'script', 'base', 'meta']) {
      expect(tags.has(tag), tag).toBe(false);
    }
  });

  it('keeps the structure the deduction prompt produces', () => {
    for (const tag of ['p', 'strong', 'em', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote', 'code', 'pre', 'br']) {
      expect(tags.has(tag), tag).toBe(true);
    }
  });

  it('allows only the class attribute, no data- and no aria- attributes', () => {
    expect(DEDUCTION_PURIFY_CONFIG.ALLOWED_ATTR).toEqual(['class']);
    expect(DEDUCTION_PURIFY_CONFIG.ALLOW_DATA_ATTR).toBe(false);
    expect(DEDUCTION_PURIFY_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
  });
});
