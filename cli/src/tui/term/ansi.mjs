// Terminal escape sequences and colour math. Pure functions, no process access
// except through the `env` argument of detectColorDepth.

export const ESC = '\x1b';
export const CSI = `${ESC}[`;

export const SEQ = {
  altScreenOn: `${CSI}?1049h`,
  altScreenOff: `${CSI}?1049l`,
  cursorHide: `${CSI}?25l`,
  cursorShow: `${CSI}?25h`,
  // Button events + motion while pressed + SGR extended coordinates.
  mouseOn: `${CSI}?1000h${CSI}?1002h${CSI}?1006h`,
  mouseOff: `${CSI}?1006l${CSI}?1002l${CSI}?1000l`,
  clear: `${CSI}2J${CSI}H`,
  reset: `${CSI}0m`,
  bracketedPasteOn: `${CSI}?2004h`,
  bracketedPasteOff: `${CSI}?2004l`,
};

export function moveTo(x, y) {
  return `${CSI}${y + 1};${x + 1}H`;
}

export function setTitle(title) {
  return `${ESC}]0;${title}\x07`;
}

// --- colours ---------------------------------------------------------------

export function parseHex(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

export function mix(a, b, t) {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const k = Math.max(0, Math.min(1, t));
  return toHex([ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k]);
}

// Nearest xterm-256 index for a 24-bit colour (cube + grey ramp).
export function toAnsi256(hex) {
  const [r, g, b] = parseHex(hex);
  const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  const cube = 16 + 36 * q(r) + 6 * q(g) + q(b);
  const cv = (i) => (i === 0 ? 0 : 55 + i * 40);
  const [cr, cg, cb] = [cv(q(r)), cv(q(g)), cv(q(b))];
  const grey = Math.round((r + g + b) / 3);
  const gi = Math.max(0, Math.min(23, Math.round((grey - 8) / 10)));
  const gv = 8 + gi * 10;
  const dCube = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
  const dGrey = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;
  return dGrey < dCube ? 232 + gi : cube;
}

export function detectColorDepth(env = {}) {
  if (env.WM_TUI_COLOR === '256') return 256;
  if (env.WM_TUI_COLOR === 'truecolor' || env.WM_TUI_COLOR === '24bit') return 24;
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 24;
  const tp = String(env.TERM_PROGRAM || '').toLowerCase();
  if (['iterm.app', 'ghostty', 'wezterm', 'vscode', 'hyper', 'tabby', 'rio'].includes(tp)) return 24;
  const term = String(env.TERM || '').toLowerCase();
  if (term.includes('kitty') || term.includes('ghostty') || term.includes('direct') || term.includes('truecolor')) return 24;
  if (term.includes('256')) return 256;
  return 256;
}

export function sgrColor(hex, isBg, depth) {
  if (!hex) return '';
  const lead = isBg ? 48 : 38;
  if (depth === 24) {
    const [r, g, b] = parseHex(hex);
    return `${lead};2;${r};${g};${b}`;
  }
  return `${lead};5;${toAnsi256(hex)}`;
}

// --- text width --------------------------------------------------------------

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function isZeroWidth(cp) {
  return (
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0xfeff ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x20d0 && cp <= 0x20ff)
  );
}

export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isZeroWidth(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

export function strWidth(str) {
  let w = 0;
  for (const ch of str) w += charWidth(ch);
  return w;
}

// Cut `str` to at most `width` columns, appending an ellipsis when cut.
export function truncate(str, width, ellipsis = '…') {
  if (width <= 0) return '';
  if (strWidth(str) <= width) return str;
  const ew = strWidth(ellipsis);
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = charWidth(ch);
    if (w + cw > width - ew) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

export function padEnd(str, width, fill = ' ') {
  const w = strWidth(str);
  return w >= width ? str : str + fill.repeat(width - w);
}

export function padStart(str, width, fill = ' ') {
  const w = strWidth(str);
  return w >= width ? str : fill.repeat(width - w) + str;
}

export function center(str, width) {
  const w = strWidth(str);
  if (w >= width) return str;
  const left = Math.floor((width - w) / 2);
  return ' '.repeat(left) + str + ' '.repeat(width - w - left);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', deg: '°', euro: '€', pound: '£' };

export function decodeEntities(str) {
  return String(str ?? '').replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = ENTITIES[code.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// Strip control characters that would corrupt the cell grid (keeps tabs as spaces).
export function sanitize(str) {
  return decodeEntities(str)
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

// Word-wrap into lines of at most `width` columns.
export function wrap(text, width) {
  const lines = [];
  for (const para of String(text ?? '').split(/\r?\n/)) {
    const words = sanitize(para).split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      if (strWidth(word) > width) {
        if (line) lines.push(line);
        line = '';
        let chunk = '';
        for (const ch of word) {
          if (strWidth(chunk + ch) > width) {
            lines.push(chunk);
            chunk = '';
          }
          chunk += ch;
        }
        line = chunk;
        continue;
      }
      const next = line ? `${line} ${word}` : word;
      if (strWidth(next) > width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}
