/**
 * Minimal multi-select country chip picker.
 *
 * Self-contained inline render + bind helper. No dependency on the followed-
 * countries primitive (PR A) — alertRules.countries ships independently.
 *
 * Usage:
 *   const picker = mountCountryChipPicker(rootEl, { initial: ['US', 'GB'] });
 *   picker.getValue(); // → ['US', 'GB']
 *   picker.onChange((next) => console.log(next));
 *
 * Validation: input is normalized to uppercase ISO-3166 alpha-2 (regex
 * `^[A-Z]{2}$`); non-matching values are rejected with an inline error.
 */

import { toFlagEmoji } from '@/utils/country-flag';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


// Curated short-list of countries that show up on the picker by default.
// Users can type any 2-letter ISO code into the input to add others; this
// list just seeds the chip cloud so the user doesn't stare at an empty box.
// Order ~loosely follows news-traffic frequency on WorldMonitor; not
// comprehensive, deliberately so — the picker prioritizes "type-to-add" over
// "scroll a 250-row list."
const COMMON_COUNTRIES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'CN', name: 'China' },
  { code: 'JP', name: 'Japan' },
  { code: 'IN', name: 'India' },
  { code: 'BR', name: 'Brazil' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'RU', name: 'Russia' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'IL', name: 'Israel' },
  { code: 'IR', name: 'Iran' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'AE', name: 'UAE' },
  { code: 'TR', name: 'Türkiye' },
  { code: 'EG', name: 'Egypt' },
  { code: 'MX', name: 'Mexico' },
  { code: 'KR', name: 'South Korea' },
];

export interface CountryChipPickerOptions {
  initial?: string[];
  onChange?: (codes: string[]) => void;
  // When true, render the inline "Leave empty to receive alerts from all
  // countries" hint underneath the chip row. Default true.
  showAllHint?: boolean;
}

export interface CountryChipPickerHandle {
  getValue: () => string[];
  setValue: (codes: string[]) => void;
  destroy: () => void;
}

const ISO2_RE = /^[A-Z]{2}$/;
export const COUNTRY_CHIP_PICKER_MAX = 50;

/**
 * Normalize one user-entered value to a valid ISO-3166 alpha-2 code, or null
 * if the shape doesn't match. Mirrors the server-side normalizeCountries
 * regex so the UI rejects what the server would silently drop.
 */
export function normalizeIso2(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  return ISO2_RE.test(upper) ? upper : null;
}

function dedupe(codes: string[]): string[] {
  return [...new Set(codes)];
}

function normalizeList(codes: string[]): string[] {
  return dedupe(codes.map(normalizeIso2).filter((c): c is string => c !== null))
    .slice(0, COUNTRY_CHIP_PICKER_MAX);
}

export function mountCountryChipPicker(
  root: HTMLElement,
  opts: CountryChipPickerOptions = {},
): CountryChipPickerHandle {
  let value: string[] = normalizeList(opts.initial ?? []);

  function emit(): void {
    if (opts.onChange) opts.onChange(value.slice());
  }

  function render(): void {
    const showAllHint = opts.showAllHint !== false;
    const selectedSet = new Set(value);

    const chipRow = COMMON_COUNTRIES.map(({ code, name }) => {
      const on = selectedSet.has(code);
      // Selected chips carry a ✕ so removal is discoverable (clicking anywhere
      // on the chip toggles it off via the delegated handler). Decorative
      // (aria-hidden) — screen readers get the toggle state from aria-pressed.
      return `<button type="button" class="us-notif-country-chip${on ? ' us-notif-country-chip-on' : ''}" data-code="${code}" aria-pressed="${on ? 'true' : 'false'}" title="${on ? `Remove ${name}` : `Add ${name}`}">${toFlagEmoji(code)} ${code}${on ? ' <span class="us-notif-country-chip-x" aria-hidden="true">×</span>' : ''}</button>`;
    }).join('');

    // Custom-added codes that aren't in COMMON_COUNTRIES — render them so the
    // user can deselect. Always selected, so always show the ✕ remove glyph.
    const extras = value.filter(code => !COMMON_COUNTRIES.some(c => c.code === code));
    const extraChips = extras.map(code =>
      `<button type="button" class="us-notif-country-chip us-notif-country-chip-on" data-code="${code}" aria-pressed="true" title="Remove ${code}">${toFlagEmoji(code)} ${code} <span class="us-notif-country-chip-x" aria-hidden="true">×</span></button>`,
    ).join('');

    setTrustedHtml(root, trustedHtml(`
      <div class="us-notif-country-chips" data-country-chip-row>${chipRow}${extraChips}</div>
      <div class="us-notif-country-add-row" style="margin-top:6px;display:flex;gap:6px;align-items:center">
        <input type="text" class="unified-settings-input" data-country-add-input placeholder="Add code (e.g. PL)" maxlength="2" style="width:90px;text-transform:uppercase">
        <button type="button" class="us-notif-ch-btn" data-country-add-btn>Add</button>
        <span class="us-notif-country-error" data-country-error style="color:#c00;font-size:12px;display:none">Enter a 2-letter ISO country code (e.g. US, GB).</span>
      </div>
      ${showAllHint ? '<div class="ai-flow-toggle-desc" style="margin-top:4px">Leave empty to receive alerts from all countries.</div>' : ''}
    `, "legacy direct innerHTML migration"));
  }

  function onClick(e: Event): void {
    const target = e.target as HTMLElement;
    const chip = target.closest<HTMLElement>('.us-notif-country-chip');
    if (chip) {
      const code = chip.dataset.code;
      if (!code) return;
      if (value.includes(code)) {
        value = value.filter(c => c !== code);
      } else {
        value = dedupe([...value, code]);
      }
      render();
      emit();
      return;
    }
    if (target.matches('[data-country-add-btn]')) {
      const input = root.querySelector<HTMLInputElement>('[data-country-add-input]');
      const errEl = root.querySelector<HTMLElement>('[data-country-error]');
      if (!input) return;
      const norm = normalizeIso2(input.value);
      if (!norm) {
        if (errEl) errEl.style.display = '';
        return;
      }
      if (!value.includes(norm) && value.length >= COUNTRY_CHIP_PICKER_MAX) {
        if (errEl) {
          errEl.textContent = `COUNTRIES_LIMIT_EXCEEDED: maximum ${COUNTRY_CHIP_PICKER_MAX} countries.`;
          errEl.style.display = '';
        }
        return;
      }
      if (errEl) errEl.style.display = 'none';
      if (!value.includes(norm)) {
        value = dedupe([...value, norm]);
        render();
        emit();
      }
      // Refocus the (now re-rendered) input for fast multi-add.
      const next = root.querySelector<HTMLInputElement>('[data-country-add-input]');
      if (next) {
        next.value = '';
        next.focus();
      }
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (!target.matches('[data-country-add-input]')) return;
    e.preventDefault();
    const btn = root.querySelector<HTMLButtonElement>('[data-country-add-btn]');
    if (btn) btn.click();
  }

  render();
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);

  return {
    getValue: () => value.slice(),
    setValue: (codes: string[]) => {
      value = normalizeList(codes);
      render();
      emit();
    },
    destroy: () => {
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeydown);
      setTrustedHtml(root, trustedHtml('', "legacy direct innerHTML migration"));
    },
  };
}

/**
 * Try to seed the picker's initial value from the followed-countries
 * primitive (PR A) via a window-registry pattern.
 *
 * When PR A's followed-countries module is loaded by the app, it self-
 * registers on `window.__wmFollowedCountries`. This picker reads from that
 * registry at runtime — no static or dynamic import, no Vite alias coupling,
 * no `@vite-ignore` tricks. PR A and PR #3632 ship independently and
 * integrate when both deploy.
 *
 * Why window-registry over dynamic import:
 *   - `import(path)` with `@vite-ignore` and a string-variable specifier
 *     leaves the raw `@/services/followed-countries` alias in the browser
 *     bundle. The browser then rejects the module URL because the alias is
 *     a Vite build-time concept, not a real path.
 *   - A registry decouples shipping cadence: PR A self-registers in its own
 *     module-init block; PR #3632 reads if-present.
 *
 * Synchronous (no async): callers do not `await` this.
 *
 * Smart-default ONLY applies on NEW-rule create — kept separate from
 * `mountCountryChipPicker` so editing an existing rule respects the user's
 * explicit `countries`.
 */
interface FollowedCountriesRegistry {
  getFollowed?: () => unknown;
}

export function loadFollowedCountriesSafe(): string[] {
  try {
    const reg = (typeof window !== 'undefined')
      ? (window as { __wmFollowedCountries?: FollowedCountriesRegistry }).__wmFollowedCountries
      : null;
    if (!reg || typeof reg.getFollowed !== 'function') {
      return [];
    }
    const result = reg.getFollowed();
    if (!Array.isArray(result)) return [];
    return result
      .filter((c): c is string => typeof c === 'string')
      .map(normalizeIso2)
      .filter((c): c is string => c !== null);
  } catch {
    return [];
  }
}
