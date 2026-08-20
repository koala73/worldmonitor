/**
 * Splits the translated checkout consent sentence into text and link parts.
 *
 * Zero imports on purpose: the component that uses this pulls in React and the
 * i18n singleton, which cannot be imported under `tsx --test`, so the logic that
 * can actually be wrong lives here where a test can reach it.
 *
 * What can be wrong: a locale that drops or mangles a `{{token}}` renders the
 * raw placeholder to a buyer, inside a legal notice, in a language nobody on
 * the team reads.
 */

export type LegalConsentSlot = 'eula' | 'privacy';

export type LegalConsentPart =
  | { kind: 'text'; value: string }
  | { kind: 'link'; slot: LegalConsentSlot };

const SLOT_PATTERN = /(\{\{eula\}\}|\{\{privacy\}\})/g;

const SLOT_BY_TOKEN: Record<string, LegalConsentSlot> = {
  '{{eula}}': 'eula',
  '{{privacy}}': 'privacy',
};

export function splitLegalConsent(template: string): LegalConsentPart[] {
  return template
    .split(SLOT_PATTERN)
    .filter((part) => part.length > 0)
    .map((part) => {
      const slot = SLOT_BY_TOKEN[part];
      return slot ? ({ kind: 'link', slot } as const) : ({ kind: 'text', value: part } as const);
    });
}

/** True when both links will render — i.e. the translation kept its tokens. */
export function hasBothLegalLinks(parts: LegalConsentPart[]): boolean {
  const slots = new Set(parts.filter((part) => part.kind === 'link').map((part) => part.slot));
  return slots.has('eula') && slots.has('privacy');
}
