import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyFont } from '../src/services/font-settings.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainCss = readFileSync(resolve(__dirname, '../src/styles/main.css'), 'utf-8');

function withMockDocument(
  run: (calls: { set: string[]; remove: string[]; dataset: Record<string, string | undefined> }) => void,
): void {
  const dataset: Record<string, string | undefined> = {};
  const calls = { set: [] as string[], remove: [] as string[], dataset };
  const originalDocument = globalThis.document;

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: {
        dataset,
        style: {
          setProperty: (name: string) => {
            calls.set.push(name);
          },
          removeProperty: (name: string) => {
            calls.remove.push(name);
          },
        },
      },
    },
  });

  try {
    run(calls);
  } finally {
    if (originalDocument === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).document;
    } else {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  }
}

describe('font settings RTL-safe contract', () => {
  it('applies the system preference through the data-font attribute only', () => {
    withMockDocument((calls) => {
      applyFont('system');
      assert.equal(calls.dataset.font, 'system');
      assert.deepEqual(calls.set, []);
      assert.deepEqual(calls.remove, []);
    });
  });

  it('removes the data-font attribute when switching back to mono', () => {
    withMockDocument((calls) => {
      calls.dataset.font = 'system';
      applyFont('mono');
      assert.equal(calls.dataset.font, undefined);
      assert.deepEqual(calls.set, []);
      assert.deepEqual(calls.remove, []);
    });
  });

  it('lets system preference, RTL, and CJK rules compose through --font-body-base', () => {
    assert.match(
      mainCss,
      /\[data-font="system"\]\s*\{\s*--font-body-base:\s*system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;/s,
    );
    assert.match(
      mainCss,
      /\[dir="rtl"\]\s*\{\s*--font-body:\s*'Tajawal', 'Geeza Pro', 'SF Arabic', 'Tahoma', var\(--font-body-base\);/s,
    );
    assert.match(
      mainCss,
      /:lang\(zh-CN\),\s*:lang\(zh\)\s*\{\s*--font-body:\s*'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', var\(--font-body-base\);/s,
    );
  });
});
