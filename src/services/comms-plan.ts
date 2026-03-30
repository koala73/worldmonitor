import type { SavedPlace } from './saved-places';
import { getPrimarySavedPlace } from './saved-places';

export type CommsStatus = 'safe' | 'moving' | 'stuck' | 'need_pickup' | 'need_meds';
export type CommsChannelKind = 'sms' | 'signal' | 'call' | 'radio' | 'mesh' | 'satcom' | 'rally' | 'other';

export interface CommsContact {
  id: string;
  label: string;
  value: string;
  role: string;
}

export interface FallbackStep {
  id: string;
  label: string;
  kind: CommsChannelKind;
  instruction: string;
  priority: number;
  link?: string;
}

export interface CheckInWindow {
  id: string;
  label: string;
  cadenceMinutes: number;
  note: string;
}

export interface CommsTemplate {
  status: CommsStatus;
  label: string;
  lead: string;
  action: string;
}

export interface CommsPlan {
  placeId: string;
  contacts: CommsContact[];
  fallbackSteps: FallbackStep[];
  checkInWindows: CheckInWindow[];
  notes: string;
  templateOverrides: Partial<Record<CommsStatus, string>>;
  updatedAt: number;
}

export interface CommsPlanInput {
  placeId: string;
  contacts?: CommsContact[];
  fallbackSteps?: FallbackStep[];
  checkInWindows?: CheckInWindow[];
  notes?: string;
  templateOverrides?: Partial<Record<CommsStatus, string>>;
}

export interface ResolvedCommsPlan extends CommsPlan {
  templates: Record<CommsStatus, CommsTemplate>;
}

export interface CommsPlanStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

const STORAGE_KEY = 'wm_comms_plans_v1';
const CHANGE_EVENT = 'wm:comms-plan-changed';
const VALID_STATUSES: readonly CommsStatus[] = ['safe', 'moving', 'stuck', 'need_pickup', 'need_meds'];
const VALID_KINDS = new Set<CommsChannelKind>(['sms', 'signal', 'call', 'radio', 'mesh', 'satcom', 'rally', 'other']);

export const COMMS_STATUS_ORDER: readonly CommsStatus[] = VALID_STATUSES;
export const COMMS_STATUS_LABELS: Record<CommsStatus, string> = {
  safe: 'Safe',
  moving: 'Moving',
  stuck: 'Stuck',
  need_pickup: 'Need Pickup',
  need_meds: 'Need Meds',
};

function defaultStorage(): CommsPlanStorageLike | null {
  try {
    if (
      typeof localStorage !== 'undefined'
      && typeof localStorage.getItem === 'function'
      && typeof localStorage.setItem === 'function'
    ) {
      return localStorage;
    }
  } catch {}
  return null;
}

function cloneContact(contact: CommsContact): CommsContact {
  return { ...contact };
}

function cloneFallbackStep(step: FallbackStep): FallbackStep {
  return { ...step };
}

function cloneCheckInWindow(window: CheckInWindow): CheckInWindow {
  return { ...window };
}

function clonePlan(plan: CommsPlan): CommsPlan {
  return {
    ...plan,
    contacts: plan.contacts.map((contact) => cloneContact(contact)),
    fallbackSteps: plan.fallbackSteps.map((step) => cloneFallbackStep(step)),
    checkInWindows: plan.checkInWindows.map((window) => cloneCheckInWindow(window)),
    templateOverrides: { ...plan.templateOverrides },
  };
}

function clonePlans(plans: CommsPlan[]): CommsPlan[] {
  return plans.map((plan) => clonePlan(plan));
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePriority(value: unknown, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value as number));
}

function normalizeContacts(raw: unknown): CommsContact[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((contact, index) => {
      if (!contact || typeof contact !== 'object') return null;
      const parsed = contact as Partial<CommsContact>;
      const label = normalizeText(parsed.label);
      const value = normalizeText(parsed.value);
      if (!label || !value) return null;
      return {
        id: normalizeText(parsed.id) || `contact-${index + 1}`,
        label,
        value,
        role: normalizeText(parsed.role),
      };
    })
    .filter((contact): contact is CommsContact => Boolean(contact));
}

function normalizeFallbackSteps(raw: unknown): FallbackStep[] {
  if (!Array.isArray(raw)) return [];
  const steps = raw
    .map((step, index): FallbackStep | null => {
      if (!step || typeof step !== 'object') return null;
      const parsed = step as Partial<FallbackStep>;
      const label = normalizeText(parsed.label);
      const instruction = normalizeText(parsed.instruction);
      const kind = parsed.kind && VALID_KINDS.has(parsed.kind) ? parsed.kind : 'other';
      if (!label || !instruction) return null;
      const normalized: FallbackStep = {
        id: normalizeText(parsed.id) || `step-${index + 1}`,
        label,
        kind,
        instruction,
        priority: normalizePriority(parsed.priority, index + 1),
        link: normalizeText(parsed.link) || undefined,
      };
      return normalized;
    })
    .filter((step): step is FallbackStep => step !== null);
  return steps.sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));
}

function normalizeCheckInWindows(raw: unknown): CheckInWindow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((window, index) => {
      if (!window || typeof window !== 'object') return null;
      const parsed = window as Partial<CheckInWindow>;
      const label = normalizeText(parsed.label);
      if (!label) return null;
      const cadenceMinutes = Number.isFinite(parsed.cadenceMinutes)
        ? Math.max(5, Math.trunc(parsed.cadenceMinutes as number))
        : 30;
      return {
        id: normalizeText(parsed.id) || `window-${index + 1}`,
        label,
        cadenceMinutes,
        note: normalizeText(parsed.note),
      };
    })
    .filter((window): window is CheckInWindow => Boolean(window));
}

function normalizeTemplateOverrides(raw: unknown): Partial<Record<CommsStatus, string>> {
  if (!raw || typeof raw !== 'object') return {};
  const overrides: Partial<Record<CommsStatus, string>> = {};
  for (const status of VALID_STATUSES) {
    const value = normalizeText((raw as Record<string, unknown>)[status]);
    if (value) overrides[status] = value;
  }
  return overrides;
}

function normalizePlan(raw: unknown): CommsPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Partial<CommsPlan>;
  const placeId = normalizeText(parsed.placeId);
  if (!placeId) return null;
  return {
    placeId,
    contacts: normalizeContacts(parsed.contacts),
    fallbackSteps: normalizeFallbackSteps(parsed.fallbackSteps),
    checkInWindows: normalizeCheckInWindows(parsed.checkInWindows),
    notes: normalizeText(parsed.notes),
    templateOverrides: normalizeTemplateOverrides(parsed.templateOverrides),
    updatedAt: Number.isFinite(parsed.updatedAt) ? (parsed.updatedAt as number) : Date.now(),
  };
}

function parsePlans(raw: string | null): CommsPlan[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((plan) => normalizePlan(plan))
      .filter((plan): plan is CommsPlan => Boolean(plan))
      .sort((a, b) => a.placeId.localeCompare(b.placeId));
  } catch {
    return [];
  }
}

function persistPlans(storage: CommsPlanStorageLike | null, plans: CommsPlan[]): void {
  if (!storage) return;
  if (plans.length === 0) {
    storage.removeItem?.(STORAGE_KEY);
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(plans));
}

function emitPlans(plans: CommsPlan[]): void {
  if (typeof document === 'undefined' || typeof CustomEvent === 'undefined') return;
  document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: clonePlans(plans) }));
}

function nextUpdatedAt(plans: CommsPlan[]): number {
  const now = Date.now();
  const latest = plans.reduce((max, plan) => Math.max(max, plan.updatedAt), 0);
  return now > latest ? now : latest + 1;
}

function buildDefaultFallbackSteps(place: SavedPlace): FallbackStep[] {
  const homeLike = place.tags.includes('home') || place.tags.includes('family');
  const travelLike = place.tags.includes('travel') || place.tags.includes('bugout');
  return [
    {
      id: 'signal-thread',
      label: homeLike ? 'Family Signal / SMS thread' : 'Primary Signal / SMS thread',
      kind: 'signal',
      instruction: homeLike
        ? 'Post to the family thread first and include your current status.'
        : 'Post to the primary Signal or SMS thread first.',
      priority: 1,
    },
    {
      id: 'voice-call',
      label: 'Voice call backup',
      kind: 'call',
      instruction: 'Call the primary contact and leave a voicemail if they do not answer.',
      priority: 2,
    },
    {
      id: travelLike ? 'rally' : 'gmrs',
      label: travelLike ? 'Fallback rally point' : 'GMRS / FRS channel 3',
      kind: travelLike ? 'rally' : 'radio',
      instruction: travelLike
        ? `Use the pre-planned rally point for ${place.name} if digital channels fail.`
        : 'Switch to radio channel 3 after 10 minutes without response.',
      priority: 3,
    },
  ];
}

function buildDefaultCheckInWindows(place: SavedPlace): CheckInWindow[] {
  return [
    {
      id: 'moving-window',
      label: 'Every 30 minutes while moving',
      cadenceMinutes: 30,
      note: `Use while transiting to or from ${place.name}.`,
    },
    {
      id: 'degraded-window',
      label: 'Top of the hour if networks degrade',
      cadenceMinutes: 60,
      note: 'Use radio or satcom if messaging does not get through.',
    },
  ];
}

function buildTemplates(place: SavedPlace, plan: CommsPlan): Record<CommsStatus, CommsTemplate> {
  const overrides = plan.templateOverrides;
  return {
    safe: {
      status: 'safe',
      label: COMMS_STATUS_LABELS.safe,
      lead: overrides.safe ?? `I am safe at ${place.name}.`,
      action: 'No immediate action needed. I will send another update if my status changes.',
    },
    moving: {
      status: 'moving',
      label: COMMS_STATUS_LABELS.moving,
      lead: overrides.moving ?? `I am moving from ${place.name} now.`,
      action: 'Track this as an active movement update and expect another check-in on the next window.',
    },
    stuck: {
      status: 'stuck',
      label: COMMS_STATUS_LABELS.stuck,
      lead: overrides.stuck ?? `I am delayed or stuck near ${place.name}.`,
      action: 'If you do not hear from me on the next check-in window, start the fallback ladder.',
    },
    need_pickup: {
      status: 'need_pickup',
      label: COMMS_STATUS_LABELS.need_pickup,
      lead: overrides.need_pickup ?? `I need pickup support from ${place.name}.`,
      action: 'Reply with ETA, vehicle, and the safest approach route you can use.',
    },
    need_meds: {
      status: 'need_meds',
      label: COMMS_STATUS_LABELS.need_meds,
      lead: overrides.need_meds ?? `I need medication support near ${place.name}.`,
      action: 'Reply with the medication source, ETA, and whether you need an alternate handoff point.',
    },
  };
}

export function getResolvedCommsPlan(place: SavedPlace, plan?: Partial<CommsPlan> | null): ResolvedCommsPlan {
  const resolvedPlaceId = normalizeText(plan?.placeId);
  const normalized = plan
    ? normalizePlan({
        ...plan,
        placeId: resolvedPlaceId === '' ? place.id : resolvedPlaceId,
      })
    : null;
  const base: CommsPlan = normalized
    ? {
        ...clonePlan(normalized),
        fallbackSteps: normalized.fallbackSteps.length > 0 ? normalized.fallbackSteps.map((step) => cloneFallbackStep(step)) : buildDefaultFallbackSteps(place),
        checkInWindows: normalized.checkInWindows.length > 0 ? normalized.checkInWindows.map((window) => cloneCheckInWindow(window)) : buildDefaultCheckInWindows(place),
      }
    : {
        placeId: place.id,
        contacts: [],
        fallbackSteps: buildDefaultFallbackSteps(place),
        checkInWindows: buildDefaultCheckInWindows(place),
        notes: normalizeText(place.notes),
        templateOverrides: {},
        updatedAt: place.updatedAt,
      };

  return {
    ...base,
    templates: buildTemplates(place, base),
  };
}

function formatTimestamp(now: Date): string {
  return `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function buildCommsMessage({
  status,
  place,
  plan,
  now = new Date(),
}: {
  status: CommsStatus;
  place: SavedPlace;
  plan?: Partial<CommsPlan> | ResolvedCommsPlan | null;
  now?: Date;
}): string {
  const resolved = getResolvedCommsPlan(place, plan ?? null);
  const template = resolved.templates[status];
  const primaryChannel = resolved.fallbackSteps[0]?.label ?? 'Primary Signal / SMS thread';
  const fallbackSummary = resolved.fallbackSteps
    .slice(0, 2)
    .map((step) => step.label)
    .join(' -> ');
  const nextWindow = resolved.checkInWindows[0]?.label ?? 'Next available window';

  return [
    `Status: ${template.label}`,
    `Place: ${place.name}`,
    `Time: ${formatTimestamp(now)}`,
    '',
    template.lead,
    template.action,
    `Primary channel: ${primaryChannel}`,
    `Fallback: ${fallbackSummary}`,
    `Check-in: ${nextWindow}`,
    resolved.notes ? `Plan notes: ${resolved.notes}` : '',
  ].filter(Boolean).join('\n');
}

export function createCommsPlanStore(storage: CommsPlanStorageLike | null = defaultStorage()) {
  let cache = parsePlans(storage?.getItem(STORAGE_KEY) ?? null);
  const listeners = new Set<(plans: CommsPlan[]) => void>();

  const notify = () => {
    const snapshot = clonePlans(cache);
    listeners.forEach((listener) => listener(snapshot));
    emitPlans(snapshot);
  };

  const persist = () => {
    cache = clonePlans(cache).sort((a, b) => a.placeId.localeCompare(b.placeId));
    persistPlans(storage, cache);
  };

  return {
    getPlans(): CommsPlan[] {
      return clonePlans(cache);
    },
    getPlan(placeId: string): CommsPlan | null {
      const plan = cache.find((entry) => entry.placeId === placeId);
      return plan ? clonePlan(plan) : null;
    },
    upsertPlan(input: CommsPlanInput): CommsPlan {
      const placeId = normalizeText(input.placeId);
      if (!placeId) throw new Error('placeId is required');
      const updatedAt = nextUpdatedAt(cache);
      const existing = cache.find((plan) => plan.placeId === placeId);
      const plan: CommsPlan = {
        placeId,
        contacts: input.contacts ? normalizeContacts(input.contacts) : existing?.contacts ?? [],
        fallbackSteps: input.fallbackSteps ? normalizeFallbackSteps(input.fallbackSteps) : existing?.fallbackSteps ?? [],
        checkInWindows: input.checkInWindows ? normalizeCheckInWindows(input.checkInWindows) : existing?.checkInWindows ?? [],
        notes: input.notes == undefined ? (existing?.notes ?? '') : normalizeText(input.notes),
        templateOverrides: input.templateOverrides == undefined
          ? (existing?.templateOverrides ?? {})
          : normalizeTemplateOverrides(input.templateOverrides),
        updatedAt,
      };
      cache = [...cache.filter((entry) => entry.placeId !== placeId), plan];
      persist();
      notify();
      return clonePlan(plan);
    },
    removePlan(placeId: string): CommsPlan[] {
      cache = cache.filter((plan) => plan.placeId !== placeId);
      persistPlans(storage, cache);
      notify();
      return clonePlans(cache);
    },
    exportPlans(): string {
      return JSON.stringify(cache, null, 2);
    },
    importPlans(raw: string): CommsPlan[] {
      cache = parsePlans(raw);
      persist();
      notify();
      return clonePlans(cache);
    },
    subscribe(listener: (plans: CommsPlan[]) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const singletonStore = createCommsPlanStore();

export function getCommsPlans(): CommsPlan[] {
  return singletonStore.getPlans();
}

export function getCommsPlan(placeId: string): CommsPlan | null {
  return singletonStore.getPlan(placeId);
}

export function upsertCommsPlan(input: CommsPlanInput): CommsPlan {
  return singletonStore.upsertPlan(input);
}

export function removeCommsPlan(placeId: string): CommsPlan[] {
  return singletonStore.removePlan(placeId);
}

export function exportCommsPlans(): string {
  return singletonStore.exportPlans();
}

export function importCommsPlans(raw: string): CommsPlan[] {
  return singletonStore.importPlans(raw);
}

export function subscribeCommsPlans(listener: (plans: CommsPlan[]) => void): () => void {
  return singletonStore.subscribe(listener);
}

export function buildPrimaryCommsMessage(status: CommsStatus, now = new Date()): string {
  const place = getPrimarySavedPlace();
  if (!place) {
    return [
      `Status: ${COMMS_STATUS_LABELS[status]}`,
      `Time: ${formatTimestamp(now)}`,
      '',
      'I am checking in.',
      'Save a place in World Monitor to personalize this message.',
    ].join('\n');
  }
  return buildCommsMessage({
    status,
    place,
    plan: getCommsPlan(place.id),
    now,
  });
}
