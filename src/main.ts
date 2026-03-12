import './styles/theme.css';
import './styles/components.css';
import { initApp } from './ui/app';

// Apply stored theme before first paint
const stored = localStorage.getItem('newsreader-theme');
if (stored === 'light' || stored === 'dark') {
  document.documentElement.dataset.theme = stored;
} else {
  document.documentElement.dataset.theme = 'dark';
}

// Boot the app
initApp('app');
