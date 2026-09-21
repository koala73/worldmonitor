'use client';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';

import { listPrimaryOverlays } from '../lib/layers';
import {
  REACT_MISSIONS,
  type MissionPresetId,
  type ReactMission,
} from '../lib/missions';
import {
  TIME_RANGES,
  VIEW_VALUES,
  type LayerKey,
  type LayerMap,
  type MapView,
  type TimeRange,
} from '../lib/url-state';

const VIEW_LABELS: Record<MapView, string> = {
  global: 'Global',
  america: 'Americas',
  mena: 'MENA',
  eu: 'Europe',
  asia: 'Asia',
  latam: 'Latin America',
  africa: 'Africa',
  oceania: 'Oceania',
};

/**
 * IoR-style filter dropdowns: Missions, Location, Time, Overlays.
 * Renders inline for the floating map toolbar (no chrome strip).
 */
export function MapFilterBar({
  missionId,
  onMission,
  view,
  onView,
  timeRange,
  onTimeRange,
  layers,
  onToggleLayer,
  onMenuOpen,
}: {
  missionId: MissionPresetId | null;
  onMission: (mission: ReactMission) => void;
  view: MapView;
  onView: (view: MapView) => void;
  timeRange: TimeRange;
  onTimeRange: (range: TimeRange) => void;
  layers: LayerMap;
  onToggleLayer: (key: LayerKey, on: boolean) => void;
  /** Fired when any filter dropdown opens (e.g. close AI Footprint). */
  onMenuOpen?: () => void;
}) {
  const activeMission = REACT_MISSIONS.find((m) => m.id === missionId) ?? null;
  const overlays = listPrimaryOverlays();
  const activeKeys = overlays.filter((o) => layers[o.key]).map((o) => o.key);
  const allOff = activeKeys.length === 0;

  const clearOverlays = () => {
    for (const o of overlays) {
      if (layers[o.key]) onToggleLayer(o.key, false);
    }
  };

  const onOpenChange = (isOpen: boolean) => {
    if (isOpen) onMenuOpen?.();
  };

  return (
    <div className="wm-react-filter-bar" role="toolbar" aria-label="Map filters">
      <DropdownMenu
        hasChevron
        menuWidth={280}
        className="wm-react-filter-menu"
        style={{ maxHeight: 'none' }}
        onOpenChange={onOpenChange}
        button={{
          label: activeMission
            ? `Missions · ${activeMission.shortLabel}`
            : 'Missions',
          size: 'sm',
          variant: 'secondary',
        }}
      >
        {REACT_MISSIONS.map((m) => (
          <DropdownMenuItem
            key={m.id}
            label={`${m.shortLabel} — ${m.label}`}
            description={m.description}
            onClick={() => onMission(m)}
          />
        ))}
      </DropdownMenu>

      <DropdownMenu
        hasChevron
        menuWidth={220}
        className="wm-react-filter-menu"
        style={{ maxHeight: 'none' }}
        onOpenChange={onOpenChange}
        button={{
          label: `Location · ${VIEW_LABELS[view]}`,
          size: 'sm',
          variant: 'secondary',
        }}
      >
        {VIEW_VALUES.map((v) => (
          <DropdownMenuItem
            key={v}
            label={VIEW_LABELS[v]}
            onClick={() => onView(v)}
          />
        ))}
      </DropdownMenu>

      <DropdownMenu
        hasChevron
        menuWidth={160}
        className="wm-react-filter-menu"
        style={{ maxHeight: 'none' }}
        onOpenChange={onOpenChange}
        button={{
          label: `Time · ${timeRange}`,
          size: 'sm',
          variant: 'secondary',
        }}
      >
        {TIME_RANGES.map((range) => (
          <DropdownMenuItem
            key={range}
            label={range}
            onClick={() => onTimeRange(range)}
          />
        ))}
      </DropdownMenu>

      <DropdownMenu
        hasChevron
        menuWidth={260}
        className="wm-react-filter-menu"
        style={{ maxHeight: 'none' }}
        onOpenChange={onOpenChange}
        button={{
          label:
            activeKeys.length > 0
              ? `Overlays · ${activeKeys.length}`
              : 'Overlays · Off',
          size: 'sm',
          variant: 'secondary',
        }}
      >
        <DropdownMenuCheckboxItem
          label="Off"
          value={allOff}
          onChange={(on) => {
            if (on) clearOverlays();
          }}
        />
        {overlays.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.key}
            label={o.label}
            value={!!layers[o.key]}
            onChange={(on) => onToggleLayer(o.key, on)}
          />
        ))}
      </DropdownMenu>
    </div>
  );
}
