export type ResponsiveZoneListener = { cancel(): void };

type ResponsiveZoneTarget = Pick<Window, 'matchMedia'>;

export function addResponsiveZoneListener(
  target: ResponsiveZoneTarget,
  minWidthPx: number,
  onZoneChange: () => void,
): ResponsiveZoneListener {
  const media = target.matchMedia(`(min-width: ${minWidthPx}px)`);
  const onMediaChange = () => onZoneChange();

  media.addEventListener('change', onMediaChange);

  return {
    cancel() {
      media.removeEventListener('change', onMediaChange);
    },
  };
}

export function removeResponsiveZoneListener(listener: ResponsiveZoneListener | null): void {
  listener?.cancel();
}
