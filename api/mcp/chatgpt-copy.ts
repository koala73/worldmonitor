/**
 * Copy rewriting for ChatGPT (see host-policy.ts).
 *
 * OpenAI's review rejected the app for facilitating commerce in digital
 * services. Tool descriptions and schemas are shared with every client, and
 * they explain API-plan call weights, paid panel allocations and subscription
 * tiers. That is billing detail for API customers; a ChatGPT user has no use
 * for it. This module removes it from the text ChatGPT receives.
 *
 * Text is cut at sentence and clause boundaries (`.` or `;` followed by
 * space). A fragment that names billing, plans, weights or subscriptions is
 * dropped whole; the word "paid" is removed from the fragments that stay.
 * Plan gating itself is unchanged: `_meta["worldmonitor/access"]` and the
 * structured denials still say what an account can call.
 */

const BILLING_FRAGMENT = new RegExp([
  String.raw`\bAPI (?:plans?|allowances?|weight)\b`,
  String.raw`\bweight \d`,
  String.raw`\bbilling\b`,
  String.raw`\bpaid (?:plans?|controls|connections?|MCP|standalone|panel only)\b`,
  String.raw`^Paid\b`,
  String.raw`\bsubscriptions?\b`,
  String.raw`\b(?:Pro|API) Business\b`,
  String.raw`\bEnterprise\b`,
  String.raw`\bupgrade`,
  String.raw`\bcheckout\b`,
  String.raw`\b[Dd]edicated (?:Pro|MCP|paid)\b`,
  String.raw`\bPro (?:panels?|plans?|allowance)\b`,
  String.raw`\bfree allowance\b`,
  String.raw`\bsigned-in free\b`,
  String.raw`^Account depth:`,
  String.raw`\bdaily allocation\b`,
  String.raw`^Requires an? (?:paid|WorldMonitor Pro)\b`,
].join('|'), 'i');

/** True when `text` still carries billing or plan-tier wording. */
export function hasBillingCopy(text: string): boolean {
  return splitFragments(text).some((fragment) => BILLING_FRAGMENT.test(fragment));
}

function splitFragments(text: string): string[] {
  return text.split(/(?<=[.;])\s+/).filter((fragment) => fragment.length > 0);
}

function scrubKept(fragment: string): string {
  return fragment
    .replace(/\s\(Pro\)/g, '')
    .replace(/\b[Pp]aid\s+/g, '');
}

/**
 * `keepLead`: a tool description's first fragment states what the tool does,
 * so it is always kept (scrubbed) even when it mentions billing.
 */
export function stripBillingCopy(text: string, { keepLead = false }: { keepLead?: boolean } = {}): string {
  const fragments = splitFragments(text);
  const kept: string[] = [];
  // A clause joined by `;` to a dropped clause continues its thought
  // ("…paid plans reuse one allocation; refresh starts a new one"), so it
  // goes too.
  let droppedClause = false;
  fragments.forEach((fragment, index) => {
    const drop = !(keepLead && index === 0) && (BILLING_FRAGMENT.test(fragment) || droppedClause);
    if (!drop) kept.push(fragment);
    droppedClause = drop && fragment.endsWith(';');
  });
  // Nothing but billing copy: nothing to keep.
  if (kept.length === 0) return '';
  let out = kept.map(scrubKept).join(' ').trim();
  if (out.endsWith(';')) out = `${out.slice(0, -1)}.`;
  // A kept clause that ended in `;` now runs into a new sentence.
  out = out.replace(/;\s+(?=[A-Z])/g, '. ');
  return out;
}
