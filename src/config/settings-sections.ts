/**
 * The settings sections registry and its navigation reducer.
 *
 * Pure: no DOM access, no i18n, no service imports, so node tests load it
 * directly. Every section id, label, group, order, badge, availability rule and
 * home-row summary lives here. It sits in config so preferences-content
 * (services) and UnifiedSettings (components) can both key their content
 * tables by the derived ids: a registry entry without a page fails the build.
 */

/** A plain snapshot the shell reads before every navigation event. */
export interface SettingsFacts {
  readonly signedIn: boolean;
  readonly isDesktopApp: boolean;
  /** hasEmbedAccessForAccount(role). */
  readonly embedAccess: boolean;
  /** Signed-in account card text. Null when signed out. */
  readonly account: { readonly plan: string; readonly email: string } | null;
  /** Panels that read as on in the Panels page draft. */
  readonly panels: { readonly on: number; readonly total: number };
  readonly sourcesOn: number;
  readonly theme: 'auto' | 'dark' | 'light';
}

/** A home-row summary as data. The view formats it, so this file stays i18n-free. */
export type RowSummary =
  | { readonly kind: 'count'; readonly on: number; readonly total: number }
  | { readonly kind: 'total'; readonly count: number }
  | { readonly kind: 'text'; readonly key: string }
  | { readonly kind: 'account'; readonly plan: string; readonly email: string };

interface SectionDef {
  readonly id: string;
  readonly labelKey: string;
  readonly descKey?: string;
  /** 'preferences' pages are rendered by preferences-content.ts. */
  readonly owner: 'shell' | 'preferences';
  readonly badge?: 'pro';
  readonly available?: (f: SettingsFacts) => boolean;
  /** What the home list shows while the section is unavailable. Default 'hide'. */
  readonly whenUnavailable?: 'hide' | 'sign-in-row';
  readonly summary?: (f: SettingsFacts) => RowSummary | null;
}

interface GroupDef {
  readonly id: string;
  /** Null for the account card, which has no group heading. */
  readonly labelKey: string | null;
  readonly sections: readonly SectionDef[];
}

const THEME_SUMMARY_KEY = {
  auto: 'settings.summary.themeAuto',
  dark: 'preferences.themeDark',
  light: 'preferences.themeLight',
} as const;

export const SETTINGS_GROUPS = [
  {
    id: 'account', labelKey: null, sections: [
      {
        id: 'account', labelKey: 'settings.sections.account', owner: 'shell',
        available: (f) => f.signedIn, whenUnavailable: 'sign-in-row',
        summary: (f) => (f.account ? { kind: 'account', plan: f.account.plan, email: f.account.email } : null),
      },
    ],
  },
  {
    id: 'dashboard', labelKey: 'settings.groups.dashboard', sections: [
      {
        id: 'panels', labelKey: 'header.tabPanels', descKey: 'settings.descriptions.panels', owner: 'shell',
        summary: (f) => ({ kind: 'count', on: f.panels.on, total: f.panels.total }),
      },
      {
        id: 'sources', labelKey: 'header.tabSources', descKey: 'settings.descriptions.sources', owner: 'shell',
        summary: (f) => ({ kind: 'total', count: f.sourcesOn }),
      },
      {
        id: 'notifications', labelKey: 'header.tabNotifications', descKey: 'settings.descriptions.notifications', owner: 'shell',
        available: (f) => !f.isDesktopApp,
      },
    ],
  },
  {
    id: 'preferences', labelKey: 'settings.groups.preferences', sections: [
      {
        id: 'display', labelKey: 'preferences.display', descKey: 'settings.descriptions.display', owner: 'preferences',
        summary: (f) => ({ kind: 'text', key: THEME_SUMMARY_KEY[f.theme] }),
      },
      { id: 'map', labelKey: 'settings.sections.map', descKey: 'settings.descriptions.map', owner: 'preferences' },
      { id: 'ai', labelKey: 'settings.sections.ai', descKey: 'settings.descriptions.ai', owner: 'preferences' },
      { id: 'video', labelKey: 'settings.sections.video', descKey: 'settings.descriptions.video', owner: 'preferences' },
    ],
  },
  {
    id: 'developer', labelKey: 'settings.groups.developer', sections: [
      { id: 'api-keys', labelKey: 'settings.sections.apiKeys', descKey: 'settings.descriptions.apiKeys', owner: 'shell', badge: 'pro' },
      {
        id: 'embeds', labelKey: 'settings.sections.embeds', descKey: 'settings.descriptions.embeds', owner: 'shell', badge: 'pro',
        available: (f) => f.embedAccess,
      },
      { id: 'mcp-clients', labelKey: 'settings.sections.aiAgents', descKey: 'settings.descriptions.aiAgents', owner: 'shell' },
    ],
  },
  {
    id: 'app', labelKey: 'settings.groups.app', sections: [
      { id: 'sync', labelKey: 'settings.sections.sync', owner: 'preferences' },
      { id: 'about', labelKey: 'settings.sections.about', descKey: 'settings.descriptions.about', owner: 'shell' },
    ],
  },
] as const satisfies readonly GroupDef[];

type AnySection = (typeof SETTINGS_GROUPS)[number]['sections'][number];
export type SettingsSectionId = AnySection['id'];
export type PreferenceSectionId = Extract<AnySection, { owner: 'preferences' }>['id'];
export type ShellSectionId = Exclude<SettingsSectionId, PreferenceSectionId>;

const SECTIONS: ReadonlyMap<SettingsSectionId, SectionDef> = new Map(
  SETTINGS_GROUPS.flatMap((group) => group.sections.map((section): [SettingsSectionId, SectionDef] => [section.id, section])),
);

export const SETTINGS_SECTION_IDS: readonly SettingsSectionId[] = [...SECTIONS.keys()];

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === 'string' && SECTIONS.has(value as SettingsSectionId);
}

export function isPreferenceSection(id: SettingsSectionId): id is PreferenceSectionId {
  return SECTIONS.get(id)?.owner === 'preferences';
}

export function sectionLabelKey(id: SettingsSectionId): string {
  return SECTIONS.get(id)?.labelKey ?? id;
}

export function isAvailable(id: SettingsSectionId, f: SettingsFacts): boolean {
  const def = SECTIONS.get(id);
  return def !== undefined && (def.available?.(f) ?? true);
}

export function sectionSummary(id: SettingsSectionId, f: SettingsFacts): RowSummary | null {
  return isAvailable(id, f) ? SECTIONS.get(id)?.summary?.(f) ?? null : null;
}

export type NavRow =
  | {
    readonly kind: 'section';
    readonly id: SettingsSectionId;
    readonly labelKey: string;
    readonly descKey: string | null;
    readonly badge: 'pro' | null;
    readonly summary: RowSummary | null;
  }
  | { readonly kind: 'sign-in' };

export interface NavGroup {
  readonly id: string;
  readonly labelKey: string | null;
  readonly rows: readonly NavRow[];
}

/** Registry to visible home rows, in registry order. Empty groups are dropped. */
export function buildNav(f: SettingsFacts): readonly NavGroup[] {
  const groups: NavGroup[] = [];
  for (const group of SETTINGS_GROUPS) {
    const rows: NavRow[] = [];
    for (const def of group.sections as readonly SectionDef[]) {
      const id = def.id as SettingsSectionId;
      if (isAvailable(id, f)) {
        rows.push({
          kind: 'section',
          id,
          labelKey: def.labelKey,
          descKey: def.descKey ?? null,
          badge: def.badge ?? null,
          summary: def.summary?.(f) ?? null,
        });
      } else if (def.whenUnavailable === 'sign-in-row') {
        rows.push({ kind: 'sign-in' });
      }
    }
    if (rows.length > 0) groups.push({ id: group.id, labelKey: group.labelKey, rows });
  }
  return groups;
}

declare const resolved: unique symbol;

/**
 * Where the settings window is. `page` null is the home list.
 *
 * Branded, so only reduceNav builds one: the current page is always an
 * available section, and a deeper stack is unrepresentable.
 */
export type NavState = { readonly page: SettingsSectionId | null } & { readonly [resolved]: true };

export type NavEvent =
  | { readonly type: 'open'; readonly target?: SettingsSectionId }
  | { readonly type: 'select'; readonly id: SettingsSectionId }
  | { readonly type: 'back' }
  | { readonly type: 'facts-changed' };

function navAt(page: SettingsSectionId | null): NavState {
  return { page } as NavState;
}

/**
 * Pure and total. A transition that lands where it started returns `prev`
 * itself, so a double tap or a replayed event produces no effects.
 *
 *   open(t)        t available ? t : home
 *   select(id)     id available ? id : unchanged
 *   back           home
 *   facts-changed  current page still available ? unchanged : home
 */
export function reduceNav(prev: NavState | null, ev: NavEvent, f: SettingsFacts): NavState {
  let page: SettingsSectionId | null;
  switch (ev.type) {
    case 'open':
      page = ev.target !== undefined && isAvailable(ev.target, f) ? ev.target : null;
      break;
    case 'select':
      page = isAvailable(ev.id, f) ? ev.id : prev?.page ?? null;
      break;
    case 'back':
      page = null;
      break;
    case 'facts-changed':
      page = prev?.page != null && isAvailable(prev.page, f) ? prev.page : null;
      break;
  }
  return prev !== null && prev.page === page ? prev : navAt(page);
}

/** What the shell must do to get from prev to next. Leave always runs before enter. */
export interface NavEffects {
  readonly leave: SettingsSectionId | null;
  readonly enter: SettingsSectionId | null;
}

export function diffNav(prev: NavState | null, next: NavState): NavEffects {
  const from = prev?.page ?? null;
  if (from === next.page) return { leave: null, enter: null };
  return { leave: from, enter: next.page };
}

/** Where Settings is drawn: the full-height phone 'sheet', or the centred 'modal'. */
export type NavLayout = 'sheet' | 'modal';

/** What the shell does with the open page's history entry. Both are idempotent. */
export type PageEntryEffect = 'hold' | 'release';

/**
 * On the sheet an open page holds a history entry above Settings' own, so
 * device Back returns to the home list before it closes Settings. Without a
 * Settings entry beneath it, Back would pop the page and then leave the app.
 */
export function pageEntryEffect(nav: NavState | null, layout: NavLayout, settingsEntry: boolean): PageEntryEffect {
  return layout === 'sheet' && settingsEntry && nav?.page != null ? 'hold' : 'release';
}

/** A mounted page. The shell calls enter on every activation and dispose on close or eviction. */
export interface MountedSection {
  enter?(): void;
  leave?(): void;
  dispose(): void;
}

/** Writes a page body into `body` once per session and wires listeners scoped to it. */
export type SectionMount = (body: HTMLElement) => MountedSection;
