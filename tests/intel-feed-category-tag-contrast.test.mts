import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const newsPanelSource = readFileSync(resolve(root, 'src/components/NewsPanel.ts'), 'utf8');
const mainCss = readFileSync(resolve(root, 'src/styles/main.css'), 'utf8');
const happyCss = readFileSync(resolve(root, 'src/styles/happy-theme.css'), 'utf8');

function cssBlock(source: string, selector: string): string {
  const start = source.indexOf(selector);
  assert.notEqual(start, -1, `missing ${selector} selector`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unterminated ${selector} block`);
}

function cssVars(...blocks: string[]): Record<string, string> {
  return Object.assign({}, ...blocks.map(block => Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)].map(([, name, value]) => [name!, value!]),
  )));
}

function rgb(hex: string): [number, number, number] {
  const expanded = hex.length === 4 ? `#${[...hex.slice(1)].map(char => char + char).join('')}` : hex;
  return [1, 3, 5].map(offset => Number.parseInt(expanded.slice(offset, offset + 2), 16)) as [number, number, number];
}

function composite(foreground: string, background: string, alpha: number): [number, number, number] {
  const fg = rgb(foreground);
  const bg = rgb(background);
  return fg.map((channel, index) => channel * alpha + bg[index]! * (1 - alpha)) as [number, number, number];
}

function luminance(color: string | [number, number, number]): number {
  const channels = (typeof color === 'string' ? rgb(color) : color).map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(a: string | [number, number, number], b: string | [number, number, number]): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function requiredHexColor(vars: Record<string, string>, name: string, theme: string): string {
  const value = vars[name];
  assert.ok(value, `${theme} must define ${name} as a hex color for contrast verification`);
  return value;
}

describe('Intel Feed category-tag contrast (#5166)', () => {
  it('uses primary text for the generated label while retaining the threat color as the tag treatment', () => {
    assert.match(
      newsPanelSource,
      /style="--category-color:\$\{catColor\};--category-background:\$\{catColor\}20"/,
      'the generated tag keeps its threat-specific border and tint',
    );
    assert.doesNotMatch(newsPanelSource, /style="color:\$\{catColor\}/, 'the tint must not become the small label foreground');
    const categoryTagCss = cssBlock(mainCss, '.category-tag');
    assert.match(categoryTagCss, /color:\s*var\(--text\)/, 'small tag labels use the theme primary text color');
    assert.match(categoryTagCss, /border-color:\s*var\(--category-color\)/, 'the border carries the category color');
    assert.match(categoryTagCss, /background:\s*var\(--category-background\)/, 'the tint carries the category color');
  });

  it('keeps every category threat color AA-safe on each panel surface', () => {
    const rootBlocks = [...mainCss.matchAll(/:root\s*\{/g)].map(match => cssBlock(mainCss.slice(match.index), ':root'));
    const base = cssVars(rootBlocks[0]!, rootBlocks[1]!);
    const light = { ...base, ...cssVars(cssBlock(mainCss, '[data-theme="light"]')) };
    const happyLight = cssVars(cssBlock(happyCss, ':root[data-variant="happy"]'));
    const happyDark = cssVars(cssBlock(happyCss, ':root[data-variant="happy"][data-theme="dark"]'));
    const themes = [
      ['dark', base],
      ['light', light],
      ['happy light', happyLight],
      ['happy dark', happyDark],
    ] as const;
    const threatVars = ['--threat-critical', '--threat-high', '--threat-medium', '--threat-low', '--threat-info'];

    for (const [name, vars] of themes) {
      for (const threatVar of threatVars) {
        const ratio = contrastRatio(
          requiredHexColor(vars, '--text', name),
          composite(
            requiredHexColor(vars, threatVar, name),
            requiredHexColor(vars, '--surface', name),
            0x20 / 0xff,
          ),
        );
        assert.ok(ratio >= 4.5, `${name} ${threatVar} category tag is ${ratio.toFixed(2)}:1 (needs 4.5:1)`);
      }
    }
  });
});
