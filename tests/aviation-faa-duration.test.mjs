import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFaaDurationMinutes, parseFaaXml } from '../scripts/seed-aviation.mjs';

test('FAA prose durations convert hours to minutes', () => {
  assert.equal(parseFaaDurationMinutes('3 hours and 1 minute', 15), 181);
  assert.equal(parseFaaDurationMinutes('2 hours and 18 minutes', 30), 138);
  assert.equal(parseFaaDurationMinutes('1 hour', 30), 60);
  assert.equal(parseFaaDurationMinutes('45 minutes', 30), 45);
  assert.equal(parseFaaDurationMinutes('', 30), 30);
  assert.equal(parseFaaDurationMinutes('n/a', 30), 30);
});

// Shape copied from the live FAA airport status feed (2026-11-14).
test('FAA ground delay and departure delays keep their hours', () => {
  const xml = '<AIRPORT_STATUS_INFORMATION>'
    + '<Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>SFO</ARPT><Reason>wind</Reason><Avg>2 hours and 18 minutes</Avg><Max>11 hours and 30 minutes</Max></Ground_Delay></Ground_Delay_List></Delay_type>'
    + '<Delay_type><Name>General Arrival/Departure Delay Info</Name><Arrival_Departure_Delay_List><Delay><ARPT>ATL</ARPT><Reason>OTHER: NATIONAL STOP</Reason><Arrival_Departure Type="Departure"><Min>3 hours and 1 minute</Min><Max>3 hours and 15 minutes</Max><Trend>Increasing</Trend></Arrival_Departure></Delay></Arrival_Departure_Delay_List></Delay_type>'
    + '</AIRPORT_STATUS_INFORMATION>';
  const delays = parseFaaXml(xml);
  assert.equal(delays.get('SFO').avgDelay, 138);
  assert.equal(delays.get('ATL').avgDelay, 188);
});
