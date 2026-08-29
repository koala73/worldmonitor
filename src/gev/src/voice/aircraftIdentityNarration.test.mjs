import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const voiceConfig = readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8');
const realtime = readFileSync(new URL('./gevRealtime.js', import.meta.url), 'utf8');

test('aircraft identity narration acknowledges missing enrichment', () => {
  const start = voiceConfig.indexOf("'For \"what is this aircraft?\" answers");
  assert.ok(start >= 0, 'aircraft identity honesty instruction is missing');
  const text = voiceConfig.slice(start, voiceConfig.indexOf('\n', start));
  assert.match(text, /get_entity_context selected\.properties/);
  assert.match(text, /callsign, operator, registration, type, and route/);
  assert.match(text, /route, routeOrigin, and routeDestination as the only authoritative route fields/);
  assert.match(text, /Every aircraft identity answer MUST explicitly cover operator, type, and route/);
  assert.match(text, /repeat its endpoint codes exactly/);
  assert.match(text, /do not expand airport codes into city names/);
  assert.match(text, /"Operator details are unavailable"/);
  assert.match(text, /"Aircraft type is unavailable"/);
  assert.match(text, /"Route details are unavailable"/);
  assert.match(text, /never silently omit missing enrichment/i);
  assert.match(text, /never .* infer it from the callsign/i);

  const followupStart = realtime.indexOf("if (result?.action === 'get_entity_context')");
  const followupEnd = realtime.indexOf("if (result?.action === 'get_current_view_state')", followupStart);
  assert.ok(followupStart >= 0 && followupEnd > followupStart, 'entity-context follow-up instruction is missing');
  const followup = realtime.slice(followupStart, followupEnd);
  assert.match(followup, /selectedLayerId === 'flights' \|\| selectedLayerId === 'military'/);
  assert.match(followup, /Begin with the returned callsign and include the returned registration when available/);
  assert.match(followup, /explicitly cover operator, aircraft type, and route before finishing/);
  assert.match(followup, /selectedProperties\.operator/);
  assert.match(followup, /selectedProperties\.type/);
  assert.match(followup, /selectedProperties\.route \|\| selectedProperties\.routeOrigin \|\| selectedProperties\.routeDestination/);
  assert.match(followup, /Operator details are unavailable/);
  assert.match(followup, /Aircraft type is unavailable/);
  assert.match(followup, /Route details are unavailable/);
});
