import type { ViewMode, ThemePreference } from '@/types/news-reader';
import { getSettings, updateSettings } from '@/services/settings-store';
import { el } from './helpers';

export type HeaderCallback = {
  onViewChange: (mode: ViewMode | 'settings') => void;
  onSearch: (q: string) => void;
};

export function renderHeader(
  container: HTMLElement,
  activeView: ViewMode | 'settings',
  cb: HeaderCallback,
): void {
  container.innerHTML = '';
  const settings = getSettings();

  const header = el('header', { className: 'app-header' });

  // ── Logo
  const logo = el('div', { className: 'header-logo' },
    el('span', { className: 'logo-icon' }, '\u{1F4F0}'),
    el('span', { className: 'logo-text' }, 'AI News Reader'),
  );
  header.append(logo);

  // ── Search
  const searchWrap = el('div', { className: 'header-search' });
  const searchInput = el('input', {
    type: 'text',
    placeholder: 'Search stories...',
    className: 'search-input',
  });
  let debounceTimer: ReturnType<typeof setTimeout>;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => cb.onSearch(searchInput.value), 300);
  });
  searchWrap.append(searchInput);
  header.append(searchWrap);

  // ── Nav
  const nav = el('nav', { className: 'header-nav' });

  const readerBtn = el('button', {
    className: `nav-btn ${activeView === 'reader' ? 'active' : ''}`,
    'aria-label': 'Reader view',
  }, 'Reader');
  readerBtn.addEventListener('click', () => cb.onViewChange('reader'));

  const dashBtn = el('button', {
    className: `nav-btn ${activeView === 'dashboard' ? 'active' : ''}`,
    'aria-label': 'Dashboard view',
  }, 'Dashboard');
  dashBtn.addEventListener('click', () => cb.onViewChange('dashboard'));

  const settingsBtn = el('button', {
    className: `nav-btn ${activeView === 'settings' ? 'active' : ''}`,
    'aria-label': 'Settings',
  }, '\u2699');
  settingsBtn.addEventListener('click', () => cb.onViewChange('settings'));

  nav.append(readerBtn, dashBtn, settingsBtn);
  header.append(nav);

  // ── Theme Toggle
  const themeBtn = el('button', { className: 'theme-toggle', 'aria-label': 'Toggle theme' });
  themeBtn.textContent = settings.theme === 'light' ? '\u{1F319}' : '\u2600\uFE0F';
  themeBtn.addEventListener('click', () => {
    const next: ThemePreference = settings.theme === 'light' ? 'dark' : 'light';
    updateSettings({ theme: next });
    document.documentElement.dataset.theme = next;
    localStorage.setItem('newsreader-theme', next);
    themeBtn.textContent = next === 'light' ? '\u{1F319}' : '\u2600\uFE0F';
  });
  header.append(themeBtn);

  container.append(header);
}
