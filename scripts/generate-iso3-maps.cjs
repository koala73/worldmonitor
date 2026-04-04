'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const geojson = JSON.parse(fs.readFileSync(path.join(root, 'public', 'data', 'countries.geojson'), 'utf8'));

const iso3ToIso2 = {};
const discrepancies = [];

for (const f of geojson.features) {
  const props = f.properties || {};
  const iso2 = String(props['ISO3166-1-Alpha-2'] || '').trim();
  const iso3 = String(props['ISO3166-1-Alpha-3'] || '').trim();

  if (!/^[A-Z]{2}$/.test(iso2)) {
    if (/^[A-Z]{3}$/.test(iso3)) {
      discrepancies.push(`Skipped ${iso3} (${props.name}): invalid ISO2 "${props['ISO3166-1-Alpha-2']}"`);
    }
    continue;
  }
  if (!/^[A-Z]{3}$/.test(iso3)) {
    discrepancies.push(`Skipped ${props.name} (${iso2}): invalid ISO3 "${props['ISO3166-1-Alpha-3']}"`);
    continue;
  }
  iso3ToIso2[iso3] = iso2;
}

// Supplements for missing/invalid entries
if (!iso3ToIso2['TWN']) {
  iso3ToIso2['TWN'] = 'TW';
  console.log('Added supplement: TWN → TW (Taiwan has CN-TW in geojson)');
}
if (!iso3ToIso2['XKX']) {
  iso3ToIso2['XKX'] = 'XK';
  console.log('Added supplement: XKX → XK (Kosovo absent from geojson)');
}

// Sort by key
const sorted3to2 = Object.fromEntries(
  Object.entries(iso3ToIso2).sort(([a], [b]) => a.localeCompare(b))
);

// Invert: ISO2 → ISO3
const iso2ToIso3 = {};
for (const [iso3, iso2] of Object.entries(sorted3to2)) {
  if (!iso2ToIso3[iso2]) {
    iso2ToIso3[iso2] = iso3;
  }
}
const sorted2to3 = Object.fromEntries(
  Object.entries(iso2ToIso3).sort(([a], [b]) => a.localeCompare(b))
);

// Write files
const out3to2 = path.join(root, 'shared', 'iso3-to-iso2.json');
fs.writeFileSync(out3to2, JSON.stringify(sorted3to2, null, 2) + '\n');
console.log(`Wrote ${Object.keys(sorted3to2).length} entries to ${out3to2}`);

const out2to3 = path.join(root, 'shared', 'iso2-to-iso3.json');
fs.writeFileSync(out2to3, JSON.stringify(sorted2to3, null, 2) + '\n');
console.log(`Wrote ${Object.keys(sorted2to3).length} entries to ${out2to3}`);

if (discrepancies.length) {
  console.log(`\nDiscrepancies (${discrepancies.length}):`);
  for (const d of discrepancies) console.log(`  ${d}`);
}
