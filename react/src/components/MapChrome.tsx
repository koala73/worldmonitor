'use client';

import { useEffect, useState } from 'react';
import { FitToScreen, Minimize } from '@carbon/icons-react';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';

export type MapDimension = '2d' | '3d';

function formatUtcClock(now: Date): string {
  return now.toUTCString().replace('GMT', 'UTC');
}

/** 2D / 3D + fullscreen — sits left of Feeds in the chrome-right cluster. */
export function MapChromeActions({
  dimension,
  onDimensionChange,
  fullscreen,
  onFullscreenChange,
}: {
  dimension: MapDimension;
  onDimensionChange: (next: MapDimension) => void;
  fullscreen: boolean;
  onFullscreenChange: (next: boolean) => void;
}) {
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFullscreenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen, onFullscreenChange]);

  return (
    <div className="wm-react-map-chrome-actions">
      <SegmentedControl
        label="Map dimension"
        size="sm"
        value={dimension}
        onChange={(v: string) => onDimensionChange(v === '3d' ? '3d' : '2d')}
      >
        <SegmentedControlItem value="2d" label="2D" />
        <SegmentedControlItem value="3d" label="3D" />
      </SegmentedControl>
      <IconButton
        label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        tooltip={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        icon={
          <Icon
            icon={fullscreen ? Minimize : FitToScreen}
            size="sm"
          />
        }
        variant="ghost"
        size="sm"
        onClick={() => onFullscreenChange(!fullscreen)}
      />
    </div>
  );
}

/**
 * Same chrome strip as vanilla :3030 map panel header:
 * title · UTC clock (2D/3D + fullscreen live left of Feeds).
 */
export function MapChrome() {
  const [clock, setClock] = useState(() => formatUtcClock(new Date()));

  useEffect(() => {
    const tick = () => setClock(formatUtcClock(new Date()));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="wm-react-map-chrome" role="toolbar" aria-label="Map chrome">
      <div className="wm-react-map-chrome-left">
        <span className="wm-react-map-chrome-title">Map</span>
      </div>
      <time className="wm-react-map-chrome-clock" dateTime={new Date().toISOString()} translate="no">
        {clock}
      </time>
      {/* Spacer so the clock stays centered while actions sit in .wm-map-end-controls */}
      <div className="wm-react-map-chrome-actions" aria-hidden />
    </div>
  );
}
