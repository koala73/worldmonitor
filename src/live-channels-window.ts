/**
 * Standalone channel management window (LIVE panel: add/remove/reorder channels).
 * Loaded when the app is opened with ?live-channels=1 (e.g. from "Manage channels" button).
 */
import type { LiveChannel } from '@/components/LiveNewsPanel';
import {
  loadChannelsFromStorage,
  saveChannelsToStorage,
  BUILTIN_IDS,
  getDefaultLiveChannels,
  OPTIONAL_LIVE_CHANNELS,
  OPTIONAL_CHANNEL_REGIONS,
} from '@/components/LiveNewsPanel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { isDesktopRuntime, getRemoteApiBaseUrl } from '@/services/runtime';

/** Builds a stable custom channel id from a YouTube handle (e.g. @Foo -> custom-foo). */
function customChannelIdFromHandle(handle: string): string {
  const normalized = handle
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return 'custom-' + normalized;
}

// Persist active region tab across re-renders
let activeRegionTab = OPTIONAL_CHANNEL_REGIONS[0]?.key ?? 'na';

// Build a lookup map: channel id → LiveChannel for optional channels
const optionalChannelMap = new Map<string, LiveChannel>();
for (const c of OPTIONAL_LIVE_CHANNELS) optionalChannelMap.set(c.id, c);

function channelInitials(name: string): string {
  return name.split(/[\s-]+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
}

export function initLiveChannelsWindow(containerEl?: HTMLElement): void {
  const appEl = containerEl ?? document.getElementById('app');
  if (!appEl) return;

  if (!containerEl) {
    document.title = `${t('components.liveNews.manage') ?? 'Channel management'} - World Monitor`;
  }

  let channels = loadChannelsFromStorage();
  let suppressRowClick = false;

  /** Reads current row order from DOM and persists to storage. */
  function applyOrderFromDom(listEl: HTMLElement): void {
    const rows = listEl.querySelectorAll<HTMLElement>('.live-news-manage-row');
    const ids = Array.from(rows).map((el) => el.dataset.channelId).filter((id): id is string => !!id);
    const map = new Map(channels.map((c) => [c.id, c]));
    channels = ids.map((id) => map.get(id)).filter((c): c is LiveChannel => !!c);
    saveChannelsToStorage(channels);
  }

  function setupListDnD(listEl: HTMLElement): void {
    let dragging: HTMLElement | null = null;
    let dragStarted = false;
    let startY = 0;
    const THRESHOLD = 6;

    listEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, button, textarea, select')) return;
      const row = target.closest('.live-news-manage-row') as HTMLElement | null;
      if (!row || row.classList.contains('live-news-manage-row-editing')) return;
      dragging = row;
      dragStarted = false;
      startY = e.clientY;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      if (!dragStarted) {
        if (Math.abs(e.clientY - startY) < THRESHOLD) return;
        dragStarted = true;
        dragging.classList.add('live-news-manage-row-dragging');
      }
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.live-news-manage-row') as HTMLElement | null;
      if (!target || target === dragging) return;
      const all = Array.from(listEl.querySelectorAll('.live-news-manage-row'));
      const idx = all.indexOf(dragging);
      const targetIdx = all.indexOf(target);
      if (idx === -1 || targetIdx === -1) return;
      if (idx < targetIdx) {
        target.parentElement?.insertBefore(dragging, target.nextSibling);
      } else {
        target.parentElement?.insertBefore(dragging, target);
      }
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      if (dragStarted) {
        dragging.classList.remove('live-news-manage-row-dragging');
        applyOrderFromDom(listEl);
        suppressRowClick = true;
        setTimeout(() => {
          suppressRowClick = false;
        }, 0);
      }
      dragging = null;
      dragStarted = false;
    });
  }

  function renderList(listEl: HTMLElement): void {
    listEl.innerHTML = '';
    for (const ch of channels) {
      const row = document.createElement('div');
      row.className = 'live-news-manage-row';
      row.dataset.channelId = ch.id;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'live-news-manage-row-name';
      nameSpan.textContent = ch.name ?? '';
      row.appendChild(nameSpan);

      row.addEventListener('click', (e) => {
        // Suppress click immediately after drag-drop to avoid accidental edit open.
        if (suppressRowClick || row.classList.contains('live-news-manage-row-dragging')) return;
        if ((e.target as HTMLElement).closest('input, button, textarea, select')) return;
        e.preventDefault();
        showEditForm(row, ch, listEl);
      });

      listEl.appendChild(row);
    }
    updateRestoreButton();
    renderAvailableChannels(listEl);
  }

  /** Returns default (built-in) channels that are not in the current list. */
  function getMissingDefaultChannels(): LiveChannel[] {
    const currentIds = new Set(channels.map((c) => c.id));
    return getDefaultLiveChannels().filter((c) => !currentIds.has(c.id));
  }

  function updateRestoreButton(): void {
    const btn = document.getElementById('liveChannelsRestoreBtn');
    if (!btn) return;
    const missing = getMissingDefaultChannels();
    (btn as HTMLButtonElement).style.display = missing.length > 0 ? '' : 'none';
  }

  /**
   * Applies edit form state to channels and returns the new array, or null if nothing to save.
   * Used by the Save button in the edit form.
   */
  function applyEditFormToChannels(
    currentCh: LiveChannel,
    formRow: HTMLElement,
    isCustom: boolean,
    displayName: string,
  ): LiveChannel[] | null {
    const idx = channels.findIndex((c) => c.id === currentCh.id);
    if (idx === -1) return null;

    if (isCustom) {
      const handleRaw = (formRow.querySelector('.live-news-manage-edit-handle') as HTMLInputElement | null)?.value?.trim();
      if (handleRaw) {
        const handle = handleRaw.startsWith('@') ? handleRaw : `@${handleRaw}`;
        const newId = customChannelIdFromHandle(handle);
        const existing = channels.find((c) => c.id === newId && c.id !== currentCh.id);
        if (existing) return null;
        const next = channels.slice();
        next[idx] = { ...currentCh, id: newId, handle, name: displayName };
        return next;
      }
    }
    const next = channels.slice();
    next[idx] = { ...currentCh, name: displayName };
    return next;
  }

  function showEditForm(row: HTMLElement, ch: LiveChannel, listEl: HTMLElement): void {
    const isCustom = !BUILTIN_IDS.has(ch.id);
    row.innerHTML = '';
    row.className = 'live-news-manage-row live-news-manage-row-editing';

    if (isCustom) {
      const handleInput = document.createElement('input');
      handleInput.type = 'text';
      handleInput.className = 'live-news-manage-edit-handle';
      handleInput.value = ch.handle;
      handleInput.placeholder = t('components.liveNews.youtubeHandle') ?? 'YouTube handle';
      row.appendChild(handleInput);
    }

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'live-news-manage-edit-name';
    nameInput.value = ch.name ?? '';
    nameInput.placeholder = t('components.liveNews.displayName') ?? 'Display name';
    row.appendChild(nameInput);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'live-news-manage-remove live-news-manage-remove-in-form';
    removeBtn.textContent = t('components.liveNews.remove') ?? 'Remove';
    removeBtn.addEventListener('click', () => {
      channels = channels.filter((c) => c.id !== ch.id);
      saveChannelsToStorage(channels);
      renderList(listEl);
    });
    row.appendChild(removeBtn);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'live-news-manage-save';
    saveBtn.textContent = t('components.liveNews.save') ?? 'Save';
    saveBtn.addEventListener('click', () => {
      const displayName = nameInput.value.trim() || ch.name || ch.handle;
      const next = applyEditFormToChannels(ch, row, isCustom, displayName);
      if (next) {
        channels = next;
        saveChannelsToStorage(channels);
      }
      renderList(listEl);
    });
    row.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'live-news-manage-cancel';
    cancelBtn.textContent = t('components.liveNews.cancel') ?? 'Cancel';
    cancelBtn.addEventListener('click', () => {
      renderList(listEl);
    });
    row.appendChild(cancelBtn);
  }

  // ── Available Channels: Tab-based region cards ──

  function renderAvailableChannels(listEl: HTMLElement): void {
    const tabBar = document.getElementById('liveChannelsTabBar');
    const tabContents = document.getElementById('liveChannelsTabContents');
    if (!tabBar || !tabContents) return;

    const currentIds = new Set(channels.map((c) => c.id));

    // Render tab buttons
    tabBar.innerHTML = '';
    for (const region of OPTIONAL_CHANNEL_REGIONS) {
      const addedCount = region.channelIds.filter((id) => currentIds.has(id)).length;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'live-news-manage-tab-btn' + (region.key === activeRegionTab ? ' active' : '');
      const label = t(region.labelKey) ?? region.key.toUpperCase();
      btn.textContent = addedCount > 0 ? `${label} (${addedCount})` : label;
      btn.addEventListener('click', () => {
        activeRegionTab = region.key;
        renderAvailableChannels(listEl);
      });
      tabBar.appendChild(btn);
    }

    // Render tab content panels
    tabContents.innerHTML = '';
    for (const region of OPTIONAL_CHANNEL_REGIONS) {
      const panel = document.createElement('div');
      panel.className = 'live-news-manage-tab-content' + (region.key === activeRegionTab ? ' active' : '');

      const grid = document.createElement('div');
      grid.className = 'live-news-manage-card-grid';

      for (const chId of region.channelIds) {
        const ch = optionalChannelMap.get(chId);
        if (!ch) continue;
        const isAdded = currentIds.has(chId);
        grid.appendChild(createCard(ch, isAdded, listEl));
      }

      panel.appendChild(grid);
      tabContents.appendChild(panel);
    }
  }

  function createCard(ch: LiveChannel, isAdded: boolean, listEl: HTMLElement): HTMLElement {
    const card = document.createElement('div');
    card.className = 'live-news-manage-card' + (isAdded ? ' added' : '');

    const icon = document.createElement('div');
    icon.className = 'live-news-manage-card-icon';
    icon.textContent = channelInitials(ch.name);

    const info = document.createElement('div');
    info.className = 'live-news-manage-card-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'live-news-manage-card-name';
    nameEl.textContent = ch.name;
    const handleEl = document.createElement('span');
    handleEl.className = 'live-news-manage-card-handle';
    handleEl.textContent = ch.handle;
    info.appendChild(nameEl);
    info.appendChild(handleEl);

    const action = document.createElement('span');
    action.className = 'live-news-manage-card-action';
    action.textContent = isAdded ? '✓' : '+';

    card.appendChild(icon);
    card.appendChild(info);
    card.appendChild(action);

    if (!isAdded) {
      card.addEventListener('click', () => {
        if (channels.some((c) => c.id === ch.id)) return;
        channels.push({ ...ch });
        saveChannelsToStorage(channels);
        renderList(listEl);
      });
    }
    return card;
  }

  // ── Render shell ──

  appEl.innerHTML = `
    <div class="live-channels-window-shell">
      <div class="live-channels-window-header">
        <span class="live-channels-window-title">${escapeHtml(t('components.liveNews.manage') ?? 'Channel management')}</span>
      </div>
      <div class="live-channels-window-content">
        <div class="live-channels-window-toolbar">
          <button type="button" class="live-news-manage-restore-defaults" id="liveChannelsRestoreBtn" style="display: none;">${escapeHtml(t('components.liveNews.restoreDefaults') ?? 'Restore default channels')}</button>
        </div>
        <div class="live-news-manage-list" id="liveChannelsList"></div>
        <div class="live-news-manage-available-section">
          <span class="live-news-manage-add-title">${escapeHtml(t('components.liveNews.availableChannels') ?? 'Available channels')}</span>
          <div class="live-news-manage-tab-bar" id="liveChannelsTabBar"></div>
          <div class="live-news-manage-tab-contents" id="liveChannelsTabContents"></div>
        </div>
        <div class="live-news-manage-add-section">
          <span class="live-news-manage-add-title">${escapeHtml(t('components.liveNews.customChannel') ?? 'Custom channel')}</span>
          <div class="live-news-manage-add">
            <div class="live-news-manage-add-field">
              <label class="live-news-manage-add-label" for="liveChannelsHandle">${escapeHtml(t('components.liveNews.youtubeHandle') ?? 'YouTube handle (e.g. @Channel)')}</label>
              <input type="text" class="live-news-manage-handle" id="liveChannelsHandle" placeholder="@Channel" />
            </div>
            <div class="live-news-manage-add-field">
              <label class="live-news-manage-add-label" for="liveChannelsName">${escapeHtml(t('components.liveNews.displayName') ?? 'Display name (optional)')}</label>
              <input type="text" class="live-news-manage-name" id="liveChannelsName" placeholder="" />
            </div>
            <button type="button" class="live-news-manage-add-btn" id="liveChannelsAddBtn">${escapeHtml(t('components.liveNews.addChannel') ?? 'Add channel')}</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const listEl = document.getElementById('liveChannelsList');
  if (!listEl) return;
  setupListDnD(listEl);
  renderList(listEl);

  // Clear validation state on input
  document.getElementById('liveChannelsHandle')?.addEventListener('input', (e) => {
    (e.target as HTMLInputElement).classList.remove('invalid');
  });

  document.getElementById('liveChannelsRestoreBtn')?.addEventListener('click', () => {
    const missing = getMissingDefaultChannels();
    if (missing.length === 0) return;
    channels = [...channels, ...missing];
    saveChannelsToStorage(channels);
    renderList(listEl);
  });

  const addBtn = document.getElementById('liveChannelsAddBtn') as HTMLButtonElement | null;
  addBtn?.addEventListener('click', async () => {
    const handleInput = document.getElementById('liveChannelsHandle') as HTMLInputElement | null;
    const nameInput = document.getElementById('liveChannelsName') as HTMLInputElement | null;
    const raw = handleInput?.value?.trim();
    if (!raw) return;
    const handle = raw.startsWith('@') ? raw : `@${raw}`;

    // Validate YouTube handle format: @<3-30 alphanumeric/dot/hyphen/underscore chars>
    if (!/^@[\w.-]{3,30}$/i.test(handle)) {
      if (handleInput) {
        handleInput.classList.add('invalid');
        handleInput.setAttribute('title', t('components.liveNews.invalidHandle') ?? 'Enter a valid YouTube handle (e.g. @ChannelName)');
      }
      return;
    }

    const id = customChannelIdFromHandle(handle);
    if (channels.some((c) => c.id === id)) return;

    // Validate channel exists on YouTube
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.textContent = t('components.liveNews.verifying') ?? 'Verifying…';
    }
    if (handleInput) handleInput.classList.remove('invalid');

    try {
      const baseUrl = isDesktopRuntime() ? getRemoteApiBaseUrl() : '';
      const res = await fetch(`${baseUrl}/api/youtube/live?channel=${encodeURIComponent(handle)}`);
      const data = await res.json();
      if (!data.channelExists) {
        if (handleInput) {
          handleInput.classList.add('invalid');
          handleInput.setAttribute('title', t('components.liveNews.channelNotFound') ?? 'YouTube channel not found');
        }
        return;
      }
    } catch (e) {
      // Network error — allow adding anyway (offline tolerance)
      console.warn('[LiveChannels] YouTube validation failed, allowing add:', e);
    } finally {
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = t('components.liveNews.addChannel') ?? 'Add channel';
      }
    }

    const name = nameInput?.value?.trim() || handle;
    channels.push({ id, name, handle });
    saveChannelsToStorage(channels);
    renderList(listEl);
    if (handleInput) handleInput.value = '';
    if (nameInput) nameInput.value = '';
  });
}
