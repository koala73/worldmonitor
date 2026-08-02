import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rssSource = readFileSync(resolve(__dirname, '../src/services/rss.ts'), 'utf8');

describe('RSS mobile yielding', () => {
  it('keeps desktop feed XML parsing concurrent while queuing mobile parses', () => {
    assert.match(
      rssSource,
      /function parseFeedXml\(text: string, isMobile: boolean\): Promise<Document> \{\s*\/\/ Desktop keeps its established concurrent feed path[\s\S]*?if \(!isMobile\) return Promise\.resolve\(new DOMParser\(\)\.parseFromString\(text, 'text\/xml'\)\);\s*return enqueueFeedParse/s,
    );
    assert.match(rssSource, /const isMobile = isMobileDevice\(\);\s*const doc = await parseFeedXml\(text, isMobile\);/s);
    assert.match(rssSource, /if \(isMobile\) await yieldToMain\(\);/);
    assert.match(rssSource, /if \(isMobile && index < itemNodes\.length - 1\) await yieldToMain\(\);/);
  });
});
