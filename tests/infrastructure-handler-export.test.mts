import { test } from 'node:test';
import assert from 'node:assert';
import { infrastructureHandler } from '../server/worldmonitor/infrastructure/v1/handler';

test('infrastructureHandler export exists', () => {
  // Ensures that the infrastructureHandler is not accidentally deleted
  // by future PRs or AI generated code. This export is heavily relied upon
  // by the Vite configuration and API routes.
  assert.ok(infrastructureHandler !== undefined, 'infrastructureHandler should be defined');
  assert.ok('getCableHealth' in infrastructureHandler, 'infrastructureHandler should have getCableHealth property');
});
