'use strict';

const assert = require('node:assert/strict');
const schemaTools = require('zapier-platform-core/src/tools/schema');

const App = require('../index');

describe('compiled Zapier schema', () => {
  it('validates after compileApp', () => {
    const errors = schemaTools.validateApp(schemaTools.compileApp(App));
    assert.deepEqual(errors, []);
  });
});
