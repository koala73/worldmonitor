import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isDuplicatedByAcled, deduplicateUcdpProjectionAggregates} from '../src/services/conflict/ucdp-dedupe.ts';
const candidate = {latitude:0, longitude:0, dateMs:Date.parse('2026-09-16'), deathsBest:0};
const acled = {latitude:'0', longitude:'0', event_date:'2026-09-16', fatalities:'0'};
test('valid zero coordinates and numeric strings match', () => assert.equal(isDuplicatedByAcled(candidate,[acled]),true));
for (const patch of [{dateMs:NaN},{dateMs:Infinity},{latitude:NaN},{latitude:91},{longitude:181},{longitude:-181},{latitude:Infinity},{deathsBest:NaN},{deathsBest:-1}]) {
  test(`invalid UCDP observation ${JSON.stringify(patch)} cannot suppress rows or totals`,()=>{
    const row={...candidate,...patch};assert.equal(isDuplicatedByAcled(row,[acled]),false);
    const type='UCDP_VIOLENCE_TYPE_STATE_BASED';const totals={[type]:{count:1,totalDeaths:0}};
    assert.deepEqual(deduplicateUcdpProjectionAggregates(totals,[[0,row.dateMs,row.latitude,row.longitude,row.deathsBest]],[acled]),totals);
  });
}
for (const patch of [{event_date:'invalid'},{event_date:''},{latitude:'bad'},{latitude:''},{latitude:' '},{latitude:91},{longitude:181},{longitude:-Infinity},{fatalities:'bad'},{fatalities:''},{fatalities:-1}]) {
  test(`invalid ACLED observation ${JSON.stringify(patch)} cannot match`,()=>assert.equal(isDuplicatedByAcled(candidate,[{...acled,...patch}]),false));
}
test('invalid comparison does not prevent a later valid match',()=>assert.equal(isDuplicatedByAcled(candidate,[{...acled,event_date:'invalid'},acled]),true));
test('valid distant or old observations remain nonmatches',()=>{
  assert.equal(isDuplicatedByAcled(candidate,[{...acled,latitude:5}]),false);
  assert.equal(isDuplicatedByAcled(candidate,[{...acled,event_date:'2026-08-01'}]),false);
});
