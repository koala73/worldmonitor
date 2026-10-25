import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  center,
  charWidth,
  detectColorDepth,
  mix,
  parseHex,
  sgrColor,
  strWidth,
  toAnsi256,
  truncate,
  wrap,
} from '../src/tui/term/ansi.mjs';
import { InputDecoder } from '../src/tui/term/input.mjs';
import { ATTR, Screen } from '../src/tui/term/screen.mjs';

describe('ansi colours', () => {
  it('parses hex and mixes', () => {
    assert.deepEqual(parseHex('#00ffaa'), [0, 255, 170]);
    assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
    assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
    assert.equal(mix('#000000', '#ffffff', 2), '#ffffff');
  });
  it('emits truecolor or 256-colour SGR by depth', () => {
    assert.equal(sgrColor('#ff0000', false, 24), '38;2;255;0;0');
    assert.equal(sgrColor('#ff0000', true, 256), '48;5;196');
    assert.equal(toAnsi256('#000000'), 16);
    assert.equal(toAnsi256('#ffffff'), 231);
    assert.equal(toAnsi256('#808080'), 244);
  });
  it('detects colour depth from the environment', () => {
    assert.equal(detectColorDepth({ COLORTERM: 'truecolor' }), 24);
    assert.equal(detectColorDepth({ TERM: 'xterm-256color' }), 256);
    assert.equal(detectColorDepth({ TERM_PROGRAM: 'ghostty' }), 24);
    assert.equal(detectColorDepth({ WM_TUI_COLOR: '256', COLORTERM: 'truecolor' }), 256);
  });
});

describe('ansi text', () => {
  it('measures wide characters', () => {
    assert.equal(strWidth('abc'), 3);
    assert.equal(strWidth('日本'), 4);
    assert.equal(strWidth('á'), 1);
  });
  it('truncates with an ellipsis and centres', () => {
    assert.equal(truncate('hello world', 8), 'hello w…');
    assert.equal(truncate('hi', 8), 'hi');
    assert.equal(truncate('日本語テキスト', 5), '日本…');
    assert.equal(center('ab', 6), '  ab  ');
  });
  it('wraps words and breaks over-long tokens', () => {
    assert.deepEqual(wrap('the quick brown fox', 9), ['the quick', 'brown fox']);
    assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
    assert.deepEqual(wrap('a\nb', 10), ['a', 'b']);
  });
});

describe('Screen', () => {
  it('draws text, clips, and renders a full frame', () => {
    const s = new Screen(10, 2);
    s.text(0, 0, 'hello', { fg: '#ff0000' });
    s.pushClip({ x: 0, y: 1, w: 3, h: 1 });
    s.text(0, 1, 'clipped');
    s.popClip();
    assert.deepEqual(s.toLines(), ['hello', 'cli']);
    const out = s.diff(null);
    assert.ok(out.includes('\x1b[2J'));
    assert.ok(out.includes('38;2;255;0;0'));
    assert.ok(out.includes('hello'));
  });
  it('emits only changed cells on the next frame', () => {
    const a = new Screen(6, 1);
    a.text(0, 0, 'abcdef');
    const b = a.clone();
    b.put(3, 0, 'X', { attr: ATTR.BOLD });
    const out = b.diff(a);
    assert.equal(out, '\x1b[1;4H\x1b[0;1mX\x1b[0m');
    assert.equal(b.diff(b.clone()), '');
  });
  it('handles wide characters as two cells', () => {
    const s = new Screen(5, 1);
    s.text(0, 0, '日本');
    assert.deepEqual(s.toLines(), ['日本']);
    s.put(1, 0, 'x');
    assert.equal(s.toLines()[0], ' x本');
  });
  it('measures emoji-presentation symbols as two columns, like terminals do', () => {
    for (const ch of ['⚓', '⚡', '⛽', '🟠', '🚀', '⭐', '✅']) assert.equal(charWidth(ch), 2, ch);
    for (const ch of ['☀', '✈', '⚠', '★', '☢', '✓', '✕', '≡', '◆']) assert.equal(charWidth(ch), 1, ch);
  });
  it('reserves the next cell when put() draws a wide character', () => {
    const s = new Screen(5, 1);
    s.put(0, 0, '🟠');
    s.put(2, 0, 'x');
    assert.equal(s.toLines()[0], '🟠x');
    assert.ok(s.diff(null).includes('🟠x'), 'the terminal sees x right after the emoji');
    s.put(4, 0, '⚓'); // no room for its right half
    assert.equal(s.toLines()[0], '🟠x');
  });
  it('clears the old wide tail when a clip blanks a wide character', () => {
    const s = new Screen(4, 1);
    s.put(0, 0, '日');
    s.pushClip({ x: 0, y: 0, w: 1, h: 1 });
    s.put(0, 0, '月'); // its right half falls outside the clip
    s.popClip();
    s.put(2, 0, 'x');
    assert.equal(s.toLines()[0], '  x');
    assert.ok(s.diff(null).includes('  x'), 'the terminal sees x in the third column');
  });
  it('keeps a wide character drawn twice in the same cells', () => {
    const s = new Screen(4, 1);
    s.text(0, 0, '日');
    s.text(0, 0, '日');
    assert.equal(s.toLines()[0], '日');
  });
  it('draws boxes', () => {
    const s = new Screen(4, 3);
    s.box({ x: 0, y: 0, w: 4, h: 3 });
    assert.deepEqual(s.toLines(), ['┌──┐', '│  │', '└──┘']);
  });
});

describe('InputDecoder', () => {
  it('decodes plain keys and control keys', () => {
    const d = new InputDecoder();
    const ev = d.push('a\r\t\x03\x7f ');
    assert.deepEqual(
      ev.map((e) => [e.name, e.ctrl]),
      [['a', false], ['enter', false], ['tab', false], ['c', true], ['backspace', false], ['space', false]],
    );
  });
  it('decodes cursor, function and modified keys', () => {
    const d = new InputDecoder();
    const ev = d.push('\x1b[A\x1bOB\x1b[5~\x1b[Z\x1b[1;5C\x1b[H');
    assert.deepEqual(
      ev.map((e) => [e.name, e.shift, e.ctrl]),
      [['up', false, false], ['down', false, false], ['pageup', false, false], ['tab', true, false], ['right', false, true], ['home', false, false]],
    );
  });
  it('decodes SGR mouse press, release, drag and wheel', () => {
    const d = new InputDecoder();
    const ev = d.push('\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<32;11;5M\x1b[<64;1;1M\x1b[<65;1;1M');
    assert.deepEqual(
      ev.map((e) => [e.kind, e.x, e.y, e.button]),
      [['down', 9, 4, 0], ['up', 9, 4, 0], ['drag', 10, 4, 0], ['wheelup', 0, 0, -1], ['wheeldown', 0, 0, -1]],
    );
  });
  it('keeps incomplete sequences and resolves a lone escape on flush', () => {
    const d = new InputDecoder();
    assert.deepEqual(d.push('\x1b['), []);
    assert.deepEqual(d.push('B').map((e) => e.name), ['down']);
    assert.deepEqual(d.push('\x1b'), []);
    assert.deepEqual(d.flush().map((e) => e.name), ['escape']);
  });
  it('decodes alt+key and utf-8', () => {
    const d = new InputDecoder();
    const ev = d.push('\x1bxé😀');
    assert.deepEqual(ev.map((e) => [e.name, e.alt]), [['x', true], ['é', false], ['😀', false]]);
  });
});
