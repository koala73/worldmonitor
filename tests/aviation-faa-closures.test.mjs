import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFaaAlerts, parseFaaXml } from '../scripts/seed-aviation.mjs';

// Shape and Reason text copied from the live FAA airport status feed (2026-10-29).
const xml = (closures, delays = '') => `<AIRPORT_STATUS_INFORMATION><Update_Time>Thu Oct 29 19:01:09 2026 GMT</Update_Time>${delays}`
  + `<Delay_type><Name>Airport Closures</Name><Airport_Closure_List>${closures}</Airport_Closure_List></Delay_type></AIRPORT_STATUS_INFORMATION>`;
const closure = (arpt, reason) => `<Airport><ARPT>${arpt}</ARPT><Reason>${reason}</Reason><Start>Oct 27 at 06:30 UTC.</Start><Reopen>Oct 31 at 13:15 UTC.</Reopen></Airport>`;

const GA_ONLY = {
  LAX: '!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR CTC ATLANTIC AVIATION 310-258-9884 OR SIGNATURE AVIATION 310-410-9605 2605271826-2705281600',
  SAN: '!SAN 10/004 SAN AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC PPR 619-298-7704 2610011633-2701010800',
  LAS: '!LAS 10/160 LAS AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR 702-261-7775 2610281926-2701272300',
};

test('FAA closures limited to non-scheduled transient GA do not close the airport', () => {
  const delays = parseFaaXml(xml(Object.entries(GA_ONLY).map(([a, r]) => closure(a, r)).join('')));
  assert.deepEqual([...delays.keys()], []);
  assert.deepEqual(buildFaaAlerts(delays), []);
});

test('a GA-only closure leaves the airport\'s real delay in place', () => {
  const delay = '<Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>SAN</ARPT><Reason>airport volume</Reason><Avg>28 minutes</Avg><Max>1 hour and 4 minutes</Max></Ground_Delay></Ground_Delay_List></Delay_type>';
  const delays = parseFaaXml(xml(closure('SAN', GA_ONLY.SAN), delay));
  assert.equal(delays.get('SAN')?.type, 'ground_delay');
  assert.equal(delays.get('SAN')?.reason, 'airport volume');
});

test('a full FAA airport closure is still reported', () => {
  const delays = parseFaaXml(xml(closure('MCO', '!MCO 10/001 MCO AD AP CLSD 2610290000-2610300000') + closure('LAX', GA_ONLY.LAX)));
  assert.deepEqual([...delays.keys()], ['MCO']);
  assert.equal(delays.get('MCO')?.reason, 'Airport closure');
  assert.equal(buildFaaAlerts(delays)[0]?.severity, 'FLIGHT_DELAY_SEVERITY_SEVERE');
});
