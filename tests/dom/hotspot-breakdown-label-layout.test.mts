/**
 * happy-dom has no layout.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Reads the first exact selector block because happy-dom cannot measure layout. */
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
    const row = declarations('.breakdown-components');
    expect(row['--breakdown-gap']).toBe('8px');
    expect(row['--breakdown-bar-min']).toBe('48px');
    expect(row['--breakdown-value-width']).toBe('20px');
    expect(declarations('.breakdown-row').gap).toBe('var(--breakdown-gap)');
    expect(label.width).toBe('max-content');
    expect(label['min-width']).toBe('45px');
    expect(label['max-width']).toBe(
      'calc(100% - (var(--breakdown-bar-min) + var(--breakdown-value-width) + 2 * var(--breakdown-gap)))',
    );
    expect(label['overflow-wrap']).toBe('break-word');
    expect(label.flex).toBe('0 0 auto');
    expect(declarations('.component-bar-bg')['min-width']).toBe('var(--breakdown-bar-min)');
    expect(declarations('.component-value').width).toBe('var(--breakdown-value-width)');
  });
});
