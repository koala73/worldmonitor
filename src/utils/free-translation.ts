/**
 * Which translations a caller without Pro may still request.
 *
 * Headline translation is a Pro feature. One automatic path stays free: OREF
 * (Israel Home Front Command) alerts arrive in Hebrew, and the dashboard
 * translates the strings its dictionary cannot cover into English for every
 * visitor. The server (summarize-article.ts) and the client (summarization.ts)
 * share this rule so a free browser never sends a request the server refuses.
 *
 * The rule is the text, not the caller's say-so: Hebrew must be most of the
 * letters, and the target must be English. A token Hebrew word cannot carry
 * other text through, and Hebrew cannot be sent to any other language.
 */
const LETTER_RE = /\p{L}/gu;
const HEBREW_LETTER_RE = /\p{Script=Hebrew}/u;

export function isFreeAlertTranslation(text: string, targetLang: string): boolean {
  if (targetLang !== 'en' || !text) return false;
  const letters = text.match(LETTER_RE) ?? [];
  let hebrew = 0;
  for (const letter of letters) if (HEBREW_LETTER_RE.test(letter)) hebrew += 1;
  return hebrew > 0 && hebrew * 2 > letters.length;
}
