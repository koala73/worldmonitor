import { hasNoDataAtPoint, type CropPosition } from './archive-gibs';

const NO_DATA_SAMPLE_PX = 32;

/** Whether a loaded archive frame has no data around the point. Unreadable pixels count as data, so a failed check never hides a real image. */
export function noDataAtPoint(img: HTMLImageElement, at: CropPosition): boolean {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = NO_DATA_SAMPLE_PX;
    canvas.height = NO_DATA_SAMPLE_PX;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, NO_DATA_SAMPLE_PX, NO_DATA_SAMPLE_PX);
    return hasNoDataAtPoint(ctx.getImageData(0, 0, NO_DATA_SAMPLE_PX, NO_DATA_SAMPLE_PX).data, NO_DATA_SAMPLE_PX, NO_DATA_SAMPLE_PX, at);
  } catch {
    return false;
  }
}
