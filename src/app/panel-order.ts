export interface DefaultPanelOrderOptions {
  variant: string;
  variantDefaults: Record<string, string[]>;
  isDesktopApp?: boolean;
}

export function resolveDefaultPanelOrder(
  activePanelKeys: string[],
  options: DefaultPanelOrderOptions,
): string[] {
  const variantOrder = (options.variantDefaults[options.variant] ?? options.variantDefaults['full'] ?? []).filter(k => k !== 'map');
  const activePanelSet = new Set(activePanelKeys.filter(k => k !== 'map'));
  const ordered = [
    ...variantOrder.filter(k => activePanelSet.has(k)),
    ...activePanelKeys.filter(k => k !== 'map' && !variantOrder.includes(k)),
  ];

  if (options.variant !== 'happy') {
    const liveNewsIdx = ordered.indexOf('live-news');
    if (liveNewsIdx > 0) {
      ordered.splice(liveNewsIdx, 1);
      ordered.unshift('live-news');
    }

    const webcamsIdx = ordered.indexOf('live-webcams');
    if (webcamsIdx !== -1 && webcamsIdx !== ordered.indexOf('live-news') + 1) {
      ordered.splice(webcamsIdx, 1);
      const afterNews = ordered.indexOf('live-news') + 1;
      ordered.splice(afterNews, 0, 'live-webcams');
    }
  }

  if (options.isDesktopApp) {
    const runtimeIdx = ordered.indexOf('runtime-config');
    if (runtimeIdx > 1) {
      ordered.splice(runtimeIdx, 1);
      ordered.splice(1, 0, 'runtime-config');
    } else if (runtimeIdx === -1 && activePanelSet.has('runtime-config')) {
      ordered.splice(1, 0, 'runtime-config');
    }
  }

  return ordered;
}

export interface SavedPanelOrderOptions {
  variant: string;
}

export function resolveSavedPanelOrder(
  activePanelKeys: string[],
  savedOrder: string[],
  defaultOrder: string[],
  options: SavedPanelOrderOptions,
): string[] {
  const activePanelSet = new Set(activePanelKeys.filter(k => k !== 'map'));
  const valid = savedOrder.filter(k => activePanelSet.has(k));
  const missing = activePanelKeys.filter(k => k !== 'map' && !valid.includes(k));

  missing.forEach(k => {
    if (k === 'monitors') return;
    const defaultIdx = defaultOrder.indexOf(k);
    if (defaultIdx === -1) {
      valid.push(k);
      return;
    }
    let inserted = false;
    for (let i = defaultIdx + 1; i < defaultOrder.length; i++) {
      const afterIdx = valid.indexOf(defaultOrder[i]!);
      if (afterIdx !== -1) {
        valid.splice(afterIdx, 0, k);
        inserted = true;
        break;
      }
    }
    if (!inserted) valid.push(k);
  });

  const monitorsIdx = valid.indexOf('monitors');
  if (monitorsIdx !== -1) valid.splice(monitorsIdx, 1);
  if (options.variant !== 'happy' && activePanelSet.has('monitors')) {
    valid.push('monitors');
  }

  return valid;
}
