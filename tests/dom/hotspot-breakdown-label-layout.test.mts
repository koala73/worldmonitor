/**
 * #10179 — hotspot breakdown labels must not paint over the bars.
 *
 * happy-dom has no layout, so this locks the sizing contract a browser
 * measurement proved: short labels keep a 45px floor, longer locale strings
 * grow up to the space left for the bar, the value, and the row gaps, then wrap.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function declarations(selector: string): Record<string, string> {
  const css = readFileSync('src/styles/main.css', 'utf8');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = css.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  expect(body, selector).toBeTruthy();
  const decls: Record<string, string> = {};
  for (const part of body!.split(';')) {
    const index = part.indexOf(':');
    if (index < 0) continue;
    decls[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return decls;
}

describe('hotspot escalation breakdown labels', () => {
  it('lets the label column grow with the text and wrap before it meets the bar', () => {
    const label = declarations('.component-label');
    expect(label.width).toBe('max-content');
    expect(label['min-width']).toBe('45px');
    expect(label['max-width']).toBe('calc(100% - 84px)');
    expect(label['overflow-wrap']).toBe('break-word');
    expect(label.flex).toBe('0 0 auto');
    expect(declarations('.component-bar-bg')['min-width']).toBe('48px');
  });
});
