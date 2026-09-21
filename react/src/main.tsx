import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { MonitorApp } from './components/MonitorApp';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/monitor.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={neutralTheme}>
      <MonitorApp />
    </Theme>
  </StrictMode>,
);
