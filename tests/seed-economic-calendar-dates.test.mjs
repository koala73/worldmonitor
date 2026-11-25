import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEcbCouncilDates, parseFomcDates } from '../scripts/seed-economic-calendar.mjs';

function fedRow(month, days) {
  return `
        <div class="row fomc-meeting" ">
            <div class="fomc-meeting__month col-xs-5 col-sm-3 col-md-2"><strong>${month}</strong></div>
            <div class="fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1">${days}</div>
            <div class="col-xs-12 col-md-4 col-lg-2">
               <strong>Statement:</strong><br>
            </div>
        </div>`;
}

function fedSection(year, rows) {
  return `<div class="panel-heading"><h4><a id="${year}">${year} FOMC Meetings</a></h4></div>${rows.join('')}`;
}

const FED_PAGE = [
  fedSection(2026, [fedRow('October', '27-28'), fedRow('December', '8-9*')]),
  fedSection(2024, [fedRow('Apr/May', '30-1'), fedRow('September', '22 (notation vote)')]),
  fedSection(2027, [fedRow('January', '26-27')]),
  '<p>Note: A two-day meeting is scheduled for January 25-26, 2028. Each meeting date is tentative until confirmed at the meeting immediately preceding it.</p>',
].join('\n');

function ecbEntry(date, description) {
  return `<dt> \t\n${date}\n</dt>\n<dd>        \n${description}<br>\n</dd>\t        \t\n`;
}

const ECB_PAGE = `<div class="definition-list -zebra"><dl>
${ecbEntry('25/11/2026', 'Governing Council of the ECB: non-monetary policy meeting (in Frankfurt)')}
${ecbEntry('26/11/2026', 'General Council meeting of the ECB in Frankfurt')}
${ecbEntry('16/12/2026', 'Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 1)')}
${ecbEntry('17/12/2026', 'Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 2), followed by press conference')}
${ecbEntry('03/02/2027', 'Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 1)')}
${ecbEntry('04/02/2027', 'Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 2), followed by press conference')}
</dl></div>`;

describe('economic calendar central bank dates', () => {
  it('reads every scheduled FOMC decision even when a note carries an inline future date', () => {
    assert.deepEqual(parseFomcDates(FED_PAGE), [
      '2024-05-01',
      '2026-10-28',
      '2026-12-09',
      '2027-01-27',
      '2028-01-26',
    ]);
  });

  it('labels only the ECB Day 2 entry of each monetary policy meeting as a rate decision', () => {
    assert.deepEqual(parseEcbCouncilDates(ECB_PAGE), ['2026-12-17', '2027-02-04']);
  });
});
