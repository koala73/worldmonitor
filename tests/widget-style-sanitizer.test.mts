import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { sanitizeWidgetStyle } from '../src/utils/widget-style.ts';

describe('sanitizeWidgetStyle', () => {
  it('handles repeated long identifiers within a bounded deadline', () => {
    const moduleUrl = new URL('../src/utils/widget-style.ts', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { sanitizeWidgetStyle } from ${JSON.stringify(moduleUrl)};
      const value = 'a'.repeat(49_000);
      for (let index = 0; index < 10; index += 1) {
        assert.equal(sanitizeWidgetStyle('color:' + value), 'color: ' + value);
      }
    `], { encoding: 'utf8', timeout: 5_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });

  it('checks function names after ordinary identifiers and inside other functions', () => {
    assert.equal(sanitizeWidgetStyle('border: 1px solid unknown(0)'), '');
    assert.equal(sanitizeWidgetStyle('color: var(--text, unknown(0))'), '');
    assert.equal(sanitizeWidgetStyle('width: calc(100% - unknown(8px))'), '');
    assert.equal(
      sanitizeWidgetStyle('width: clamp(100px, calc(100% - 8px), 300px)'),
      'width: clamp(100px, calc(100% - 8px), 300px)',
    );
  });

  it('drops image-set, escaped url, image(), quotes, and @', () => {
    assert.equal(
      sanitizeWidgetStyle("background:image-set('https://x.example/b' 1x)"),
      '',
    );
    assert.equal(
      sanitizeWidgetStyle("background-image:image-set('https://x.example/b' 1x)"),
      '',
    );
    assert.equal(sanitizeWidgetStyle('background:\\75rl(https://x.example/a)'), '');
    assert.equal(sanitizeWidgetStyle('background:image(https://x.example/c)'), '');
    assert.equal(sanitizeWidgetStyle('color: "red"'), '');
    assert.equal(sanitizeWidgetStyle('background: @import url(https://x.example/d)'), '');
  });

  it('drops literal url, expression, javascript, comments, and behavior', () => {
    assert.equal(sanitizeWidgetStyle('background: url(https://evil.example)'), '');
    assert.equal(sanitizeWidgetStyle('color: expression(alert(1))'), '');
    assert.equal(sanitizeWidgetStyle('background: javascript:alert(1)'), '');
    assert.equal(sanitizeWidgetStyle('background: image/**/-set(https://x.example/e 1x)'), '');
    assert.equal(sanitizeWidgetStyle('behavior: url(https://evil.example)'), '');
  });

  it('keeps a safe declaration that shares an attribute with a hostile one', () => {
    assert.equal(
      sanitizeWidgetStyle('color: var(--text); background: url(https://evil.example)'),
      'color: var(--text)',
    );
  });

  it('keeps benign color, padding, and flex styles', () => {
    assert.equal(sanitizeWidgetStyle('color: red'), 'color: red');
    assert.equal(sanitizeWidgetStyle('padding: 8px'), 'padding: 8px');
    assert.equal(sanitizeWidgetStyle('display:flex'), 'display: flex');
    assert.equal(
      sanitizeWidgetStyle('padding: 8px; display: flex'),
      'padding: 8px; display: flex',
    );
  });

  it('keeps the design-system declarations widgets emit', () => {
    assert.equal(
      sanitizeWidgetStyle('display:flex;justify-content:space-between;align-items:center;padding:5px 8px;border-bottom:1px solid var(--border-subtle)'),
      'display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; border-bottom: 1px solid var(--border-subtle)',
    );
    assert.equal(
      sanitizeWidgetStyle('font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);padding:6px 8px 3px'),
      'font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); padding: 6px 8px 3px',
    );
    assert.equal(
      sanitizeWidgetStyle('border: 1px solid rgba(255,255,255,0.08); border-radius: 10px'),
      'border: 1px solid rgba(255,255,255,0.08); border-radius: 10px',
    );
    assert.equal(
      sanitizeWidgetStyle('display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px'),
      'display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px',
    );
    assert.equal(
      sanitizeWidgetStyle('position:fixed;top:0;left:0;width:200vw;height:44px;background:#ff4444;color:#fff;z-index:9999'),
      'position: fixed; top: 0; left: 0; width: 200vw; height: 44px; background: #ff4444; color: #fff; z-index: 9999',
    );
  });

  it('drops properties that can define a variable or name a font', () => {
    assert.equal(
      sanitizeWidgetStyle('--bg: url(https://evil.example); background: var(--surface)'),
      'background: var(--surface)',
    );
    assert.equal(sanitizeWidgetStyle('font-family: monospace; color: var(--text)'), 'color: var(--text)');
  });

  it('keeps !important on an allowed declaration', () => {
    assert.equal(sanitizeWidgetStyle('color: var(--text) !important'), 'color: var(--text) !important');
  });
});
