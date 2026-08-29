/**
 * Lazily create the shared white contact pip used by aircraft layers while the
 * first-person cockpit is active. Cesium multiplies this white texture by the
 * billboard color, so civilian and military owners retain their provenance
 * colors without maintaining separate image assets.
 *
 * @returns {string} One stable data-URL identity shared by every billboard.
 */
export function cockpitContactDotImage() {
  if (cockpitContactDotImage._dataUrl) return cockpitContactDotImage._dataUrl;

  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 16, 16);

  // Match the visor's fine-line symbology: a restrained luminous ring with a
  // crisp center fix, rather than a solid map-marker blob. The layer tint
  // supplies civilian cyan-white or military amber provenance.
  ctx.save();
  ctx.shadowBlur = 2.5;
  ctx.shadowColor = 'rgba(255, 255, 255, 0.55)';
  ctx.beginPath();
  ctx.arc(8, 8, 4.25, 0, Math.PI * 2);
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.stroke();
  ctx.shadowBlur = 1.5;
  ctx.beginPath();
  ctx.arc(8, 8, 1.55, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
  ctx.fill();
  ctx.restore();

  // Billboard.image assigns a fresh texture-atlas id to non-string sources.
  // Returning the same canvas for hundreds of contacts therefore still made
  // Cesium upload/repack hundreds of identical textures at cockpit entry.
  // A stable URL is keyed once and shared by the entire fleet.
  cockpitContactDotImage._dataUrl = canvas.toDataURL('image/png');
  return cockpitContactDotImage._dataUrl;
}

cockpitContactDotImage._dataUrl = null;
