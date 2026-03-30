import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const cmd = readFileSync(resolve(root, 'src/components/AviationCommandBar.ts'), 'utf-8');

// ---------------------------------------------------------------------------
// Default date — must use local calendar arithmetic, never UTC
// ---------------------------------------------------------------------------
describe('AviationCommandBar — default date is local tomorrow, not UTC', () => {
    it('addLocalDays uses setDate(getDate() + n), not toISOString (UTC-safe)', () => {
        assert.ok(
            cmd.includes('d.setDate(d.getDate() + n)'),
            'addLocalDays must use setDate/getDate arithmetic to stay in local time',
        );
        assert.match(
            cmd,
            /const addLocalDays = \(n: number\): string =>/,
            'addLocalDays helper must be defined as a typed lambda',
        );
    });

    it('addLocalDays pads month and day to 2 digits', () => {
        // Ensures YYYY-MM-DD format, not YYYY-M-D
        assert.ok(
            cmd.includes("padStart(2, '0')"),
            'addLocalDays must zero-pad month and day with padStart(2, "0")',
        );
    });

    it('default date uses addLocalDays(1) (tomorrow), not a hardcoded value', () => {
        assert.match(
            cmd,
            /const date = intent\.date \?\? addLocalDays\(1\)/,
            'default date must be addLocalDays(1) — tomorrow in user local timezone',
        );
    });

    it('does NOT call toISOString() in PRICE_WATCH handler (only allowed in comments)', () => {
        // toISOString() returns UTC midnight which truncates to yesterday in negative-offset zones.
        // The comment on the addLocalDays helper mentions toISOString() as a warning — that's fine.
        const priceWatchIdx = cmd.indexOf("if (intent.type === 'PRICE_WATCH')");
        assert.ok(priceWatchIdx !== -1, 'PRICE_WATCH handler not found');
        const handlerSection = cmd.slice(priceWatchIdx, priceWatchIdx + 1200);
        // Strip comment lines before checking for actual calls
        const nonCommentLines = handlerSection
            .split('\n')
            .filter(l => !l.trimStart().startsWith('//'))
            .join('\n');
        assert.ok(
            !nonCommentLines.includes('toISOString()'),
            'PRICE_WATCH handler must NOT call toISOString() in non-comment code — use addLocalDays instead',
        );
    });
});

// ---------------------------------------------------------------------------
// Date chips — rendered for correct intervals, carry fly prefix
// ---------------------------------------------------------------------------
describe('AviationCommandBar — date chips', () => {
    it('renders chips for days [1, 3, 7, 14, 30]', () => {
        // The const that drives chip generation
        assert.ok(
            cmd.includes('[1, 3, 7, 14, 30]'),
            'date chips must be generated for days [1, 3, 7, 14, 30]',
        );
    });

    it('chip rerun cmd uses "fly" prefix, not "price"', () => {
        assert.match(
            cmd,
            /const cmd = `fly \$\{intent\.origin\}/,
            'date chip rerun command must start with "fly", not "price"',
        );
        assert.ok(
            !cmd.includes('`price ${intent.origin}'),
            'date chip rerun must not use old "price" prefix',
        );
    });

    it('Tomorrow label is used for the 1-day chip', () => {
        assert.ok(
            cmd.includes("days === 1 ? 'Tomorrow' : `+${days}d`"),
            'first chip must show "Tomorrow", subsequent chips show "+Nd"',
        );
    });

    it('active chip uses green design-system token, not blue', () => {
        assert.ok(
            cmd.includes('var(--green,#44ff88)') || cmd.includes("var(--green, #44ff88)"),
            'active date chip must use --green token, not blue #60a5fa',
        );
        assert.ok(
            !cmd.includes("'#60a5fa'"),
            'no hardcoded blue #60a5fa must appear in AviationCommandBar',
        );
    });

    it('inactive chip border uses --border token', () => {
        assert.ok(
            cmd.includes('var(--border,#2a2a2a)'),
            'inactive date chip border must use --border token matching design system',
        );
    });
});

// ---------------------------------------------------------------------------
// Intent parser — fly keyword and aliases
// ---------------------------------------------------------------------------
describe('AviationCommandBar — intent parser keyword: fly', () => {
    it('recognises FLY keyword', () => {
        assert.match(
            cmd,
            /FLY\|FLIGHTS\?/,
            'intent parser must recognise FLY as primary keyword',
        );
    });

    it('recognises FLIGHTS, FARES, FARE, BOOK as aliases', () => {
        const parserRegex = cmd.match(/\/\^\(FLY[^/]+\/\.test\(w\)/);
        assert.ok(parserRegex, 'intent parser must use regex with FLY and aliases');
        const pattern = parserRegex[0];
        assert.ok(pattern.includes('FLIGHT'), 'alias FLIGHT must be present');
        assert.ok(pattern.includes('FARE'), 'alias FARE must be present');
        assert.ok(pattern.includes('BOOK'), 'alias BOOK must be present');
    });

    it('does NOT recognise PRICE / PRICES as trigger keywords', () => {
        // The old PRICE[S]? regex must be gone from the intent parser
        assert.ok(
            !cmd.match(/\/\^PRICE\[S\]\?/),
            'intent parser must not have old PRICE[S]? regex — keyword was renamed to fly',
        );
    });

    it('nonKeyword filter strips all aliases including BOOK', () => {
        assert.match(
            cmd,
            /BOOK\|TO\|FROM/,
            'nonKeyword filter must include BOOK so it is not passed to airport resolver',
        );
    });
});

// ---------------------------------------------------------------------------
// Price rows — design system colours
// ---------------------------------------------------------------------------
describe('AviationCommandBar — price row colours follow design system', () => {
    it('price value uses --green token, not blue', () => {
        assert.ok(
            cmd.includes("color:var(--green,#44ff88);font-weight:600"),
            'price value must be coloured with --green, not #60a5fa',
        );
    });

    it('nonstop label uses --green token', () => {
        assert.match(
            cmd,
            /stopColor = f\.stops === 0 \? 'var\(--green,#44ff88\)'/,
            'nonstop stop label must use --green token',
        );
    });
});
