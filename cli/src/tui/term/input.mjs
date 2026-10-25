// Decodes raw terminal input into key and mouse events. Handles SGR mouse
// (CSI < b ; x ; y M/m), CSI/SS3 cursor keys, function keys, modifiers, and
// UTF-8 text. Incomplete sequences are kept until more bytes arrive.

const CSI_KEYS = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'shift+tab',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
};

const TILDE_KEYS = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
};

function key(name, extra = {}) {
  return { type: 'key', name, ctrl: false, alt: false, shift: false, ...extra };
}

function withModifier(ev, mod) {
  // xterm modifier param: 1 + (shift=1, alt=2, ctrl=4)
  const m = (mod | 0) - 1;
  if (m > 0) {
    ev.shift = Boolean(m & 1);
    ev.alt = Boolean(m & 2);
    ev.ctrl = Boolean(m & 4);
  }
  return ev;
}

function mouseEvent(params, final) {
  const [b = 0, x = 1, y = 1] = params;
  const button = b & 3;
  const shift = Boolean(b & 4);
  const alt = Boolean(b & 8);
  const ctrl = Boolean(b & 16);
  const motion = Boolean(b & 32);
  const wheel = Boolean(b & 64);
  let kind;
  let btn = button;
  if (wheel) {
    kind = button === 0 ? 'wheelup' : button === 1 ? 'wheeldown' : button === 2 ? 'wheelleft' : 'wheelright';
    btn = -1;
  } else if (motion) {
    kind = button === 3 ? 'move' : 'drag';
  } else if (final === 'm' || button === 3) {
    kind = 'up';
  } else {
    kind = 'down';
  }
  return { type: 'mouse', kind, button: btn, x: x - 1, y: y - 1, shift, alt, ctrl };
}

export class InputDecoder {
  constructor() {
    this.pending = '';
  }

  // Returns decoded events; keeps an incomplete trailing sequence for later.
  push(chunk) {
    const text = this.pending + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    this.pending = '';
    const events = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c !== '\x1b') {
        i += this.decodePlain(text, i, events);
        continue;
      }
      const res = this.decodeEscape(text, i);
      if (res.incomplete) {
        this.pending = text.slice(i);
        break;
      }
      if (res.event) events.push(res.event);
      i += res.length;
    }
    return events;
  }

  // Call when no more bytes arrived shortly after a lone ESC.
  flush() {
    const text = this.pending;
    this.pending = '';
    if (!text) return [];
    if (text === '\x1b') return [key('escape')];
    // Alt + character, or a sequence we do not know: decode ESC then the rest.
    const events = [key('escape')];
    const dec = new InputDecoder();
    events.push(...dec.push(text.slice(1)));
    return events;
  }

  decodePlain(text, i, events) {
    const cp = text.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + len);
    if (ch === '\r' || ch === '\n') events.push(key('enter'));
    else if (ch === '\t') events.push(key('tab'));
    else if (ch === '\x7f' || ch === '\b') events.push(key('backspace'));
    else if (ch === ' ') events.push(key('space', { ch: ' ' }));
    else if (cp < 0x20) events.push(key(String.fromCharCode(cp + 96), { ctrl: true }));
    else events.push(key(ch, { ch, shift: ch !== ch.toLowerCase() && ch === ch.toUpperCase() }));
    return len;
  }

  decodeEscape(text, i) {
    if (i + 1 >= text.length) return { incomplete: true };
    const next = text[i + 1];
    if (next === '[') {
      // CSI: parameters then a final byte in 0x40..0x7e
      let j = i + 2;
      const mouse = text[j] === '<';
      if (mouse) j++;
      let params = '';
      while (j < text.length && /[0-9;]/.test(text[j])) params += text[j++];
      if (j >= text.length) return { incomplete: true };
      const final = text[j];
      const length = j - i + 1;
      const nums = params === '' ? [] : params.split(';').map((n) => (n === '' ? 0 : Number(n)));
      if (mouse && (final === 'M' || final === 'm')) return { event: mouseEvent(nums, final), length };
      if (final === '~') {
        const name = TILDE_KEYS[nums[0]];
        if (!name) return { event: null, length };
        return { event: withModifier(key(name), nums[1]), length };
      }
      if (CSI_KEYS[final]) {
        const name = CSI_KEYS[final];
        if (name === 'shift+tab') return { event: key('tab', { shift: true }), length };
        return { event: withModifier(key(name), nums[1]), length };
      }
      if (final === 'I' || final === 'O') return { event: key(final === 'I' ? 'focus' : 'blur'), length };
      return { event: null, length };
    }
    if (next === 'O') {
      if (i + 2 >= text.length) return { incomplete: true };
      const final = text[i + 2];
      const name = CSI_KEYS[final];
      return { event: name ? key(name) : null, length: 3 };
    }
    // ESC + printable: Alt+key. A lone ESC is resolved by flush() after a timeout
    // unless more input follows in the same chunk.
    if (next === '\x1b') return { event: key('escape'), length: 1 };
    const cp = text.codePointAt(i + 1);
    if (cp >= 0x20 && cp !== 0x7f) {
      const ch = String.fromCodePoint(cp);
      return { event: key(ch, { ch, alt: true }), length: 1 + ch.length };
    }
    return { event: key('escape'), length: 1 };
  }
}
