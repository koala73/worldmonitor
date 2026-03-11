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
  getFilteredOptionalChannels,
  getFilteredChannelRegions,
} from '@/components/LiveNewsPanel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { toApiUrl } from '@/services/runtime';
import { resolveUserCountryCode } from '@/utils/user-location';

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

/** Parse YouTube URL into a handle or video ID. Returns null if not a YouTube URL. */
function parseYouTubeInput(raw: string): { handle: string } | { videoId: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!url.hostname.match(/^(www\.)?(youtube\.com|youtu\.be)$/)) return null;

  // youtu.be/VIDEO_ID
  if (url.hostname.includes('youtu.be')) {
    const vid = url.pathname.slice(1);
    if (/^[A-Za-z0-9_-]{11}$/.test(vid)) return { videoId: vid };
    return null;
  }
  // youtube.com/watch?v=VIDEO_ID
  const v = url.searchParams.get('v');
  if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return { videoId: v };
  // youtube.com/@Handle
  const handleMatch = url.pathname.match(/^\/@([\w.-]{3,30})$/);
  if (handleMatch) return { handle: `@${handleMatch[1]}` };
  // youtube.com/c/ChannelName or /channel/ID
  const channelMatch = url.pathname.match(/^\/(c|channel)\/([\w.-]+)$/);
  if (channelMatch) return { handle: `@${channelMatch[2]}` };
  // youtube.com/ChannelName (bare path, no @/c/channel prefix)
  const bareMatch = url.pathname.match(/^\/([\w.-]{3,30})$/);
  if (bareMatch) return { handle: `@${bareMatch[1]}` };

  return null;
}

/** Check if input is an HLS stream URL (.m3u8) */
function isHlsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return url.pathname.endsWith('.m3u8') || raw.includes('.m3u8');
  } catch {
    return false;
  }
}

// Persist active region tab across re-renders
let activeRegionTab = 'na';

function channelInitials(name: string): string {
  return name.split(/[\s-]+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
}

export async function initLiveChannelsWindow(containerEl?: HTMLElement): Promise<void> {
  const appEl = containerEl ?? document.getElementById('app');
  if (!appEl) return;

  const userCountry = await resolveUserCountryCode();
  const filteredChannels = getFilteredOptionalChannels(userCountry);
  const filteredRegions = getFilteredChannelRegions(userCountry);
  const optionalChannelMap = new Map<string, LiveChannel>();
  for (const c of filteredChannels) optionalChannelMap.set(c.id, c);

  let channels: LiveChannel[] = [];

  if (document.getElementById('liveChannelsList')) {
    // Already initialized, just update the list
    channels = loadChannelsFromStorage();
    const listEl = document.getElementById('liveChannelsList') as HTMLElement;
    renderList(listEl);
    return;
  }

  if (!containerEl) {
    document.title = `${t('components.liveNews.manage') ?? 'Channel management'} - World Monitor`;
  }

  channels = loadChannelsFromStorage();
  let suppressRowClick = false;
  let searchQuery = '';

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
      const isCustom = !BUILTIN_IDS.has(ch.id);
      const row = document.createElement('div');
      row.className = 'live-news-manage-row';
      row.dataset.channelId = ch.id;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'live-news-manage-row-name';
      nameSpan.textContent = ch.name ?? '';
      row.appendChild(nameSpan);

      const removeX = document.createElement('span');
      removeX.className = 'live-news-manage-row-remove-x';
      removeX.textContent = '✕';
      removeX.addEventListener('click', (e) => {
        e.stopPropagation();
        channels = channels.filter((c) => c.id !== ch.id);
        saveChannelsToStorage(channels);
        renderList(listEl);
      });
      row.appendChild(removeX);

      if (isCustom) {
        row.addEventListener('click', (e) => {
          if (suppressRowClick || row.classList.contains('live-news-manage-row-dragging')) return;
          if ((e.target as HTMLElement).closest('input, button, textarea, select, .live-news-manage-row-remove-x')) return;
          e.preventDefault();
          showEditForm(row, ch, listEl);
        });
      }

      listEl.appendChild(row);
    }
    updateRestoreButton();
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
      handleInput.value = ch.handle ?? '';
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
      const displayName = nameInput.value.trim() || ch.name || ch.handle || '';
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
    const term = searchQuery.toLowerCase().trim();

    // Auto-switch to the first tab with matches when searching
    if (term) {
      const activeHasMatch = filteredRegions.some(r => {
        if (r.key !== activeRegionTab) return false;
        return r.channelIds.some(id => {
          const ch = optionalChannelMap.get(id);
          return ch && (ch.name.toLowerCase().includes(term) || ch.handle?.toLowerCase().includes(term));
        });
      });
      if (!activeHasMatch) {
        const firstMatch = filteredRegions.find(r =>
          r.channelIds.some(id => {
            const ch = optionalChannelMap.get(id);
            return ch && (ch.name.toLowerCase().includes(term) || ch.handle?.toLowerCase().includes(term));
          }),
        );
        if (firstMatch) activeRegionTab = firstMatch.key;
      }
    }

    // Render tab buttons
    tabBar.innerHTML = '';
    for (const region of filteredRegions) {
      const regionChannels = region.channelIds
        .map(id => optionalChannelMap.get(id))
        .filter((ch): ch is LiveChannel => !!ch);

      const matchingChannels = term
        ? regionChannels.filter(ch => ch.name.toLowerCase().includes(term) || ch.handle?.toLowerCase().includes(term))
        : regionChannels;

      const addedCount = matchingChannels.filter(ch => currentIds.has(ch.id)).length;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'panel-tab' + (region.key === activeRegionTab ? ' active' : '');
      const label = t(region.labelKey) ?? region.key.toUpperCase();
      btn.textContent = term
        ? `${label} (${matchingChannels.length})`
        : addedCount > 0 ? `${label} (${addedCount})` : label;
      btn.addEventListener('click', () => {
        activeRegionTab = region.key;
        renderAvailableChannels(listEl);
      });
      tabBar.appendChild(btn);
    }

    // Render tab content panels
    tabContents.innerHTML = '';
    for (const region of filteredRegions) {
      const panel = document.createElement('div');
      panel.className = 'live-news-manage-tab-content' + (region.key === activeRegionTab ? ' active' : '');

      const grid = document.createElement('div');
      grid.className = 'live-news-manage-card-grid';

      let matchCount = 0;
      for (const chId of region.channelIds) {
        const ch = optionalChannelMap.get(chId);
        if (!ch) continue;
        if (term && !ch.name.toLowerCase().includes(term) && !ch.handle?.toLowerCase().includes(term)) continue;
        const isAdded = currentIds.has(chId);
        grid.appendChild(createCard(ch, isAdded, listEl));
        matchCount++;
      }

      if (matchCount === 0 && term) {
        const empty = document.createElement('div');
        empty.className = 'live-news-manage-empty';
        empty.textContent = (t('components.liveNews.noResults') ?? 'No channels found matching "{{term}}"').replace('{{term}}', term);
        panel.appendChild(empty);
      } else {
        panel.appendChild(grid);
      }
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
    handleEl.textContent = ch.handle ?? '';
    info.appendChild(nameEl);
    info.appendChild(handleEl);

    const action = document.createElement('span');
    action.className = 'live-news-manage-card-action';
    action.textContent = isAdded ? '✓' : '+';

    card.appendChild(icon);
    card.appendChild(info);
    card.appendChild(action);

    card.addEventListener('mouseenter', () => {
      if (card.classList.contains('added')) action.textContent = '✕';
    });
    card.addEventListener('mouseleave', () => {
      if (card.classList.contains('added')) action.textContent = '✓';
    });

    card.addEventListener('click', () => {
      if (isAdded) {
        channels = channels.filter((c) => c.id !== ch.id);
      } else {
        if (channels.some((c) => c.id === ch.id)) return;
        channels.push({ ...ch });
      }
      saveChannelsToStorage(channels);
      renderList(listEl);
    });
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
          <div class="live-news-manage-available-header">
            <span class="live-news-manage-add-title">${escapeHtml(t('components.liveNews.availableChannels') ?? 'Available channels')}</span>
            <div class="live-news-manage-search-wrap">
              <span class="live-news-manage-search-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </span>
              <input type="text" id="liveChannelsSearch" class="live-news-manage-search-input" placeholder="${escapeHtml(t('header.search') ?? 'Search')}..." autocomplete="off" />
            </div>
          </div>
          <div class="panel-tabs" id="liveChannelsTabBar"></div>
          <div class="live-news-manage-tab-contents" id="liveChannelsTabContents"></div>
        </div>
        <div class="live-news-manage-add-section">
          <span class="live-news-manage-add-title">${escapeHtml(t('components.liveNews.customChannel') ?? 'Custom channel')}</span>
          <div class="live-news-manage-add">
            <div class="live-news-manage-add-field">
              <label class="live-news-manage-add-label" for="liveChannelsHandle">${escapeHtml(t('components.liveNews.youtubeHandleOrUrl') ?? 'YouTube handle or URL')}</label>
              <input type="text" class="live-news-manage-handle" id="liveChannelsHandle" placeholder="@Channel or youtube.com/watch?v=..." />
            </div>
            <div class="live-news-manage-add-field">
              <label class="live-news-manage-add-label" for="liveChannelsHlsUrl">${escapeHtml(t('components.liveNews.hlsUrl') ?? 'HLS Stream URL (optional)')}</label>
              <input type="text" class="live-news-manage-handle" id="liveChannelsHlsUrl" placeholder="https://example.com/stream.m3u8" />
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
  renderAvailableChannels(listEl);

  // Clear validation state on input
  document.getElementById('liveChannelsHandle')?.addEventListener('input', (e) => {
    (e.target as HTMLInputElement).classList.remove('invalid');
  });
  document.getElementById('liveChannelsHlsUrl')?.addEventListener('input', (e) => {
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
    const hlsInput = document.getElementById('liveChannelsHlsUrl') as HTMLInputElement | null;
    const nameInput = document.getElementById('liveChannelsName') as HTMLInputElement | null;
    const raw = handleInput?.value?.trim();
    const hlsUrl = hlsInput?.value?.trim();
    if (!raw && !hlsUrl) return;
    if (handleInput) handleInput.classList.remove('invalid');
    if (hlsInput) hlsInput.classList.remove('invalid');

    // Check if HLS URL is provided
    if (hlsUrl) {
      if (!isHlsUrl(hlsUrl)) {
        if (hlsInput) {
          hlsInput.classList.add('invalid');
          hlsInput.setAttribute('title', t('components.liveNews.invalidHlsUrl') ?? 'Enter a valid HLS stream URL (.m3u8)');
        }
        return;
      }

      // Create custom HLS channel
      const id = `custom-hls-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      if (channels.some((c) => c.id === id)) return;

      const name = nameInput?.value?.trim() || 'HLS Stream';
      channels.push({ id, name, hlsUrl, useFallbackOnly: true });
      saveChannelsToStorage(channels);
      renderList(listEl);
      if (handleInput) handleInput.value = '';
      if (hlsInput) hlsInput.value = '';
      if (nameInput) nameInput.value = '';
      return;
    }

    // Handle YouTube input (existing logic)
    if (!raw) return;

    // Try parsing as a YouTube URL first
    const parsed = parseYouTubeInput(raw);

    // Direct video URL (watch?v= or youtu.be/)
    if (parsed && 'videoId' in parsed) {
      const videoId = parsed.videoId;
      const id = `custom-vid-${videoId}`;
      if (channels.some((c) => c.id === id)) return;

      if (addBtn) {
        addBtn.disabled = true;
        addBtn.textContent = t('components.liveNews.verifying') ?? 'Verifying…';
      }

      // Try to resolve video/channel title via our proxy (YouTube oembed has no CORS)
      let resolvedName = nameInput?.value?.trim() || '';
      if (!resolvedName) {
        try {
          const res = await fetch(toApiUrl(`/api/youtube/live?videoId=${encodeURIComponent(videoId)}`));
          if (res.ok) {
            const data = await res.json();
            resolvedName = data.channelName || data.title || '';
          }
        } catch { /* use fallback */ }
      }
      if (!resolvedName) resolvedName = `Video ${videoId}`;

      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = t('components.liveNews.addChannel') ?? 'Add channel';
      }

      channels.push({ id, name: resolvedName, handle: `@video`, fallbackVideoId: videoId, useFallbackOnly: true });
      saveChannelsToStorage(channels);
      renderList(listEl);
      if (handleInput) handleInput.value = '';
      if (hlsInput) hlsInput.value = '';
      if (nameInput) nameInput.value = '';
      return;
    }

    // Extract handle from URL, or treat raw input as handle
    const handle = parsed && 'handle' in parsed
      ? parsed.handle
      : raw.startsWith('@') ? raw : `@${raw}`;

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

    // Validate channel exists on YouTube + resolve name
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.textContent = t('components.liveNews.verifying') ?? 'Verifying…';
    }

    let resolvedName = '';
    try {
      const res = await fetch(toApiUrl(`/api/youtube/live?channel=${encodeURIComponent(handle)}`));
      if (res.ok) {
        const data = await res.json();
        resolvedName = data.channelName || '';
      }
      // Non-OK status (429, 5xx) or ambiguous response — allow adding anyway
    } catch (e) {
      // Network/parse error — allow adding anyway (offline tolerance)
      console.warn('[LiveChannels] YouTube validation failed, allowing add:', e);
    } finally {
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = t('components.liveNews.addChannel') ?? 'Add channel';
      }
    }

    const name = nameInput?.value?.trim() || resolvedName || handle;
    channels.push({ id, name, handle });
    saveChannelsToStorage(channels);
    renderList(listEl);
    if (handleInput) handleInput.value = '';
    if (hlsInput) hlsInput.value = '';
    if (nameInput) nameInput.value = '';
  });

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  const searchInput = document.getElementById('liveChannelsSearch') as HTMLInputElement | null;
  searchInput?.addEventListener('input', (e) => {
    searchQuery = (e.target as HTMLInputElement).value;
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => renderAvailableChannels(listEl), 150);
  });
}
