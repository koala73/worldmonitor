// Single-pass HTML entity decoder for client-side news/text sanitising.
//
// Decodes exactly one entity level per call (issue #5436): sequential
// `.replace()` chains that decode `&amp;` alongside other entities turn
// escaped-once markup like `&amp;lt;script&amp;gt;` into live `<script>`.
// Shared by CountryDeepDivePanel and its news utils; the seeder-side
// equivalent lives in `scripts/shared/entity-decode.mjs` (kept separate to
// avoid a `scripts/ → src/` build dependency).

const NAMED: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#(\d+)|#[xX]([0-9a-fA-F]+));/g, (m, dec, hex) => {
    if (dec !== undefined || hex !== undefined) {
      const cp = hex !== undefined ? parseInt(hex, 16) : Number(dec);
      if (cp === 39) return "'";
      if (cp === 47) return '/';
      return m;
    }
    return NAMED[m] ?? m;
  });
}
