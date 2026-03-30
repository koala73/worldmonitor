import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWpcWinterWeatherKml } from '../src/services/wpc-winter-weather.ts';

const SAMPLE_SNOW_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document id="Day1-3_psnow_gt_08">
    <name>Day 1-3 WPC PRBLTY of Snow &gt; 8"</name>
    <description><![CDATA[
      <table><tr><td>Issued: 0913Z TUE JAN 30, 2024</td></tr></table>
    ]]></description>
    <Folder>
      <name>WPC Winter Weather Forecasts</name>
      <Folder>
        <name>Day 1 PRBLTY of Snow &gt; 8"</name>
        <TimeSpan>
          <begin>2024-01-30T12:00:00Z</begin>
          <end>2024-01-31T12:00:00Z</end>
        </TimeSpan>
        <Placemark>
          <name>High</name>
          <styleUrl>#poly_high</styleUrl>
          <MultiGeometry>
            <Polygon>
              <outerBoundaryIs>
                <LinearRing>
                  <coordinates>
                    -97.8,34.9,0 -97.0,34.9,0 -97.0,35.5,0 -97.8,35.5,0 -97.8,34.9,0
                  </coordinates>
                </LinearRing>
              </outerBoundaryIs>
            </Polygon>
          </MultiGeometry>
        </Placemark>
      </Folder>
    </Folder>
  </Document>
</kml>`;

test('WPC winter KML parser emits day-level snow outlook polygons with severity', () => {
  const outlooks = parseWpcWinterWeatherKml(SAMPLE_SNOW_KML, {
    hazardType: 'snow',
    threshold: '8in',
    sourceUrl: 'https://www.wpc.ncep.noaa.gov/kml/winwx/HPC_Day1-3_psnow_gt_08_latest.kml',
  });

  assert.equal(outlooks.length, 1);
  assert.equal(outlooks[0]?.day, 1);
  assert.equal(outlooks[0]?.hazardType, 'snow');
  assert.equal(outlooks[0]?.threshold, '8in');
  assert.equal(outlooks[0]?.probabilityPercent, 70);
  assert.equal(outlooks[0]?.severity, 'critical');
  assert.match(outlooks[0]?.headline ?? '', /snow/i);
});
