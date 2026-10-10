// US HTS Chapter 99, subchapter III: additional duties that are in force,
// indexed by the HTS provisions they cover.
//
// Inputs are the two USITC HTS REST responses the seeder fetches:
//   - getChapterNotes?doc=99 — the chapter 99 U.S. notes as HTML. Product
//     coverage of every Section 301 / 232 action lives in these notes, not in
//     the product lines' own footnotes.
//   - exportList over 9903.01.00–9903.99.99 — the heading rows, which carry the
//     rate ("The duty provided in the applicable subheading + 25%") and, for the
//     country-wide actions, the country.
//
// Measures are curated: each one names the heading it reads its rate from and
// the note subdivision that lists its products, located by an anchor phrase.
// A subdivision is the list item from its marker to the marker of the next
// sibling ("(b)" runs to "(c)"), because the published HTML does not close its
// list items reliably. Every measure is validated (heading present, rate
// parsed, list found and non-trivial); any failure throws, so the seeder keeps
// the previous index instead of publishing a partial one.
//
// Deliberately excluded: the IEEPA headings (9903.01.xx, 9903.02.xx), which
// the HTS still prints but CBP stopped collecting on 2026-02-24 after
// Learning Resources v. Trump, and the Section 122 surcharge (9903.03.xx),
// which expired on 2026-07-23.

export const US_HTS_INDEX_SCHEMA = 1;

// Duty roles stored per HTS provision in a coverage shard.
export const ROLE_APPLY = 'a';
export const ROLE_EXEMPT = 'x';

// 4-, 6- and 8-digit provisions, and 10-digit statistical numbers written
// either "8708.29.50.60" or "8708.29.5060".
const CODE_RE = /(?<![\d.])(\d{4}(?:\.\d{2}(?:\.(?:\d{4}|\d{2}(?:\.\d{2})?))?)?)(?![\d.])/g;

/** HTML to plain text: tags to spaces, a few entities, whitespace collapsed. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "8708.29.5060" -> "8708.29.50.60"; other shapes unchanged. */
export function normalizeCode(code) {
  const m = /^(\d{4}\.\d{2})\.(\d{2})(\d{2})$/.exec(code);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : code;
}

/** HTS provisions in a text run, chapter 99 excluded (those are headings, not products). */
export function extractCodes(text) {
  const out = [];
  return classifyCodes(text).fullCodes.concat(classifyCodes(text).partialCodes);
}

/** The marker that follows `value` in its sequence: (b)->(c), (z)->(aa), (ii)->(iii), (3)->(4). */
export function nextMarker(value) {
  const inner = String(value || '').replace(/^\(|\)$/g, '');
  if (/^\d+$/.test(inner)) return `(${Number(inner) + 1})`;
  const roman = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx'];
  // "(i)" and "(v)" are both letters and numerals; the caller's depth bound
  // keeps the wrong reading from overrunning.
  const r = roman.indexOf(inner);
  if (r > 0 && r + 1 < roman.length && inner !== 'v' && inner !== 'x') return `(${roman[r + 1]})`;
  if (/^([a-z])\1*$/.test(inner)) {
    const c = inner[0];
    const n = inner.length;
    return c === 'z' ? `(${'a'.repeat(n + 1)})` : `(${String.fromCharCode(c.charCodeAt(0) + 1).repeat(n)})`;
  }
  if (/^[A-Z]$/.test(inner)) return `(${String.fromCharCode(inner.charCodeAt(0) + 1)})`;
  return null;
}

/**
 * Index every list-item marker with its list nesting depth:
 * [{ pos, value, depth }] in document order. The notes do not close their
 * list items reliably, but their <ul>/<ol> tags balance, so depth is what
 * bounds a subdivision.
 */
export function indexListItems(html) {
  const items = [];
  let depth = 0;
  const re = /<(\/?)(?:ul|ol)\b[^>]*>|<li\b[^>]*\bvalue='([^']*)'/g;
  for (const m of html.matchAll(re)) {
    if (m[2] === undefined) depth += m[1] ? -1 : 1;
    else items.push({ pos: m.index, value: m[2].replace(/\s+/g, ''), depth });
  }
  return items;
}

export class Chapter99Notes {
  constructor(html) {
    this.html = String(html || '');
    this.items = indexListItems(this.html);
  }

  /** Index of the list item enclosing the nth occurrence of `anchor`, or -1. */
  itemAt(anchor, occurrence = 0) {
    let from = 0;
    let at = -1;
    for (let k = 0; k <= occurrence; k++) {
      at = this.html.indexOf(anchor, from);
      if (at < 0) return -1;
      from = at + anchor.length;
    }
    let lo = 0;
    let hi = this.items.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.items[mid].pos <= at) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  /**
   * Index of the item that ends item i, or -1: the next item at the same or a
   * shallower depth, or the next marker in i's own sequence ("(d)" ends at
   * "(e)") if that comes first. Either alone fails somewhere: note 20 nests
   * some lists one level too deep, and a last subdivision has no successor.
   */
  end(i) {
    const { depth, value } = this.items[i];
    const next = nextMarker(value);
    for (let j = i + 1; j < this.items.length; j++) {
      if (this.items[j].depth <= depth) return j;
      if (next && this.items[j].value === next) return j;
    }
    return -1;
  }

  /** Index of the next sibling of item i, or -1 when its parent ends first. */
  sibling(i) {
    const j = this.end(i);
    return j >= 0 && this.items[j].value === nextMarker(this.items[i].value) ? j : -1;
  }

  /** Raw HTML of item i, children included. */
  segment(i) {
    const j = this.end(i);
    return this.html.slice(this.items[i].pos, j >= 0 ? this.items[j].pos : this.html.length);
  }

  /**
   * Resolve a list: the item enclosing `anchor`, then `step` siblings forward.
   * Returns { value, text, fullCodes, partialCodes }.
   */
  list({ anchor, occurrence = 0, step = 0 }) {
    let i = this.itemAt(anchor, occurrence);
    if (i < 0) return null;
    for (let k = 0; k < step; k++) {
      i = this.sibling(i);
      if (i < 0) return null;
    }
    const text = htmlToText(this.segment(i));
    return { value: this.items[i].value, text, ...classifyCodes(text) };
  }
}

// A provision cited inside a description of particular articles, as opposed
// to one enumerated in a list:
//   "Etrogs (classifiable in subheading 0805.90.01)"
//   "Other printed books ..., provided for in subheading 4901.99.00, except for
//    such printed matter provided for in statistical reporting number ..."
// A list header ("classifiable in the provisions of the HTSUS enumerated in
// this subdivision: 8471.50 ...", "classified in 8-digit subheading
// 4015.12.10") is not a description.
const PARTIAL_CUE = /\((?:classifiable|described|provided for)\s+in\b[^()]*$|\bprovided for in (?:sub)?heading\s*$|\bexcept\b[^.;:]*$/i;
// A bare 4-digit heading only counts inside a list: after another code, a
// colon or semicolon, an opening parenthesis, or the word "heading(s)".
// "a TPP threshold of 4800" is not heading 4800.
const DATE_TAIL = /[A-Z][a-z]+\.? \d{1,2}, ?$/;
const HEADING_CONTEXT = /(?:\d|[:;(,]|\bheadings?|\band|\bor)\s*$/i;

/**
 * Split a list's provisions into enumerated ones (the whole provision is
 * covered) and ones cited inside an article description (only the described
 * articles are). The cue is read from the text since the previous code.
 */
export function classifyCodes(text) {
  const full = new Set();
  const partial = new Set();
  let last = 0;
  for (const m of String(text || '').matchAll(CODE_RE)) {
    const code = normalizeCode(m[1]);
    const before = text.slice(Math.max(last, m.index - 120), m.index);
    last = m.index + m[0].length;
    if (code.startsWith('99')) continue;
    const ch = Number(code.slice(0, 2));
    if (ch < 1 || ch > 97) continue;
    // "April 29, 2025" is a date, not heading 2025.
    if (code.length === 4) {
      const window = text.slice(Math.max(0, m.index - 40), m.index);
      if (DATE_TAIL.test(window) || !HEADING_CONTEXT.test(window)) continue;
    }
    (PARTIAL_CUE.test(before) ? partial : full).add(code);
  }
  for (const c of full) partial.delete(c);
  return { fullCodes: [...full], partialCodes: [...partial] };
}

/** Additional ad valorem rate from a chapter 99 "general" cell. */
export function parseAdditionalRate(general) {
  const g = String(general || '').replace(/\s+/g, ' ').trim();
  if (!g) return null;
  // "The duty provided in the applicable subheading + 25%" / "plus 7.5%"
  let m = g.match(/(?:\+|plus)\s*(\d+(?:\.\d+)?)\s*%\s*$/i);
  if (m) return { addPct: Number(m[1]), topUpTo: null };
  // "The duty provided in the applicable subheading" with no addition
  if (/^The duty provided in the applicable subheading\.?$/i.test(g)) return { addPct: 0, topUpTo: null };
  // A bare "15%" replaces column 1 with a combined rate (EU/Japan-style deals).
  m = g.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (m) return { addPct: null, topUpTo: Number(m[1]) };
  return null;
}

/** "on or after ... <Month D, YYYY>" and "through/before <date>" from a heading description. */
export function parseEffectiveWindow(description) {
  const d = String(description || '');
  const DATE = '([A-Z][a-z]+ \\d{1,2}, \\d{4})';
  const iso = (s) => {
    const t = Date.parse(`${s} UTC`);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
  };
  const from = d.match(new RegExp(`on or after (?:12:01 a\\.m\\.[^,]*?on )?${DATE}`));
  const through = d.match(new RegExp(`through ${DATE}`));
  const before = d.match(new RegExp(`and before (?:12:01 a\\.m\\.[^,]*?on )?${DATE}`));
  return {
    effectiveFrom: from ? iso(from[1]) : '',
    // "through X" is inclusive; "before X" ends the day before.
    effectiveThrough: through ? iso(through[1]) : before ? iso(new Date(Date.parse(`${before[1]} UTC`) - 86_400_000).toUTCString().slice(5, 16)) : '',
  };
}

// ---------------------------------------------------------------------------
// Measure catalog
// ---------------------------------------------------------------------------

const CHINA = ['156'];

// EU members as UN M49 codes (note 52 headings name "a member state of the
// European Union").
export const EU_MEMBERS_M49 = Object.freeze([
  '040', '056', '100', '191', '196', '203', '208', '233', '246', '250', '276', '300', '348', '372',
  '380', '428', '440', '442', '470', '528', '616', '620', '642', '703', '705', '724', '752',
]);

const S232_CONDITION = 'Section 232 rates vary by origin deal and, for some derivatives, apply to metal content only.';

/**
 * Product-list duties. `list` locates the subdivision enumerating covered
 * provisions; `minCodes` guards against an anchor that drifted onto the wrong
 * item. Table entries cover the whole provision; prose entries describe
 * particular articles inside one, so they are stored as partial matches.
 */
export const LIST_DUTIES = Object.freeze([
  // Section 301 China (U.S. note 20). Exclusion notes (vvv)/(www) below.
  { id: 's301-cn-l1', heading: '9903.88.01', authority: 'SECTION_301', program: 'China List 1', partners: CHINA, note: '20(b)', list: { anchor: 'For the purposes of heading 9903.88.01, products of China', step: 1, expect: 'Heading 9903.88.01 applies' }, minCodes: 500 },
  { id: 's301-cn-l2', heading: '9903.88.02', authority: 'SECTION_301', program: 'China List 2', partners: CHINA, note: '20(d)', list: { anchor: 'For the purposes of heading 9903.88.02, products of China', step: 1, expect: 'Heading 9903.88.02 applies' }, minCodes: 200 },
  { id: 's301-cn-l3', heading: '9903.88.03', authority: 'SECTION_301', program: 'China List 3', partners: CHINA, note: '20(f)', list: { anchor: 'For the purposes of heading 9903.88.03, products of China', step: 1, expect: 'Heading 9903.88.03 applies' }, minCodes: 4000 },
  { id: 's301-cn-l4a', heading: '9903.88.15', authority: 'SECTION_301', program: 'China List 4A', partners: CHINA, note: '20(s)', list: { anchor: 'For the purposes of heading 9903.88.15, products of China', step: 1, expect: 'Heading 9903.88.15 applies' }, minCodes: 2000 },
  // Section 301 China four-year review (U.S. note 31). These products were
  // moved out of the note 20 lists, so the two never stack on one provision.
  { id: 's301-cn-r1', heading: '9903.91.01', authority: 'SECTION_301', program: 'China four-year review', partners: CHINA, note: '31(b)', list: { anchor: 'Heading 9903.91.01 applies to products of China', expect: 'Heading 9903.91.01 applies' }, minCodes: 100 },
  { id: 's301-cn-r2', heading: '9903.91.02', authority: 'SECTION_301', program: 'China four-year review', partners: CHINA, note: '31(c)', list: { anchor: 'Heading 9903.91.02 applies to products of China', expect: 'Heading 9903.91.02 applies' }, minCodes: 1 },
  { id: 's301-cn-r3', heading: '9903.91.03', authority: 'SECTION_301', program: 'China four-year review', partners: CHINA, note: '31(d)', list: { anchor: 'Heading 9903.91.03 applies to products of China', expect: 'Heading 9903.91.03 applies' }, minCodes: 5 },
  { id: 's301-cn-r5', heading: '9903.91.05', authority: 'SECTION_301', program: 'China four-year review', partners: CHINA, note: '31(f)(i)', list: { anchor: 'Heading 9903.91.05 applies to products of China', expect: 'Heading 9903.91.05 applies' }, minCodes: 5 },
  { id: 's301-cn-r6', heading: '9903.91.06', authority: 'SECTION_301', program: 'China four-year review', partners: CHINA, note: '31(g)', list: { anchor: 'Heading 9903.91.06 applies to products of China', expect: 'Heading 9903.91.06 applies' }, minCodes: 1 },
  { id: 's301-cn-r7', heading: '9903.91.07', authority: 'SECTION_301', program: 'China four-year review', partners: CHINA, note: '31(h)', list: { anchor: 'Heading 9903.91.07 applies to products of China', expect: 'Heading 9903.91.07 applies' }, minCodes: 1, partialAll: true },
  { id: 's301-cn-r8', heading: '9903.91.08', authority: 'SECTION_301', program: 'China four-year review', partners: CHINA, note: '31(i)', list: { anchor: 'Heading 9903.91.08 applies to products of China', expect: 'Heading 9903.91.08 applies' }, minCodes: 1 },
  { id: 's301-cn-r11', heading: '9903.91.11', authority: 'SECTION_301', program: 'China four-year review', partners: CHINA, note: '31(j)', list: { anchor: 'Heading 9903.91.11 applies to products of China', expect: 'Heading 9903.91.11 applies' }, minCodes: 1 },
  { id: 's301-cn-r12', heading: '9903.91.12', authority: 'SECTION_301', program: 'China four-year review', partners: CHINA, note: '31(k)', list: { anchor: 'Heading 9903.91.12 applies to intermodal chassis', expect: 'Heading 9903.91.12 applies' }, minCodes: 1, partialAll: true },
  { id: 's301-cn-r14', heading: '9903.91.14', authority: 'SECTION_301', program: 'China four-year review', partners: CHINA, note: '31(l)', list: { anchor: 'Heading 9903.91.14 applies to ship-to-shore gantry cranes', expect: 'Heading 9903.91.14 applies' }, minCodes: 1, partialAll: true },

  // Section 232. Flagged, not summed: the applicable rate depends on origin
  // deals, certification and metal content.
  { id: 's232-metals', heading: '9903.82.02', authority: 'SECTION_232', program: 'Steel, aluminum and copper', partners: null, note: '16(c)', list: { anchor: 'apply to the full customs value of articles classifiable in the provisions of the HTSUS enumerated in the following lists', expect: 'Headings 9903.82.02' }, minCodes: 300, conditional: S232_CONDITION },
  { id: 's232-autos', heading: '9903.94.01', authority: 'SECTION_232', program: 'Passenger vehicles and light trucks', partners: null, note: '33(b)', list: { anchor: 'The rates of duty set forth in headings 9903.94.01, 9903.94.02', expect: 'The rates of duty set forth in headings 9903.94.01' }, minCodes: 5, conditional: S232_CONDITION },
  { id: 's232-auto-parts', heading: '9903.94.05', authority: 'SECTION_232', program: 'Automobile parts', partners: null, note: '33(g)', list: { anchor: "Subject to a manufacturer's import adjustment offset amount that may be determined by the Secretary of Commerce under", expect: 'Subject to a manufacturer' }, minCodes: 50, conditional: S232_CONDITION },
  { id: 's232-lumber', heading: '9903.76.01', authority: 'SECTION_232', program: 'Softwood timber and lumber', partners: null, note: '37(b)', list: { anchor: 'The rates of duty set forth in heading 9903.76.01 apply to all imported softwood timber', expect: 'The rates of duty set forth in heading 9903.76.01' }, minCodes: 5, conditional: S232_CONDITION },
  { id: 's232-furniture', heading: '9903.76.02', authority: 'SECTION_232', program: 'Upholstered wooden furniture', partners: null, note: '37(d)', list: { anchor: 'The rates of duty set forth in headings 9903.76.02, 9903.76.20', expect: 'The rates of duty set forth in headings 9903.76.02' }, minCodes: 2, conditional: S232_CONDITION },
  { id: 's232-cabinets', heading: '9903.76.03', authority: 'SECTION_232', program: 'Kitchen cabinets and vanities', partners: null, note: '37(f)', list: { anchor: 'the rates of duty set forth in headings 9903.76.03, 9903.76.20', expect: 'the rates of duty set forth in headings 9903.76.03' }, minCodes: 2, conditional: S232_CONDITION },
  { id: 's232-trucks', heading: '9903.74.01', authority: 'SECTION_232', program: 'Medium- and heavy-duty vehicles', partners: null, note: '38(b)', list: { anchor: 'The rate of duty set forth in heading 9903.74.01 applies to imported products', expect: 'The rate of duty set forth in heading 9903.74.01' }, minCodes: 5, conditional: S232_CONDITION },
  { id: 's232-buses', heading: '9903.74.02', authority: 'SECTION_232', program: 'Buses', partners: null, note: '38(c)', list: { anchor: 'Heading 9903.74.02 applies to buses and other vehicles', expect: 'Heading 9903.74.02 applies' }, minCodes: 3, conditional: S232_CONDITION },
  { id: 's232-truck-parts', heading: '9903.74.08', authority: 'SECTION_232', program: 'Medium- and heavy-duty vehicle parts', partners: null, note: '38(i)', list: { anchor: 'import adjustment offset amount that may be determined by the Secretary of Commerce under Proclamation 10984', expect: 'Subject to a manufacturer' }, minCodes: 50, conditional: S232_CONDITION },
  { id: 's232-semis', heading: '9903.79.01', authority: 'SECTION_232', program: 'Semiconductors', partners: null, note: '39(b)', list: { anchor: 'refers to imported products meeting certain technical parameters', expect: 'For the purposes of this note' }, minCodes: 1, conditional: 'Applies only to semiconductor articles meeting the technical parameters in U.S. note 39(b); end-use exemptions apply.' },
  { id: 's232-pharma', heading: '9903.04.60', authority: 'SECTION_232', program: 'Patented pharmaceuticals', partners: null, note: '40(c)', list: { anchor: 'The headings provided in subdivision (a) of this note and the defined terms of this subdivision apply to articles', expect: 'The headings provided in subdivision (a)' }, minCodes: 20, conditional: 'Applies only to patented pharmaceutical articles; origin deals and company onshoring plans lower the rate.' },
  { id: 's232-drones', heading: '9903.08.21', authority: 'SECTION_232', program: 'Unmanned aircraft systems', partners: null, note: '43(c)', list: { anchor: 'Headings 9903.08.21', expect: 'Headings 9903.08.21' }, minCodes: 3, conditional: 'Applies to the unmanned aircraft and parts described in U.S. note 43(c).' },
]);

/**
 * Country-wide duties. One measure per heading row in `range`; the country is
 * read from the description and resolved with `resolveCountry`.
 */
export const COUNTRY_DUTY_RANGES = Object.freeze([
  { idPrefix: 's301-fl', from: '9903.05.20', to: '9903.05.84', authority: 'SECTION_301', program: 'Forced labor (Section 301)', note: '52(a)' },
  { idPrefix: 's301-br', from: '9903.05.01', to: '9903.05.01', authority: 'SECTION_301', program: 'Brazil (Section 301)', note: '50(a)' },
]);

/**
 * Exemptions from the country-wide duties. `appliesTo` is the id prefix of the
 * duties they lift; `partners` narrows them to one exporter where the note
 * does. `conditional` marks an exemption that depends on end use or on how the
 * goods are entered, which the lookup cannot know.
 */
export const EXEMPTIONS = Object.freeze([
  { id: 'x-fl-list', heading: '9903.05.86', appliesTo: 's301-fl', note: '52(b)', list: { anchor: 'As provided in heading 9903.05.86', expect: 'As provided in heading 9903.05.86' }, minCodes: 500 },
  { id: 'x-fl-articles', heading: '9903.05.87', appliesTo: 's301-fl', note: '52(c)', list: { anchor: 'As provided in heading 9903.05.87', expect: 'As provided in heading 9903.05.87' }, minCodes: 3, partialAll: true },
  { id: 'x-fl-aircraft', heading: '9903.05.88', appliesTo: 's301-fl', note: '52(d)', list: { anchor: 'As provided in heading 9903.05.88', expect: 'As provided in heading 9903.05.88' }, minCodes: 100, conditional: 'Civil aircraft and parts meeting general note 6.' },
  { id: 'x-fl-pharma', heading: '9903.05.89', appliesTo: 's301-fl', note: '52(e)', list: { anchor: 'As provided in heading 9903.05.89', expect: 'As provided in heading 9903.05.89' }, minCodes: 100, conditional: 'Articles for use in pharmaceutical applications.' },
  { id: 'x-fl-uk', heading: '9903.05.96', appliesTo: 's301-fl', partners: ['826'], note: '52(j)(1)', list: { anchor: 'As provided in heading 9903.05.96', expect: 'As provided in heading 9903.05.96' }, minCodes: 10 },
  { id: 'x-fl-eu', heading: '9903.05.97', appliesTo: 's301-fl', partners: EU_MEMBERS_M49, note: '52(j)(2)', list: { anchor: 'As provided in heading 9903.05.97', expect: 'As provided in heading 9903.05.97' }, minCodes: 10 },
  { id: 'x-fl-ch', heading: '9903.05.98', appliesTo: 's301-fl', partners: ['756', '438'], note: '52(j)(3)', list: { anchor: 'As provided in heading 9903.05.98', expect: 'As provided in heading 9903.05.98' }, minCodes: 10 },
  { id: 'x-fl-my', heading: '9903.05.99', appliesTo: 's301-fl', partners: ['458'], note: '52(j)(4)(i)', list: { anchor: 'As provided in heading 9903.05.99', expect: 'As provided in heading 9903.05.99' }, minCodes: 10 },
  { id: 'x-fl-my-articles', heading: '9903.06.01', appliesTo: 's301-fl', partners: ['458'], note: '52(j)(4)(ii)', list: { anchor: 'As provided in heading 9903.06.01', expect: 'As provided in heading 9903.06.01' }, minCodes: 1, partialAll: true },
  { id: 'x-fl-kh', heading: '9903.06.02', appliesTo: 's301-fl', partners: ['116'], note: '52(j)(5)(i)', list: { anchor: 'As provided in heading 9903.06.02', expect: 'As provided in heading 9903.06.02' }, minCodes: 10 },
  { id: 'x-fl-kh-articles', heading: '9903.06.03', appliesTo: 's301-fl', partners: ['116'], note: '52(j)(5)(ii)', list: { anchor: 'As provided in heading 9903.06.03', expect: 'As provided in heading 9903.06.03' }, minCodes: 1, partialAll: true },
  { id: 'x-fl-gt', heading: '9903.06.04', appliesTo: 's301-fl', partners: ['320'], note: '52(j)(6)(i)', list: { anchor: 'As provided in heading 9903.06.04', expect: 'As provided in heading 9903.06.04' }, minCodes: 10 },
  { id: 'x-fl-gt-articles', heading: '9903.06.05', appliesTo: 's301-fl', partners: ['320'], note: '52(j)(6)(ii)', list: { anchor: 'As provided in heading 9903.06.05', expect: 'As provided in heading 9903.06.05' }, minCodes: 1, partialAll: true },
  { id: 'x-fl-gt-textiles', heading: '9903.06.06', appliesTo: 's301-fl', partners: ['320'], note: '52(j)(6)(iii)', list: { anchor: 'As provided in heading 9903.06.06', expect: 'As provided in heading 9903.06.06' }, minCodes: 100, conditional: 'Textiles and apparel meeting the CAFTA-DR conditions in U.S. note 52(j)(6)(iii).' },
  { id: 'x-fl-sv', heading: '9903.06.07', appliesTo: 's301-fl', partners: ['222'], note: '52(j)(7)(i)', list: { anchor: 'As provided in heading 9903.06.07', expect: 'As provided in heading 9903.06.07' }, minCodes: 10 },
  { id: 'x-fl-sv-articles', heading: '9903.06.08', appliesTo: 's301-fl', partners: ['222'], note: '52(j)(7)(ii)', list: { anchor: 'As provided in heading 9903.06.08', expect: 'As provided in heading 9903.06.08' }, minCodes: 1, partialAll: true },
  { id: 'x-fl-sv-textiles', heading: '9903.06.09', appliesTo: 's301-fl', partners: ['222'], note: '52(j)(7)(iii)', list: { anchor: 'As provided in heading 9903.06.09', expect: 'As provided in heading 9903.06.09' }, minCodes: 100, conditional: 'Textiles and apparel meeting the CAFTA-DR conditions in U.S. note 52(j)(7)(iii).' },
  { id: 'x-fl-ar', heading: '9903.06.10', appliesTo: 's301-fl', partners: ['032'], note: '52(j)(8)(i)', list: { anchor: 'As provided in heading 9903.06.10', expect: 'As provided in heading 9903.06.10' }, minCodes: 10 },
  { id: 'x-fl-ar-articles', heading: '9903.06.11', appliesTo: 's301-fl', partners: ['032'], note: '52(j)(8)(ii)', list: { anchor: 'As provided in heading 9903.06.11', expect: 'As provided in heading 9903.06.11' }, minCodes: 1, partialAll: true },
  { id: 'x-fl-bd', heading: '9903.06.12', appliesTo: 's301-fl', partners: ['050'], note: '52(j)(9)(i)', list: { anchor: 'As provided in heading 9903.06.12', expect: 'As provided in heading 9903.06.12' }, minCodes: 10 },
  { id: 'x-fl-bd-articles', heading: '9903.06.13', appliesTo: 's301-fl', partners: ['050'], note: '52(j)(9)(ii)', list: { anchor: 'As provided in heading 9903.06.13', expect: 'As provided in heading 9903.06.13' }, minCodes: 1, partialAll: true },
  { id: 'x-fl-tw', heading: '9903.06.14', appliesTo: 's301-fl', partners: ['158'], note: '52(j)(10)(i)', list: { anchor: 'As provided in heading 9903.06.14', expect: 'As provided in heading 9903.06.14' }, minCodes: 10 },
  { id: 'x-fl-tw-articles', heading: '9903.06.15', appliesTo: 's301-fl', partners: ['158'], note: '52(j)(10)(ii)', list: { anchor: 'As provided in heading 9903.06.15', expect: 'As provided in heading 9903.06.15' }, minCodes: 1, partialAll: true },
  { id: 'x-fl-id', heading: '9903.06.16', appliesTo: 's301-fl', partners: ['360'], note: '52(j)(11)(i)', list: { anchor: 'As provided in heading 9903.06.16', expect: 'As provided in heading 9903.06.16' }, minCodes: 10 },
  { id: 'x-fl-id-articles', heading: '9903.06.17', appliesTo: 's301-fl', partners: ['360'], note: '52(j)(11)(ii)', list: { anchor: 'As provided in heading 9903.06.17', expect: 'As provided in heading 9903.06.17' }, minCodes: 1, partialAll: true },
  { id: 'x-fl-ec', heading: '9903.06.18', appliesTo: 's301-fl', partners: ['218'], note: '52(j)(12)(i)', list: { anchor: 'As provided in heading 9903.06.18', expect: 'As provided in heading 9903.06.18' }, minCodes: 10 },
  { id: 'x-fl-ec-articles', heading: '9903.06.19', appliesTo: 's301-fl', partners: ['218'], note: '52(j)(12)(ii)', list: { anchor: 'As provided in heading 9903.06.19', expect: 'As provided in heading 9903.06.19' }, minCodes: 1, partialAll: true },
  { id: 'x-fl-jo', heading: '9903.06.20', appliesTo: 's301-fl', partners: ['400'], note: '52(j)(13)(i)', list: { anchor: 'As provided in heading 9903.06.20', expect: 'As provided in heading 9903.06.20' }, minCodes: 100 },
  { id: 'x-fl-jo-articles', heading: '9903.06.21', appliesTo: 's301-fl', partners: ['400'], note: '52(j)(13)(ii)', list: { anchor: 'As provided in heading 9903.06.21', expect: 'As provided in heading 9903.06.21' }, minCodes: 1, partialAll: true },
  { id: 'x-br-list', heading: '9903.05.03', appliesTo: 's301-br', note: '50(a)(ii)', list: { anchor: 'As provided in heading 9903.05.03', expect: 'As provided in heading 9903.05.03' }, minCodes: 500 },
  { id: 'x-br-articles', heading: '9903.05.04', appliesTo: 's301-br', note: '50(a)(iii)', list: { anchor: 'As provided in heading 9903.05.04', expect: 'As provided in heading 9903.05.04' }, minCodes: 3, partialAll: true },
  { id: 'x-br-aircraft', heading: '9903.05.05', appliesTo: 's301-br', note: '50(a)(iv)', list: { anchor: 'As provided in heading 9903.05.05', expect: 'As provided in heading 9903.05.05' }, minCodes: 100, conditional: 'Civil aircraft and parts meeting general note 6.' },
  { id: 'x-br-pharma', heading: '9903.05.06', appliesTo: 's301-br', note: '50(a)(v)', list: { anchor: 'As provided in heading 9903.05.06', expect: 'As provided in heading 9903.05.06' }, minCodes: 100, conditional: 'Articles for use in pharmaceutical applications.' },
  // China four-year-review and List exclusions still in effect: described
  // articles only, so always partial.
  { id: 'x-cn-vvv', heading: '9903.88.69', appliesTo: 's301-cn-l', note: '20(vvv)', list: { marker: '(vvv)', expect: 'particular products classified in heading 9903.88.01' }, minCodes: 10, partialAll: true },
  { id: 'x-cn-www', heading: '9903.88.70', appliesTo: 's301-cn-l2', note: '20(www)', list: { marker: '(www)', expect: 'particular products classified in heading 9903.88.02' }, minCodes: 1, partialAll: true },
]);

/**
 * Exemptions with no product list: they turn on how the goods are entered.
 * The lookup reports them against the affected duties as conditions.
 */
export const ENTRY_CONDITIONS = Object.freeze([
  { id: 'c-fl-usmca-ca', heading: '9903.05.93', appliesTo: 's301-fl', partners: ['124'], note: '52(g)', condition: 'Not applied to goods entered free of duty under USMCA.' },
  { id: 'c-fl-usmca-mx', heading: '9903.05.94', appliesTo: 's301-fl', partners: ['484'], note: '52(h)', condition: 'Not applied to goods entered free of duty under USMCA.' },
  { id: 'c-fl-cafta', heading: '9903.05.95', appliesTo: 's301-fl', partners: ['188', '214', '222', '320', '340', '558'], chapters: [50, 63], note: '52(i)', condition: 'Not applied to CAFTA-DR originating textiles and apparel.' },
  { id: 'c-fl-232', heading: '9903.05.90', appliesTo: 's301-fl', overlaps: 'SECTION_232', note: '52(f)', condition: 'Not applied to goods that pay a Section 232 duty.' },
  { id: 'c-br-232', heading: '9903.05.07', appliesTo: 's301-br', overlaps: 'SECTION_232', note: '50(a)(vi)', condition: 'Not applied to goods that pay a Section 232 duty.' },
]);

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function headingMap(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const h = String(r?.htsno || '').trim();
    if (/^99\d{2}\.\d{2}\.\d{2}$/.test(h)) map.set(h, r);
  }
  return map;
}

function headingRange(map, from, to) {
  return [...map.keys()].filter((h) => h >= from && h <= to).sort();
}

const COUNTRY_RE = /(?:articles the product of|products? of) (.+?)(?:,| with an ad valorem| as provided)/;

/** Country name in a note 52 / note 50 heading, e.g. "the United Arab Emirates". */
export function countryFromDescription(description) {
  const m = String(description || '').match(COUNTRY_RE);
  return m ? m[1].trim() : '';
}

function addCoverage(coverage, code, entry) {
  const ch = code.slice(0, 2);
  const shard = coverage[ch] || (coverage[ch] = {});
  const list = shard[code] || (shard[code] = []);
  if (!list.some((e) => e[0] === entry[0] && e[1] === entry[1])) list.push(entry);
}

function resolveList(notes, spec) {
  if (spec.list.marker) {
    // The last item carrying this marker: the long-running exclusion notes
    // ((vvv), (www)) sit at the end of U.S. note 20.
    const i = notes.items.findLastIndex((it) => it.value === spec.list.marker);
    if (i < 0) return null;
    const text = htmlToText(notes.segment(i));
    return { value: spec.list.marker, text, ...classifyCodes(text) };
  }
  const anchor = spec.list.anchor;
  return notes.list({ anchor, occurrence: spec.list.occurrence ?? 0, step: spec.list.step ?? 0 });
}

/**
 * Build the duty index. Throws when a curated measure cannot be resolved.
 *
 * @param {{ notesHtml: string, headingRows: object[], release: { name: string, startDate?: string },
 *           resolveCountry: (name: string) => string[] | null, now?: Date }} input
 */
export function buildUsDutyIndex({ notesHtml, headingRows, release, resolveCountry, now = new Date() }) {
  if (!release?.name) throw new Error('HTS release name missing');
  const notes = new Chapter99Notes(notesHtml);
  if (notes.items.length < 1000) throw new Error(`chapter 99 notes look truncated (${notes.items.length} list items)`);
  const headings = headingMap(headingRows);
  const measures = {};
  const coverage = {};
  const today = now.toISOString().slice(0, 10);
  const problems = [];

  const headingInfo = (spec) => {
    const row = headings.get(spec.heading);
    if (!row) { problems.push(`${spec.id}: heading ${spec.heading} missing`); return null; }
    const window = parseEffectiveWindow(row.description);
    return { row, ...window };
  };

  const windowState = (from, through) => {
    if (through && through < today) return 'EXPIRED';
    if (from && from > today) return 'SCHEDULED';
    return 'IN_FORCE';
  };

  const listEntries = (spec) => {
    const found = resolveList(notes, spec);
    if (!found) { problems.push(`${spec.id}: list anchor not found`); return null; }
    if (spec.list.expect && !found.text.includes(spec.list.expect)) {
      problems.push(`${spec.id}: list ${found.value} does not start as expected`);
      return null;
    }
    const full = spec.partialAll ? [] : found.fullCodes;
    const partial = spec.partialAll ? [...found.fullCodes, ...found.partialCodes] : found.partialCodes;
    const total = new Set([...full, ...partial]).size;
    if (total < spec.minCodes) {
      problems.push(`${spec.id}: ${total} provisions, expected at least ${spec.minCodes}`);
      return null;
    }
    return { full: [...new Set(full)], partial: [...new Set(partial)].filter((c) => !full.includes(c)) };
  };

  for (const spec of LIST_DUTIES) {
    const info = headingInfo(spec);
    if (!info) continue;
    const rate = parseAdditionalRate(info.row.general);
    if (!rate) { problems.push(`${spec.id}: rate not parsed from "${info.row.general}"`); continue; }
    const state = windowState(info.effectiveFrom, info.effectiveThrough);
    if (state === 'EXPIRED') continue;
    const entries = listEntries(spec);
    if (!entries) continue;
    measures[spec.id] = {
      id: spec.id, kind: 'duty', heading: spec.heading, authority: spec.authority, program: spec.program,
      partners: spec.partners, scope: 'LISTED_PRODUCTS', rateText: info.row.general, addPct: rate.addPct, topUpTo: rate.topUpTo,
      effectiveFrom: info.effectiveFrom, effectiveThrough: info.effectiveThrough, state,
      note: `U.S. note ${spec.note}`, condition: spec.conditional || '',
    };
    for (const code of entries.full) addCoverage(coverage, code, [spec.id, ROLE_APPLY]);
    for (const code of entries.partial) addCoverage(coverage, code, [spec.id, ROLE_APPLY, 1]);
  }

  for (const range of COUNTRY_DUTY_RANGES) {
    const hs = headingRange(headings, range.from, range.to);
    if (hs.length === 0) { problems.push(`${range.idPrefix}: no headings in ${range.from}–${range.to}`); continue; }
    for (const h of hs) {
      const row = headings.get(h);
      const rate = parseAdditionalRate(row.general);
      const name = countryFromDescription(row.description);
      const partners = name ? resolveCountry(name) : null;
      if (!rate) { problems.push(`${range.idPrefix} ${h}: rate not parsed from "${row.general}"`); continue; }
      if (!partners?.length) { problems.push(`${range.idPrefix} ${h}: country not resolved from "${name}"`); continue; }
      const window = parseEffectiveWindow(row.description);
      const state = windowState(window.effectiveFrom, window.effectiveThrough);
      if (state === 'EXPIRED') continue;
      // EU/Japan/Korea/Swiss/Taiwan headings come in pairs split on the
      // column 1 rate: the "equal to or greater than" half adds nothing.
      const threshold = row.description.match(/column 1(?:-General)? (equal to or greater than|less than) (\d+(?:\.\d+)?) percent/);
      measures[`${range.idPrefix}-${h}`] = {
        id: `${range.idPrefix}-${h}`, kind: 'duty', heading: h, authority: range.authority, program: range.program,
        partners, scope: 'ALL_PRODUCTS', rateText: row.general, addPct: rate.addPct, topUpTo: rate.topUpTo,
        mfnBand: threshold ? { below: threshold[1] === 'less than', pct: Number(threshold[2]) } : null,
        effectiveFrom: window.effectiveFrom, effectiveThrough: window.effectiveThrough, state,
        note: `U.S. note ${range.note}`, condition: '',
      };
    }
  }

  for (const spec of EXEMPTIONS) {
    const row = headings.get(spec.heading);
    if (!row) { problems.push(`${spec.id}: heading ${spec.heading} missing`); continue; }
    const window = parseEffectiveWindow(row.description);
    if (windowState(window.effectiveFrom, window.effectiveThrough) === 'EXPIRED') continue;
    const entries = listEntries(spec);
    if (!entries) continue;
    measures[spec.id] = {
      id: spec.id, kind: 'exemption', heading: spec.heading, appliesTo: spec.appliesTo, partners: spec.partners || null,
      note: `U.S. note ${spec.note}`, condition: spec.conditional || '',
      effectiveThrough: window.effectiveThrough,
    };
    for (const code of entries.full) addCoverage(coverage, code, [spec.id, ROLE_EXEMPT]);
    for (const code of entries.partial) addCoverage(coverage, code, [spec.id, ROLE_EXEMPT, 1]);
  }

  for (const spec of ENTRY_CONDITIONS) {
    if (!headings.has(spec.heading)) { problems.push(`${spec.id}: heading ${spec.heading} missing`); continue; }
    measures[spec.id] = {
      id: spec.id, kind: 'condition', heading: spec.heading, appliesTo: spec.appliesTo, partners: spec.partners || null,
      chapters: spec.chapters || null, overlaps: spec.overlaps || '', note: `U.S. note ${spec.note}`, condition: spec.condition,
    };
  }

  if (problems.length) {
    const err = new Error(`US HTS chapter 99 index rejected: ${problems.join('; ')}`);
    err.problems = problems;
    throw err;
  }

  let provisions = 0;
  for (const shard of Object.values(coverage)) provisions += Object.keys(shard).length;
  return {
    schema: US_HTS_INDEX_SCHEMA,
    release: release.name,
    releaseStartDate: release.startDate || '',
    measures,
    coverage,
    provisions,
  };
}

/**
 * Country resolver for note 50/52 heading names ("the United Arab Emirates",
 * "Hong Kong, China", "a member state of the European Union").
 *
 * @param {(name: string) => string | null} nameToIso2
 * @param {Record<string, string>} unToIso2 UN M49 -> ISO2
 */
export function makeCountryResolver(nameToIso2, unToIso2) {
  const iso2ToUn = {};
  for (const [un, iso2] of Object.entries(unToIso2 || {})) if (!iso2ToUn[iso2]) iso2ToUn[iso2] = un;
  return (name) => {
    const n = String(name || '').replace(/^the /i, '').trim();
    if (/member state of the European Union/i.test(n)) return [...EU_MEMBERS_M49];
    if (/^Hong Kong\b/i.test(n)) return ['344'];
    const iso2 = nameToIso2(n);
    const un = iso2 ? iso2ToUn[iso2] : null;
    return un ? [un] : null;
  };
}

/** Redis keys. Coverage shards are versioned by release so a reader never mixes two. */
export const US_HTS_CATALOG_KEY = 'trade:us-hts:catalog:v1';
/** Durable (no TTL) marker set after the first catalog publish; api/health.js binds it. */
export const US_HTS_ACTIVATION_KEY = 'seed-activated:trade:us-hts';
export const US_HTS_COVERAGE_PREFIX = 'trade:us-hts:coverage:v1';
export function usHtsCoverageKey(release, chapter) {
  return `${US_HTS_COVERAGE_PREFIX}:${release}:${chapter}`;
}
