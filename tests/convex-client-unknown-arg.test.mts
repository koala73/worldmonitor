// ensureRecord retries without an optional field an older Convex deployment
// rejects. The validator error also lists the fields it accepts, so only the
// "extra field `<name>`" clause may identify the field to drop.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUnknownArgError } from '../src/services/convex-client.ts';

const rejectsUiLanguage = new Error(
  'ArgumentValidationError: Object contains extra field `uiLanguage` that is not in the validator.\n\n'
  + 'Object: {signupRef: "agent:abc", uiLanguage: "fr"}\nValidator: v.object({signupRef: v.optional(v.string())})',
);

describe('isUnknownArgError', () => {
  it('names only the field the validator rejected', () => {
    assert.equal(isUnknownArgError(rejectsUiLanguage, 'uiLanguage'), true);
    assert.equal(isUnknownArgError(rejectsUiLanguage, 'signupRef'), false);
  });

  it('ignores errors that are not argument validation', () => {
    assert.equal(isUnknownArgError(new Error('extra field `uiLanguage` while offline'), 'uiLanguage'), false);
    assert.equal(isUnknownArgError(undefined, 'uiLanguage'), false);
  });
});
