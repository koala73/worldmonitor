import ts from 'typescript';

// ---------------------------------------------------------------------------
// Shared source-text scanning for the enforce-*.mjs gates
// ---------------------------------------------------------------------------
//
// `enforce-panel-content-writes.mjs` and `enforce-safe-local-storage.mjs` both
// count idioms in comment-stripped source. They carried byte-identical copies
// of the two helpers below, and the copy carried a hole that made both gates
// silently blind to real code (#7833 review).
//
// THE HOLE: the old implementation ran two regexes over RAW source, block
// comments first:
//
//     .replace(/\/\*[\s\S]*?\*\//g, blank)   // then
//     .replace(/\/\/[^\n]*/g, blank)
//
// A `/*` inside a LINE comment or a STRING is not a block-comment opener, but
// that first regex cannot tell. `src/app/panel-layout.ts` contains the line
// comment
//
//     // `className: 'panel-wide'`, declared in src/components/*Panel.ts). A deferred
//
// whose `/*` opened a bogus comment region that ran to the next `*/` and blanked
// 1826 of the file's 4554 lines. Two live `localStorage` dereferences sat inside
// that region, so the guard measured 7 where the file has 9 — and any NEW
// dereference landing in those 1826 lines would have passed CI green. For a
// merge-blocking gate that is the worst failure available: not a crash, a
// confident all-clear over unread code.
//
// The fix is a single left-to-right pass with explicit state, because comment
// and string starts are only meaningful when you already know which one you are
// inside — which is exactly the context two independent regexes throw away.

/**
 * Blank out comments while preserving offsets and line count.
 *
 * Tracks five states in one pass — code, line comment, block comment, quoted
 * string, and template literal (honoring backslash escapes), with a stack of
 * open `${…}` interpolations so nested templates resume the right one — so a
 * `/*` or `//` inside a string or another comment can never open a region.
 * Comment characters become spaces and newlines survive, so byte offsets and
 * line numbers still line up with the original for error reporting.
 *
 * String CONTENTS are deliberately preserved rather than blanked. These gates
 * count code idioms, and blanking strings would be the same silent-blindness
 * trade in another coat; a scanner that keeps them can over-count an idiom
 * quoted in a string, which fails LOUDLY as an inventory mismatch instead.
 *
 * KNOWN LIMIT: regex literals are not tracked, so a regex containing `//`
 * (e.g. `/https:\/\//`) can still open a spurious line comment. That shape does
 * not occur in the scanned trees today, and unlike the bug above it is visible
 * as an inventory mismatch rather than a silent pass on the common case. Track
 * regex state here if it ever appears, rather than reverting to regex stripping.
 */
/**
 * Blank out comments while preserving offsets and line count, and report
 * whether the result can be trusted.
 *
 * Comment ranges come from the TypeScript PARSER, not from a hand lexer. Five
 * review rounds found five ways a hand lexer loses track — a `/*` inside a line
 * comment, one inside a string, a nested template interpolation, an untracked
 * regex literal (live in `src/main.ts:454`, de-syncing that file from line 455
 * to EOF), and a regex statement after a control condition. Each fix closed one
 * shape and the next round found another, because separating a regex from a
 * division genuinely requires parser context. The parser already has it.
 *
 * The failure mode being designed out is specific and nasty: a mis-lex does not
 * throw, it silently blanks real code, and the gate then reports a clean scan
 * of a file it never read. `ok: false` (a file that does not parse) is the
 * backstop for that, and callers fail on it rather than scanning less than they
 * claim.
 *
 * String CONTENTS are deliberately preserved. These gates count code idioms,
 * and blanking strings would be the same silent-blindness trade in another
 * coat; keeping them can over-count an idiom quoted in a string, which fails
 * LOUDLY as an inventory mismatch instead.
 */
export function lexSource(source) {
  const file = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = source.split('');
  const blankRange = (pos, end) => {
    for (let i = pos; i < end && i < out.length; i++) {
      // Newlines survive in every range, so byte offsets and line numbers
      // still line up with the original for error reporting.
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  // Comments live in the trivia around each token, so walking every token (not
  // just every node) reaches all of them, including the ones before EOF.
  //
  // BOTH sides are required. `getLeadingCommentRanges` treats a comment sharing
  // a line with preceding code as TRAILING trivia of that previous token and
  // does not return it, so a leading-only walk left every end-of-line `/* … */`
  // in place — which is a silent under-strip, the same failure direction this
  // scanner exists to avoid.
  const seenStarts = new Set();
  const seenEnds = new Set();
  const visit = (node) => {
    const fullStart = node.getFullStart();
    if (!seenStarts.has(fullStart)) {
      seenStarts.add(fullStart);
      for (const range of ts.getLeadingCommentRanges(source, fullStart) ?? []) {
        blankRange(range.pos, range.end);
      }
    }
    const end = node.getEnd();
    if (!seenEnds.has(end)) {
      seenEnds.add(end);
      for (const range of ts.getTrailingCommentRanges(source, end) ?? []) {
        blankRange(range.pos, range.end);
      }
    }
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);

  // `parseDiagnostics` is TypeScript-internal but stable, and it is the honest
  // signal here: a file this scanner cannot parse is one it cannot be trusted
  // to have read.
  const parseErrors = file.parseDiagnostics ?? [];
  return { code: out.join(''), ok: parseErrors.length === 0, terminalMode: parseErrors.length === 0 ? 'code' : 'parse-error' };
}

/**
 * Comment-stripped source only. Prefer `lexSource` in a gate: it also reports
 * whether the lex is trustworthy, and a gate that ignores that can scan far
 * less than it thinks while still passing.
 */
export function stripComments(source) {
  return lexSource(source).code;
}

/**
 * Every `.ts` file under `dir`, recursively, sorted for stable output.
 *
 * Uses `lstatSync` rather than `statSync` so a symlinked directory is skipped
 * instead of followed — a link pointing outside the repo (or at an ancestor)
 * would otherwise let a gate scan foreign files or recurse until it hangs.
 */
export function collectTsFiles(dir, { readdirSync, lstatSync, join }) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) out.push(...collectTsFiles(abs, { readdirSync, lstatSync, join }));
    else if (abs.endsWith('.ts')) out.push(abs);
  }
  return out.sort();
}
