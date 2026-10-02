import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

for (const path of ['../shared/country-name-to-iso2.cjs', '../scripts/shared/country-name-to-iso2.cjs']) {
  const { countryNameToIso2 } = require(path);
  test(`${path} rejects Object prototype names`, () => {
    for (const name of ['constructor', '__proto__', 'constructor (former name)', '__proto__ (former name)', 'toString']) {
      assert.equal(countryNameToIso2(name), null, name);
    }
  });
  test(`${path} retains country names, codes, and historical aliases`, () => {
    for (const [name, code] of [['United States', 'US'], ['UK', 'GB'], ['Bosnia-Herzegovina', 'BA'], ['Russia (Soviet Union)', 'RU'], ['Yemen (North Yemen)', 'YE'], ['DR Congo (Zaire)', 'CD'], ['fr', 'FR']]) {
      assert.equal(countryNameToIso2(name), code, name);
    }
  });
}
