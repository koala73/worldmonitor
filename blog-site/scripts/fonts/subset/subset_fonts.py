# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.68.0", "brotli==1.2.1", "uharfbuzz==0.57.0"]
# ///
"""Subset the blog's self-hosted web fonts to what the blog renders.

Run by hand through `npm run fonts:subset` in blog-site/ (see README.md, "Web fonts").
That command builds the blog, crawls every page in Chromium (collect-usage.mjs), then
runs this script with the crawl output. The output is committed:

  src/fonts/<family>-core.woff2   preloaded on every page
  src/fonts/<family>-ext.woff2    fetched only when a page uses one of its characters
  src/styles/fonts.generated.css  @font-face rules
  src/fonts/manifest.json         what each file holds and why

Rendering contract: the blog used to load these families from Google Fonts. Every rule
below exists to render exactly what that produced:
  * Characters Google did not serve for a family (arrows, CJK, Arabic...) stay with the
    system fallback, so the coverage snapshot in google-fonts-snapshot.json caps every file.
  * Characters inside Google's unicode-ranges that none of its files draw stay inside the
    core file's range: Chrome renders some of them (U+2011) differently outside every range.
  * @font-face weights mirror Google's per-weight faces, so CSS weight matching (and
    synthetic italics/bold) is unchanged.
  * Axes keep a side of their range unless no rendered weight needs it; trimming the far
    end of a side would rescale gvar deltas and move points by a font unit or two.
  * A character goes in the extended file only when splitting it from the core does not
    change HarfBuzz shaping of any text on the site (kerning and contextual forms do not
    cross font files).
  * After subsetting, every glyph at every rendered weight is compared with the file
    Google served, outline point by outline point.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import io
import json
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

from fontTools import subset as ftsubset
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = Path(__file__).resolve().parent
BLOG = HERE.parents[2]
FONT_DIR = BLOG / 'src' / 'fonts'
CSS_OUT = BLOG / 'src' / 'styles' / 'fonts.generated.css'
MANIFEST = FONT_DIR / 'manifest.json'
SNAPSHOT = HERE / 'google-fonts-snapshot.json'
CACHE = BLOG / 'node_modules' / '.cache' / 'blog-fonts'

# The stylesheet the blog loaded before self-hosting. Only used by --refresh-google-snapshot.
GOOGLE_CSS = ('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800'
              '&family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;700;800&display=swap')
DESKTOP_UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
              'Chrome/131.0.0.0 Safari/537.36')

GF_RAW = 'https://raw.githubusercontent.com/google/fonts/{commit}/{path}'
FAMILIES = {
    'Inter': {
        'slug': 'inter',
        'source': ('ofl/inter/Inter[opsz,wght].ttf', 'e1d6480102fed30739fead0faee463101f892c8f',
                   '29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031'),
        'license': ('ofl/inter/OFL.txt', 'e1d6480102fed30739fead0faee463101f892c8f',
                    '5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57'),
        # Google's css2 API serves the default optical size when the URL does not ask for opsz.
        'pin': {'opsz': 14},
    },
    'JetBrains Mono': {
        'slug': 'jetbrains-mono',
        'source': ('ofl/jetbrainsmono/JetBrainsMono[wght].ttf', '2e05c1cf00a6e4f40a4b931600a90881c26e15cd',
                   '48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda'),
        'license': ('ofl/jetbrainsmono/OFL.txt', '2e05c1cf00a6e4f40a4b931600a90881c26e15cd',
                    'b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d'),
        'pin': {},
    },
    'Space Grotesk': {
        'slug': 'space-grotesk',
        'source': ('ofl/spacegrotesk/SpaceGrotesk[wght].ttf', '2861cb7b12f90c0a294a12ed666e381e2211872f',
                   'acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72'),
        'license': ('ofl/spacegrotesk/OFL.txt', '2861cb7b12f90c0a294a12ed666e381e2211872f',
                    '564ce565c371c5e5bbf286006565a7c9aa55a9f56e7ca58d56e05d649dd61a72'),
        'pin': {},
    },
}

ASCII = set(range(0x20, 0x7F))
LATIN1 = set(range(0xA0, 0x100))
LATIN_EXT_A = set(range(0x100, 0x180))
# Punctuation every core file carries: curly quotes, en/em dash, ellipsis.
CORE_PUNCT = {0x2018, 0x2019, 0x201C, 0x201D, 0x2013, 0x2014, 0x2026}
# A non-ASCII character used on at least this share of a family's pages also goes in its core.
CORE_PAGE_SHARE = 0.5

# Features Chromium applies to horizontal Latin text without being asked.
DEFAULT_FEATURES = {'ccmp', 'locl', 'rlig', 'rvrn', 'mark', 'mkmk', 'kern', 'calt', 'clig', 'liga', 'rclt', 'curs', 'dist', 'abvm', 'blwm'}
# CSS font-variant values -> OpenType features they turn on.
VARIANT_FEATURES = {
    'tabular-nums': ['tnum'], 'proportional-nums': ['pnum'], 'lining-nums': ['lnum'], 'oldstyle-nums': ['onum'],
    'diagonal-fractions': ['frac'], 'stacked-fractions': ['afrc'], 'ordinal': ['ordn'], 'slashed-zero': ['zero'],
    'small-caps': ['smcp'], 'all-small-caps': ['smcp', 'c2sc'], 'petite-caps': ['pcap'], 'all-petite-caps': ['pcap', 'c2pc'],
    'unicase': ['unic'], 'titling-caps': ['titl'], 'discretionary-ligatures': ['dlig'], 'historical-ligatures': ['hlig'],
    'contextual': ['calt'], 'common-ligatures': ['liga', 'clig'], 'sub': ['subs'], 'super': ['sups'],
}
# BCP 47 primary language -> OpenType language system tags that carry locl lookups in these fonts.
LOCL_LANGS = {'ca': 'CAT ', 'ro': 'ROM ', 'mo': 'MOL ', 'tr': 'TRK ', 'az': 'AZE ', 'crh': 'CRT ', 'nl': 'NLD '}


# ---------------------------------------------------------------- helpers

def log(*a):
    print('[fonts]', *a, file=sys.stderr)


def fetch(url: str, sha256: str | None = None, headers: dict | None = None, fresh: bool = False) -> bytes:
    """Download url through the local cache. fresh=True ignores the cache (snapshot refreshes)."""
    key = hashlib.sha256(url.encode()).hexdigest()[:24]
    cached = CACHE / key
    ok = lambda d: not sha256 or hashlib.sha256(d).hexdigest() == sha256
    if cached.exists() and not fresh:
        data = cached.read_bytes()
        if ok(data):
            return data
        cached.unlink()  # a bad or truncated earlier download: fetch it again
    req = urllib.request.Request(url, headers={'User-Agent': 'worldmonitor-blog-fonts', **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if not ok(data):
        raise SystemExit(f'sha256 mismatch for {url}')
    CACHE.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(data)
    return data


def parse_unicode_range(s: str) -> set[int]:
    out: set[int] = set()
    for part in s.split(','):
        part = part.strip().upper().replace('U+', '')
        if '-' in part:
            a, b = part.split('-')
            out |= set(range(int(a, 16), int(b, 16) + 1))
        elif '?' in part:
            out |= set(range(int(part.replace('?', '0'), 16), int(part.replace('?', 'F'), 16) + 1))
        else:
            out.add(int(part, 16))
    return out


def format_unicode_range(cps) -> str:
    cps = sorted(cps)
    out, start, prev = [], None, None
    for c in cps + [None]:
        if start is None:
            start = prev = c
        elif c is not None and c == prev + 1:
            prev = c
        else:
            out.append(f'U+{start:X}' if start == prev else f'U+{start:X}-{prev:X}')
            start = prev = c
    return ', '.join(out)


def font_bytes(font: TTFont, flavor=None) -> bytes:
    font.flavor = flavor
    # fontTools stamps head.modified with the current time on save; keep the source's value so
    # a rerun on unchanged content reproduces the committed files byte for byte.
    font.recalcTimestamp = False
    # Keep the head bounding box we set (see set_google_bbox); per-glyph boxes are unaffected
    # because subsetting does not change outlines.
    font.recalcBBoxes = False
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def match_face(desired: int, faces: list[int]) -> int:
    """CSS Fonts 4 font-weight matching over single-weight faces."""
    if desired in faces:
        return desired
    lower = sorted([f for f in faces if f < desired], reverse=True)
    higher = sorted([f for f in faces if f > desired])
    if 400 <= desired <= 500:
        between = [f for f in higher if f <= 500]
        return (between or lower or higher)[0]
    if desired < 400:
        return (lower or higher)[0]
    return (higher or lower)[0]


# ---------------------------------------------------------------- Google snapshot

def refresh_google_snapshot():
    css = fetch(GOOGLE_CSS + '#ua', headers={'User-Agent': DESKTOP_UA}, fresh=True).decode()
    snap = {'css_url': GOOGLE_CSS, 'user_agent': DESKTOP_UA, 'families': {}}
    for m in re.finditer(r"/\* ([\w-]+) \*/\s*@font-face \{(.*?)\}", css, re.S):
        subset_name, body = m.groups()
        fam = re.search(r"font-family: '([^']+)'", body).group(1)
        weight = int(re.search(r'font-weight: (\d+)', body).group(1))
        url = re.search(r'url\(([^)]+)\)', body).group(1)
        rng = parse_unicode_range(re.search(r'unicode-range: ([^;]+);', body).group(1))
        served = TTFont(io.BytesIO(fetch(url, fresh=True)))
        cmap = set(served.getBestCmap())
        f = snap['families'].setdefault(fam, {'faces': [], 'subsets': {}, 'display': re.search(r'font-display: (\w+)', body).group(1)})
        if weight not in f['faces']:
            f['faces'].append(weight)
        f['subsets'][subset_name] = {'url': url, 'sha256': hashlib.sha256(fetch(url)).hexdigest(),
                                     'unicode_range': format_unicode_range(rng),
                                     'renders': format_unicode_range(rng & cmap),
                                     # CoreText rasterizes small sizes differently when head.yMax changes,
                                     # so outputs reuse the served file's font bounding box.
                                     'head_bbox': [served['head'].xMin, served['head'].yMin, served['head'].xMax, served['head'].yMax]}
    SNAPSHOT.write_text(json.dumps(snap, indent=2) + '\n')
    log('wrote', SNAPSHOT)


def load_snapshot():
    snap = json.loads(SNAPSHOT.read_text())
    for f in snap['families'].values():
        f['partition'] = {}
        for name, s in f['subsets'].items():
            for cp in parse_unicode_range(s['renders']):
                f['partition'].setdefault(cp, name)
        f['coverage'] = set(f['partition'])
        # In one of Google's unicode-ranges but drawn by none of its files. Chrome renders these
        # differently once they leave every range (U+2011 takes the face's hyphen only while in
        # range), so the core file's range keeps them.
        f['in_no_file'] = set().union(*(parse_unicode_range(s['unicode_range']) for s in f['subsets'].values())) - f['coverage']
    return snap


# ---------------------------------------------------------------- usage

def families_of(ff: str) -> list[str]:
    return [f.strip().strip('"\'') for f in ff.split(',')]


MARKERS = {'disc': '• ', 'circle': '◦ ', 'square': '▪ ', 'decimal': '0123456789. ', 'none': ''}


def run_text(run) -> str | None:
    s, t = run['s'], run['t']
    if run['kind'] == 'marker':
        if run['marker'] not in MARKERS:
            raise SystemExit(f"unhandled list marker {run['marker']!r}: add it to MARKERS")
        t = MARKERS[run['marker']]
    elif run['kind'] in ('::before', '::after'):
        m = re.fullmatch(r'"(.*)"', t, re.S)
        if not m:
            raise SystemExit(f'unhandled generated content {t!r}: teach run_text() to resolve it')
        t = m.group(1)
    tt = s['textTransform']
    if tt in ('uppercase', 'capitalize'):
        t = t + t.upper()
    elif tt == 'lowercase':
        t = t + t.lower()
    if s['textOverflow'] == 'ellipsis':
        t += '…'
    # Hyphenation draws U+2010 when the font has it, else U+002D.
    if s['hyphens'] == 'auto' or '­' in t:
        t += '‐-'
    return t


def collect_usage(crawl, snap):
    cov = {f: snap['families'][f]['coverage'] for f in FAMILIES}
    use = {f: {'chars': collections.Counter(), 'pages': collections.defaultdict(set), 'weights': collections.Counter(),
               'styles': collections.Counter(), 'variants': collections.Counter(), 'feature_settings': collections.Counter(),
               'variation_settings': collections.Counter(), 'langs': collections.Counter(), 'runs': []} for f in FAMILIES}
    system = collections.Counter()
    for page, pd in crawl['pages'].items():
        for run in pd['runs']:
            s = run['s']
            text = run_text(run)
            chain = families_of(s['fontFamily'])
            pieces = collections.defaultdict(str)
            owners = []
            for ch in text:
                cp = ord(ch)
                if ch in '\n\r\t':
                    owners.append(None)
                    continue
                owner = None
                for fam in chain:
                    if fam in cov:
                        if cp in cov[fam]:
                            owner = fam
                            break
                    else:
                        owner = 'system'
                        break
                pieces[owner or 'system'] += ch
                owners.append(owner or 'system')
            for owner, chars in pieces.items():
                if owner == 'system':
                    system.update(c for c in chars if not c.isspace())
                    continue
                u = use[owner]
                u['chars'].update(chars)
                for c in set(chars):
                    u['pages'][ord(c)].add(page)
                u['weights'][int(s['fontWeight'])] += 1
                u['styles'][(int(s['fontWeight']), s['fontStyle'])] += 1
                for prop in ('fontVariantNumeric', 'fontVariantLigatures', 'fontVariantCaps', 'fontVariantEastAsian',
                             'fontVariantPosition', 'fontVariantAlternates'):
                    for v in s[prop].split():
                        if v not in ('normal', 'none'):
                            u['variants'][v] += 1
                if s['fontFeatureSettings'] != 'normal':
                    u['feature_settings'][s['fontFeatureSettings']] += 1
                if s['fontVariationSettings'] != 'normal':
                    u['variation_settings'][s['fontVariationSettings']] += 1
                u['langs'][s['lang'].split('-')[0].lower() or 'en'] += 1
                # The run with every character another font draws replaced by a break (\0), so the
                # shaping check sees exactly the stretches of text this family shapes.
                masked = ''.join(ch if o == owner else '\0' for ch, o in zip(text, owners))
                lang = s['lang'].split('-')[0].lower() or 'en'
                u['runs'].append((masked, int(s['fontWeight']), (tuple(s['fontVariantNumeric'].split()), s['fontFeatureSettings'], lang)))
    return use, system


# ---------------------------------------------------------------- shaping check

def shaper(font_data: bytes, pin: dict):
    import uharfbuzz as hb
    face = hb.Face(font_data)
    fonts = {}

    def shape(text: str, wght: int, style):
        features, lang = style
        key = wght
        if key not in fonts:
            f = hb.Font(face)
            if pin or wght:
                f.set_variations({**pin, 'wght': wght})
            fonts[key] = f
        buf = hb.Buffer()
        buf.add_str(text)
        buf.language = lang
        buf.guess_segment_properties()
        hb.shape(fonts[key], buf, features)
        return [(i.codepoint, p.x_advance, p.x_offset, p.y_offset) for i, p in zip(buf.glyph_infos, buf.glyph_positions)]
    return shape


def segments(text: str, part_of) -> list[tuple[str, str]]:
    out = []
    for ch in text:
        p = None if ch == '\0' else part_of(ord(ch))
        if out and out[-1][0] == p:
            out[-1] = (p, out[-1][1] + ch)
        else:
            out.append((p, ch))
    return out


def shaped(shape, text, wght, feats, part_of):
    glyphs = []
    for part, seg in segments(text, part_of):
        if part is None:
            glyphs.append(None)  # another font draws these: a run boundary in both layouts
            continue
        glyphs.append(tuple(shape(seg, wght, feats)))
    return glyphs


def shaping_differences(shape, runs, rendered_weight, old_part, new_part, features_for):
    """Runs whose glyph positions change when text is split by the new files instead of Google's."""
    diffs = []
    seen = set()
    for text, weight, style in runs:
        key = (text, weight, style)
        if key in seen:
            continue
        seen.add(key)
        w = rendered_weight(weight)
        feats = features_for(style)
        a = shaped(shape, text, w, feats, old_part)
        b = shaped(shape, text, w, feats, new_part)
        flat = lambda segs: [g for seg in segs for g in (seg if seg is not None else ('|',))]
        if flat(a) != flat(b):
            diffs.append((text, weight))
    return diffs


# ---------------------------------------------------------------- outline parity with Google

def outlines(font: TTFont, cps):
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    out = {}
    for cp in cps:
        g = cmap[cp]
        pen = DecomposingRecordingPen(gs)
        gs[g].draw(pen)
        out[cp] = (pen.value, font['hmtx'][g][0])
    return out


def at_weight(font_data: bytes, wght: int) -> TTFont:
    f = TTFont(io.BytesIO(font_data))
    if 'fvar' in f:
        f = instantiateVariableFont(f, {'wght': wght})
    return f


class ShapedFont:
    """A font file shaped with HarfBuzz at one weight, glyphs identified by outline (ids differ between files)."""

    def __init__(self, data: bytes, wght: int):
        import uharfbuzz as hb
        self.hb = hb
        self.font = hb.Font(hb.Face(data))
        tt = TTFont(io.BytesIO(data))
        if 'fvar' in tt:
            self.font.set_variations({'wght': wght})
            tt = instantiateVariableFont(tt, {'wght': wght})
        self.glyphset = tt.getGlyphSet()
        self.order = tt.getGlyphOrder()
        self.sig = {}

    def glyph(self, gid):
        if gid not in self.sig:
            pen = DecomposingRecordingPen(self.glyphset)
            self.glyphset[self.order[gid]].draw(pen)
            self.sig[gid] = hash(repr(pen.value))
        return self.sig[gid]

    def shape(self, text, style):
        features, lang = style
        buf = self.hb.Buffer()
        buf.add_str(text)
        buf.language = lang
        buf.guess_segment_properties()
        self.hb.shape(self.font, buf, features)
        return [(self.glyph(i.codepoint), p.x_advance, p.x_offset, p.y_offset) for i, p in zip(buf.glyph_infos, buf.glyph_positions)]


def shaping_parity(runs, rendered_weight, features_for, old_files, old_part, new_files, new_part):
    """Shape every run with Google's files and with ours; return the runs that differ."""
    cache = {}

    def get(files, key, w):
        if (id(files), key, w) not in cache:
            cache[(id(files), key, w)] = ShapedFont(files[key](), w)
        return cache[(id(files), key, w)]

    def layout(text, w, feats, files, part_of):
        out = []
        for part, seg in segments(text, part_of):
            out.extend([('|',)] if part is None else get(files, part, w).shape(seg, feats))
        return out

    bad, seen = [], set()
    for text, weight, style in runs:
        if (text, weight, style) in seen:
            continue
        seen.add((text, weight, style))
        w, feats = rendered_weight(weight), features_for(style)
        if layout(text, w, feats, old_files, old_part) != layout(text, w, feats, new_files, new_part):
            bad.append(text.replace('\0', '|')[:100])
    return bad


# ---------------------------------------------------------------- main build

def build(crawl_path: Path, verify_google: bool):
    snap = load_snapshot()
    crawl = json.loads(crawl_path.read_text())
    use, system_chars = collect_usage(crawl, snap)
    staged: dict[Path, bytes] = {}
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {'note': 'Generated by blog-site/scripts/fonts/subset/subset_fonts.py via `npm run fonts:subset`. Do not edit.',
                'pages_crawled': len(crawl['pages']), 'families': {}}
    css = ['/* Generated by scripts/fonts/subset/subset_fonts.py (npm run fonts:subset). Do not edit. */']
    failures = []

    for fam, cfg in FAMILIES.items():
        u = use[fam]
        g = snap['families'][fam]
        cov = g['coverage']
        src_path, commit, sha = cfg['source']
        lic_path, lic_commit, lic_sha = cfg['license']
        source = fetch(GF_RAW.format(commit=commit, path=src_path.replace('[', '%5B').replace(']', '%5D')), sha)
        license_text = fetch(GF_RAW.format(commit=lic_commit, path=lic_path), lic_sha).decode()
        head = license_text.split('This Font Software is licensed')[0]
        rfn = re.search(r'Reserved Font Names?\s+"?([^".\n]+)', head)
        if rfn:
            raise SystemExit(f'{fam}: OFL Reserved Font Name {rfn.group(1)!r} — a subset is a Modified Version and '
                             'must be renamed internally. Add a rename step before shipping it.')
        (FONT_DIR / f"{cfg['slug']}-OFL.txt").write_text(license_text)

        base = TTFont(io.BytesIO(source))
        if cfg['pin']:
            base = instantiateVariableFont(base, cfg['pin'])
        src_cmap = set(base.getBestCmap())
        axis = {a.axisTag: a for a in base['fvar'].axes} if 'fvar' in base else {}

        # --- weights: which Google faces are matched, and which wght each renders at
        google_faces = sorted(g['faces'])
        used_weights = sorted(u['weights'])
        matched = sorted({match_face(w, google_faces) for w in used_weights})
        if 'wght' in axis:
            lo, dflt, hi = axis['wght'].minValue, axis['wght'].defaultValue, axis['wght'].maxValue
            rendered = sorted({min(max(w, lo), hi) for w in matched})
        else:
            rendered = matched
        def rendered_weight(w, _m=matched, _f=google_faces, _a=axis):
            face = match_face(w, _f)
            return min(max(face, _a['wght'].minValue), _a['wght'].maxValue) if 'wght' in _a else face

        # --- axes: candidate plans, smallest first. The first whose glyphs match Google's at every
        # rendered weight wins, so a plan that would move outlines (even by rounding) is never shipped.
        candidates = []
        if 'wght' in axis:
            if len(rendered) == 1:
                candidates.append(('pinned', {'wght': rendered[0]}))  # nothing renders at another weight
            new_lo = dflt if min(rendered) >= dflt else lo
            new_hi = dflt if max(rendered) <= dflt else hi
            if (new_lo, new_hi) != (lo, hi):
                # Drops whole sides of the axis only; trimming inside a side would rescale deltas.
                candidates.append(('trimmed', {'wght': (new_lo, new_hi)}))
        candidates.append(('full', {}))

        # --- features
        langs = set(u['langs'])
        features = set(DEFAULT_FEATURES)
        if not any(l in LOCL_LANGS for l in langs):
            features.discard('locl')
        for v in u['variants']:
            features.update(VARIANT_FEATURES.get(v, []))
            if v not in VARIANT_FEATURES and v not in ('no-common-ligatures', 'no-discretionary-ligatures', 'no-contextual'):
                raise SystemExit(f'{fam}: unmapped font-variant value {v!r}')
        for fs in u['feature_settings']:
            for tag, val in re.findall(r'"(\w{4})"\s*(\w+)?', fs):
                if val not in ('0', 'off'):
                    features.add(tag)
        if u['variation_settings']:
            raise SystemExit(f"{fam}: font-variation-settings in use {dict(u['variation_settings'])}: handle axes for it")
        font_features = {fr.FeatureTag for t in ('GSUB', 'GPOS') if t in base for fr in base[t].table.FeatureList.FeatureRecord}
        features &= font_features
        # HarfBuzz builds fractions around U+2044 FRACTION SLASH without being asked (not around
        # U+2215). The features pull in numerator and denominator digits (0.5-3 KB per file), so
        # only a file that has U+2044 keeps them.
        fraction_features = {'frac', 'numr', 'dnom'} & font_features

        def features_for(style):
            """HarfBuzz features and language for one run, as Chromium would shape it."""
            numeric, settings, lang = style
            feats = {}
            for v in numeric:
                for tag in VARIANT_FEATURES.get(v, []):
                    feats[tag] = True
            if settings != 'normal':
                for tag, val in re.findall(r'"(\w{4})"\s*(\w+)?', settings):
                    feats[tag] = val not in ('0', 'off')
            return (feats, lang)

        # --- characters
        used = {ord(c) for c in u['chars']} & cov
        family_pages = set().union(*u['pages'].values()) if u['pages'] else set()
        frequent = {cp for cp in used - ASCII if len(u['pages'][cp]) >= CORE_PAGE_SHARE * max(1, len(family_pages))}
        want = (used | LATIN1 | LATIN_EXT_A | ASCII | CORE_PUNCT) & cov & src_cmap
        # Google's latin file also maps the combining marks in its range (U+0304, U+0308, U+0329).
        # Letters no Google file has a glyph for (Ǖ = U + U+0308 + U+0304) sit in the core's range
        # and are composed from those marks, so the core keeps the ones such letters use.
        parts = {ord(x) for c in g['in_no_file'] for x in unicodedata.normalize('NFD', chr(c))}
        latin_marks = {cp for cp in parse_unicode_range(g['subsets']['latin']['unicode_range'])
                       if unicodedata.category(chr(cp)) == 'Mn'} & parts & cov & src_cmap
        want |= latin_marks
        core = (ASCII | CORE_PUNCT | frequent | latin_marks) & want
        ext = want - core

        # --- shaping check: move characters into the core until splitting changes nothing
        shape = shaper(font_bytes(base), {})
        old_part = lambda cp, _g=g: _g['partition'].get(cp)
        moved = {}
        while True:
            new_part = lambda cp, _c=frozenset(core), _e=frozenset(ext): 'core' if cp in _c else ('ext' if cp in _e else None)
            diffs = shaping_differences(shape, u['runs'], rendered_weight, old_part, new_part, features_for)
            if not diffs:
                break
            culprits = collections.Counter(ord(c) for text, _ in diffs for c in text if ord(c) in ext)
            if not culprits:
                failures.append(f'{fam}: shaping differs without an extended character involved: {diffs[:3]}')
                break
            cp = culprits.most_common(1)[0][0]
            moved[f'U+{cp:04X}'] = next(t for t, _ in diffs if chr(cp) in t)[:80]
            core.add(cp)
            ext.discard(cp)
        log(f'{fam}: core {len(core)} chars, ext {len(ext)} chars, moved to core for shaping: {list(moved)}')

        # --- subset
        def make(cps, plan, part):
            f = TTFont(io.BytesIO(font_bytes(base)))
            if plan and 'fvar' in f:
                # optimize=True re-runs IUP delta optimization, which is what Google's own serving
                # pipeline did: without it ~40 Inter glyphs drift by up to 0.18 units from Google's.
                f = instantiateVariableFont(f, plan, optimize=True)
                # fontTools quirk: the instancer leaves a lazily loaded gvar whose glyph keys the
                # subsetter cannot index (KeyError on e.g. 'braceright.case.tf'). Reload from bytes.
                f = TTFont(io.BytesIO(font_bytes(f)))
            opts = ftsubset.Options()
            opts.layout_features = sorted(features | (fraction_features if 0x2044 in cps else set()))
            opts.layout_scripts = ['*']
            # The sources carry no glyph instructions, fpgm or cvt; their only hinting is a 7-byte
            # prep that sets dropout control. Google serves it to Windows and Linux, so it stays.
            opts.hinting = True
            opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 14]
            opts.name_languages = [0x409]
            # Characters in Google's ranges that no file draws sit in the core's range, so Chrome
            # draws the core's .notdef for them, as it drew Google's (Inter's is a NO GLYPH box).
            opts.notdef_outline = part == 'core'
            # fontTools drops glyph names by default (post format 3). macOS CoreText then rasterizes
            # 11-14px text differently from Google's files, which keep them (format 2).
            opts.glyph_names = True
            opts.drop_tables += ['DSIG', 'STAT', 'meta']
            opts.legacy_kern = False
            sub = ftsubset.Subsetter(opts)
            sub.populate(unicodes=sorted(cps))
            sub.subset(f)
            set_google_bbox(f, cps, plan)
            return f

        bbox_notes = {}

        def set_google_bbox(f, cps, plan):
            """Give the file the head bbox of the Google subset that drew most of its used characters."""
            used_here = {cp for cp in cps if u['chars'][chr(cp)]}
            votes = collections.Counter(g['partition'][cp] for cp in (used_here or cps))
            donor = votes.most_common(1)[0][0]
            box = g['subsets'][donor]['head_bbox']
            others = {g['partition'][cp] for cp in cps} - {donor}
            differing = [n for n in others if g['subsets'][n]['head_bbox'][3] != box[3]]
            # Google's own boxes do not contain every glyph at the axis extremes either; matching
            # the box Google served is what keeps rasterization identical.
            f['head'].xMin, f['head'].yMin, f['head'].xMax, f['head'].yMax = box
            if differing:
                bbox_notes[format_unicode_range({cp for cp in cps if g['partition'][cp] in differing})] = (
                    f"Google drew these from {', '.join(sorted(differing))} (head.yMax "
                    f"{', '.join(str(g['subsets'][n]['head_bbox'][3]) for n in sorted(differing))}); this file uses {donor}'s {box[3]}")

        def google_mismatches(data, cmap):
            bad = set()
            for w in rendered:
                mine = outlines(at_weight(data_to_ttf(data), w), sorted(cmap))
                by_subset = collections.defaultdict(list)
                for cp in cmap:
                    by_subset[g['partition'][cp]].append(cp)
                for sname, cps_ in by_subset.items():
                    gsub = g['subsets'][sname]
                    theirs = outlines(at_weight(data_to_ttf(fetch(gsub['url'], gsub['sha256'])), w), cps_)
                    bad |= {cp for cp in cps_ if theirs[cp] != mine[cp]}
            return bad

        rejected = {}
        chosen = None
        for plan_name, plan in candidates:
            if not verify_google and plan_name == 'pinned':
                continue  # pinning rounds outlines; only take it when parity can be proven
            built = {}
            for part, cps in (('core', core), ('ext', ext)):
                font = make(cps, plan, part)
                cmap = set(font.getBestCmap())
                if cps - cmap:
                    failures.append(f'{fam} {part}: subset lost {format_unicode_range(cps - cmap)}')
                built[part] = (font, font_bytes(font, 'woff2'), cmap)
            bad = set().union(*(google_mismatches(d, c) for _, d, c in built.values())) if verify_google else set()
            if bad:
                rejected[plan_name] = {'plan': {k: list(v) if isinstance(v, tuple) else v for k, v in plan.items()},
                                       'bytes': {p: len(d) for p, (_, d, _) in built.items()},
                                       'glyphs_differing_from_google': format_unicode_range(bad)}
                log(f'{fam}: {plan_name} axis plan rejected, {len(bad)} glyphs differ from Google')
                continue
            chosen = (plan_name, plan, built)
            break
        if chosen is None:
            failures.append(f'{fam}: no axis plan matches Google: {rejected}')
            continue
        plan_name, axis_plan, built = chosen
        if verify_google:
            old_files = {name: (lambda u=sub['url'], h=sub['sha256']: data_to_ttf(fetch(u, h))) for name, sub in g['subsets'].items()}
            new_files = {part: (lambda d=d: data_to_ttf(d)) for part, (_, d, _) in built.items()}
            new_part = lambda cp, _c=frozenset(core), _e=frozenset(ext): 'core' if cp in _c else ('ext' if cp in _e else None)
            bad = shaping_parity(u['runs'], rendered_weight, features_for, old_files, old_part, new_files, new_part)
            if bad:
                failures.append(f'{fam}: {len(bad)} text runs shape differently from Google, e.g. {bad[:3]}')
            else:
                log(f"{fam}: all {len(set(u['runs']))} text runs shape identically to Google's files")
        files = {}
        for part, (font, data, cmap) in built.items():
            name = f"{cfg['slug']}-{part}.woff2"
            staged[FONT_DIR / name] = data
            files[part] = {'file': name, 'bytes': len(data),
                           'unicode_range': format_unicode_range(cmap | g['in_no_file'] if part == 'core' else cmap),
                           'glyphs': font['maxp'].numGlyphs,
                           'axes': {a.axisTag: [a.minValue, a.defaultValue, a.maxValue] for a in font['fvar'].axes} if 'fvar' in font else {},
                           'features': sorted({fr.FeatureTag for t in ('GSUB', 'GPOS') if t in font for fr in font[t].table.FeatureList.FeatureRecord}),
                           'tables': sorted(font.keys())}

        faces = sorted(set(matched))
        for weight in faces:
            for part in ('ext', 'core'):
                css.append('@font-face {\n'
                           f"  font-family: '{fam}';\n  font-style: normal;\n  font-weight: {weight};\n"
                           f"  font-display: {g['display']};\n"
                           f"  src: url('../fonts/{files[part]['file']}') format('woff2');\n"
                           f"  unicode-range: {files[part]['unicode_range']};\n}}")
        manifest['families'][fam] = {
            'source': {'path': src_path, 'commit': commit, 'sha256': sha, 'pinned_axes': cfg['pin']},
            'faces': faces, 'computed_weights_seen': used_weights, 'rendered_wght': rendered,
            'axis_plan': plan_name, 'axes_kept': {k: list(v) if isinstance(v, tuple) else v for k, v in {**cfg['pin'], **axis_plan}.items()},
            'axis_plans_rejected': rejected,
            'google_parity_checked': verify_google,
            'features_kept': sorted(features), 'langs_seen': sorted(langs),
            'chars_used': ''.join(chr(c) for c in sorted(used)),
            'core_extra_chars': {f'U+{cp:04X}': f'on {len(u["pages"][cp])} of {len(family_pages)} pages' for cp in sorted(frequent)},
            'moved_to_core_for_shaping': moved,
            'head_bbox_differs_from_google_for': bbox_notes,
            'files': files,
        }

    manifest['system_rendered_chars'] = ''.join(sorted(system_chars))
    if failures:
        for f in failures:
            log('FAIL', f)
        raise SystemExit(1)
    # Only touch the committed files once every family has passed.
    for path, data in staged.items():
        path.write_bytes(data)
    CSS_OUT.write_text('\n'.join(css) + '\n')
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    for fam, m in manifest['families'].items():
        log(f"{fam}: core {m['files']['core']['bytes']} B, ext {m['files']['ext']['bytes']} B, faces {m['faces']}, axes {m['axes_kept']} ({m['axis_plan']})")
    log('wrote', CSS_OUT, MANIFEST)


def data_to_ttf(data: bytes) -> bytes:
    f = TTFont(io.BytesIO(data))
    return font_bytes(f, None)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--usage', type=Path, help='crawl output written by run.mjs')
    ap.add_argument('--refresh-google-snapshot', action='store_true')
    ap.add_argument('--skip-google-parity', action='store_true', help='skip the glyph comparison with Google-served files (offline)')
    a = ap.parse_args()
    if a.refresh_google_snapshot:
        refresh_google_snapshot()
    if a.usage:
        build(a.usage, not a.skip_google_parity)
