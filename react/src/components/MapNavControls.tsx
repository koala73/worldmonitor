'use client';

import { CenterToFit, ZoomIn, ZoomOut } from '@carbon/icons-react';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';

/**
 * Map zoom + recenter controls (Carbon icons), right edge of the map canvas.
 */
export function MapNavControls({
  onZoomIn,
  onZoomOut,
  onRecenter,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onRecenter: () => void;
}) {
  return (
    <div className="wm-map-nav-controls" role="toolbar" aria-label="Map navigation">
      <IconButton
        label="Zoom in"
        tooltip="Zoom in"
        size="sm"
        variant="secondary"
        icon={<Icon icon={ZoomIn} size="sm" />}
        onClick={onZoomIn}
      />
      <IconButton
        label="Zoom out"
        tooltip="Zoom out"
        size="sm"
        variant="secondary"
        icon={<Icon icon={ZoomOut} size="sm" />}
        onClick={onZoomOut}
      />
      <IconButton
        label="Recenter map"
        tooltip="Recenter map"
        size="sm"
        variant="secondary"
        icon={<Icon icon={CenterToFit} size="sm" />}
        onClick={onRecenter}
      />
    </div>
  );
}
