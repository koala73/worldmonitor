import type { StoryData } from '@/services/story-data';
import { renderStoryToCanvas } from '@/services/story-renderer';
import { generateStoryDeepLink, getShareUrls, shareTexts } from '@/services/story-share';
import { t } from '@/services/i18n';

let modalEl: HTMLElement | null = null;
let currentDataUrl: string | null = null;
let currentBlob: Blob | null = null;
let currentData: StoryData | null = null;

export function openStoryModal(data: StoryData): void {
  closeStoryModal();
  currentData = data;

  modalEl = document.createElement('div');
  modalEl.className = 'story-modal-overlay';
  modalEl.innerHTML = `
    <div class="story-modal">
      <button class="story-close-x" aria-label="${t('modals.story.close')}">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <div class="story-modal-content">
        <div class="story-loading">
          <div class="story-spinner"></div>
          <span>${t('modals.story.generating')}</span>
        </div>
      </div>
      <div class="story-share-bar" style="display:none">
        <button class="story-share-btn story-save" title="${t('modals.story.save')}">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>${t('modals.story.save')}</span>
        </button>
        <button class="story-share-btn story-whatsapp" title="${t('modals.story.whatsapp')}">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z"/></svg>
          <span>${t('modals.story.whatsapp')}</span>
        </button>
        <button class="story-share-btn story-twitter" title="${t('modals.story.twitter')}">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          <span>${t('modals.story.twitter')}</span>
        </button>
        <button class="story-share-btn story-linkedin" title="${t('modals.story.linkedin')}">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
          <span>${t('modals.story.linkedin')}</span>
        </button>
        <button class="story-share-btn story-copy" title="${t('modals.story.copyLink')}">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          <span>${t('modals.story.copyLink')}</span>
        </button>
      </div>
    </div>
  `;

  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeStoryModal();
  });
  modalEl.querySelector('.story-close-x')?.addEventListener('click', closeStoryModal);
  modalEl.querySelector('.story-save')?.addEventListener('click', downloadStory);
  modalEl.querySelector('.story-whatsapp')?.addEventListener('click', () => currentData && shareWhatsApp(currentData));
  modalEl.querySelector('.story-twitter')?.addEventListener('click', () => currentData && shareTwitter(currentData));
  modalEl.querySelector('.story-linkedin')?.addEventListener('click', () => currentData && shareLinkedIn(currentData));
  modalEl.querySelector('.story-copy')?.addEventListener('click', () => currentData && copyDeepLink(currentData));

  document.body.appendChild(modalEl);

  requestAnimationFrame(async () => {
    if (!modalEl) return;
    try {
      await renderAndDisplay(data);
    } catch (err) {
      console.error('[StoryModal] Render error:', err);
      const content = modalEl?.querySelector('.story-modal-content');
      if (content) content.innerHTML = `<div class="story-error">${t('modals.story.error')}</div>`;
    }
  });
}

async function renderAndDisplay(data: StoryData): Promise<void> {
  const canvas = await renderStoryToCanvas(data);
  currentDataUrl = canvas.toDataURL('image/png');

  const binStr = atob(currentDataUrl.split(',')[1] ?? '');
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  currentBlob = new Blob([bytes], { type: 'image/png' });

  const content = modalEl?.querySelector('.story-modal-content');
  if (content) {
    content.innerHTML = '';
    const img = document.createElement('img');
    img.className = 'story-image';
    img.src = currentDataUrl;
    img.alt = `${data.countryName} Intelligence Story`;
    content.appendChild(img);
  }

  const shareBar = modalEl?.querySelector('.story-share-bar') as HTMLElement;
  if (shareBar) shareBar.style.display = 'flex';
}

export function closeStoryModal(): void {
  if (modalEl) {
    modalEl.remove();
    modalEl = null;
    currentDataUrl = null;
    currentBlob = null;
    currentData = null;
  }
}

function downloadStory(): void {
  if (!currentDataUrl) return;
  const a = document.createElement('a');
  a.href = currentDataUrl;
  a.download = `worldmonitor-${currentData?.countryCode.toLowerCase() || 'story'}-${Date.now()}.png`;
  a.click();
  flashButton('.story-save', t('modals.story.saved'), t('modals.story.save'));
}

async function shareWhatsApp(data: StoryData): Promise<void> {
  if (!currentBlob) {
    downloadStory();
    return;
  }

  const file = new File([currentBlob], `${data.countryCode.toLowerCase()}-worldmonitor.png`, { type: 'image/png' });
  const urls = getShareUrls(data);

  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        text: shareTexts.whatsapp(data).replace('\n\n', '\n'),
        files: [file]
      });
      return;
    } catch { /* user cancelled */ }
  }

  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': currentBlob }),
    ]);
    flashButton('.story-whatsapp', t('modals.story.copied'), t('modals.story.whatsapp'));
  } catch {
    downloadStory();
    flashButton('.story-whatsapp', t('modals.story.saved'), t('modals.story.whatsapp'));
  }
  window.open(urls.whatsapp, '_blank');
}

async function shareTwitter(data: StoryData): Promise<void> {
  const urls = getShareUrls(data);
  window.open(urls.twitter, '_blank');
  flashButton('.story-twitter', t('modals.story.opening'), t('modals.story.twitter'));
}

async function shareLinkedIn(data: StoryData): Promise<void> {
  const urls = getShareUrls(data);
  window.open(urls.linkedin, '_blank');
  flashButton('.story-linkedin', t('modals.story.opening'), t('modals.story.linkedin'));
}

async function copyDeepLink(data: StoryData): Promise<void> {
  const link = generateStoryDeepLink(data.countryCode);
  await navigator.clipboard.writeText(link);
  flashButton('.story-copy', t('modals.story.copied'), t('modals.story.copyLink'));
}

function flashButton(selector: string, flashText: string, originalText: string): void {
  const btn = modalEl?.querySelector(selector) as HTMLButtonElement;
  if (!btn) return;
  const span = btn.querySelector('span');
  if (span) {
    span.textContent = flashText;
    setTimeout(() => { if (span) span.textContent = originalText; }, 2500);
  }
}
