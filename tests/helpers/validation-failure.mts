import assert from 'node:assert/strict';

// Each generated service module declares its own ValidationError class, so
// match the shape instead of one module's constructor.
export function validationFailure(field: string, description?: RegExp) {
  return (error: unknown): true => {
    const failure = error as { name?: string; violations?: { field: string; description: string }[] };
    assert.equal(failure?.name, 'ValidationError', `expected a ValidationError, got ${String(error)}`);
    assert.equal(failure.violations?.length, 1);
    assert.equal(failure.violations![0]!.field, field);
    if (description) assert.match(failure.violations![0]!.description, description);
    return true;
  };
}
