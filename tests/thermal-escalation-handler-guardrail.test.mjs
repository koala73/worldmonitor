// Source guard by design (#8690, section 2): this suite pins the handler's
// seeded Redis read and prohibits direct fetch and NASA FIRMS references.
// Runtime fixtures exercise selected paths, while this source check also
// catches those references in paths the fixtures do not reach.
//
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

describe('thermal escalation handler guardrails', () => {
  it('reads seeded Redis data instead of calling FIRMS directly', () => {
    const src = readFileSync(join(root, 'server/worldmonitor/thermal/v1/list-thermal-escalations.ts'), 'utf8');
    assert.match(src, /getCachedJson\(REDIS_CACHE_KEY, true\)/);
    assert.doesNotMatch(src, /firms\.modaps\.eosdis\.nasa\.gov/i);
    assert.doesNotMatch(src, /\bcachedFetchJson\b/);
    assert.doesNotMatch(src, /\bfetch\(/);
  });
});
