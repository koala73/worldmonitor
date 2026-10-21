import type { PanelConfig } from '@/types';
import { userSetPanelEnabled } from '@/config/panels';
import { STORAGE_KEYS } from '@/config/variants/base';

type StorageWriter = (key: string, value: string) => boolean | void;
type PersistenceStep = () => boolean | void;

export interface GateOwnershipPersistenceResult {
  preferencePersisted: boolean;
  ownershipPersisted: boolean;
  complete: boolean;
}

function runPersistenceStep(step: PersistenceStep): boolean {
  try {
    return step() !== false;
  } catch {
    return false;
  }
}

/**
 * Persist a preference and its gate-ownership sidecar in the only safe order.
 * Free enforcement records ownership before a destructive preference write;
 * Pro restoration records the restored preference before consuming ownership.
 */
export function persistGateOwnershipTransition(
  mode: 'free' | 'pro',
  persistPreference: PersistenceStep,
  persistOwnership: PersistenceStep,
): GateOwnershipPersistenceResult {
  if (mode === 'free') {
    const ownershipPersisted = runPersistenceStep(persistOwnership);
    if (!ownershipPersisted) {
      return { preferencePersisted: false, ownershipPersisted, complete: false };
    }
    const preferencePersisted = runPersistenceStep(persistPreference);
    return {
      preferencePersisted,
      ownershipPersisted,
      complete: preferencePersisted,
    };
  }

  const preferencePersisted = runPersistenceStep(persistPreference);
  if (!preferencePersisted) {
    return { preferencePersisted, ownershipPersisted: false, complete: false };
  }
  const ownershipPersisted = runPersistenceStep(persistOwnership);
  return {
    preferencePersisted,
    ownershipPersisted,
    complete: ownershipPersisted,
  };
}

interface ResolveAppliedPanelLayoutVariantOptions {
  appliedVariant: string | null;
  legacyVariant: string | null;
  currentVariant: string;
  validVariants: ReadonlySet<string>;
  persistAppliedVariant: (variant: string) => boolean | void;
}

/**
 * Prefer the crash-safe applied-layout marker, but preserve legacy profiles
 * that pre-date it. A stable legacy profile seeds the marker without making a
 * destructive variant transition; a staged switch keeps the existing marker
 * and is therefore still detected on the next boot.
 */
export function resolveAppliedPanelLayoutVariant(
  options: ResolveAppliedPanelLayoutVariantOptions,
): string | null {
  if (options.appliedVariant !== null) return options.appliedVariant;
  if (
    options.legacyVariant === null
    || !options.validVariants.has(options.legacyVariant)
  ) return null;

  if (options.legacyVariant === options.currentVariant) {
    try {
      options.persistAppliedVariant(options.currentVariant);
    } catch {
      // The valid legacy identity remains safe for this session. A future boot
      // can retry seeding the crash-safe marker.
    }
  }
  return options.legacyVariant;
}

/** Stage a same-origin desktop/local switch without erasing the old layout identity. */
export function stageVariantSelection(
  currentVariant: string,
  nextVariant: string,
  write: StorageWriter,
): boolean {
  if (write(STORAGE_KEYS.panelLayoutVariant, currentVariant) === false) return false;
  return write(STORAGE_KEYS.variant, nextVariant) !== false;
}

interface ApplyVariantPanelLayoutTransitionOptions {
  currentVariant: string;
  panelSettings: Record<string, PanelConfig>;
  variantPanelKeys: ReadonlySet<string>;
  isDynamicPanel: (key: string) => boolean;
  getDefaultPanel: (key: string) => PanelConfig;
  persistPanels: (panels: Record<string, PanelConfig>) => void;
  persistAppliedVariant: (variant: string) => void;
}

/**
 * Transfer ownership of cross-variant disables and persist them before the
 * applied-layout marker advances. A crash can therefore retry the reset; it
 * can never claim an unapplied layout is current.
 */
export function applyVariantPanelLayoutTransition(
  options: ApplyVariantPanelLayoutTransitionOptions,
): Record<string, PanelConfig> {
  const next = Object.fromEntries(
    Object.entries(options.panelSettings).map(([key, config]) => [key, { ...config }]),
  );

  for (const [key, config] of Object.entries(next)) {
    if (!options.variantPanelKeys.has(key) && !options.isDynamicPanel(key)) {
      userSetPanelEnabled(config, false);
    }
  }
  for (const key of options.variantPanelKeys) {
    if (!(key in next)) next[key] = { ...options.getDefaultPanel(key) };
  }

  try {
    options.persistPanels(next);
    options.persistAppliedVariant(options.currentVariant);
  } catch {
    // The in-memory reset is still safe to use for this session. Leaving the
    // applied marker unchanged makes the durable transition retry next boot.
  }
  return next;
}
