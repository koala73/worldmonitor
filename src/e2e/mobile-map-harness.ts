import '../styles/main.css';
import { MapPopup } from '../components/MapPopup';
import type { Hotspot } from '../types';

type MobileMapHarness = {
  ready: boolean;
  getPopupRect: () => {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
  } | null;
  getFirstHotspotRect: () => {
    width: number;
    height: number;
  } | null;
};

declare global {
  interface Window {
    __mobileMapHarness?: MobileMapHarness;
  }
}

const app = document.getElementById('app');
if (!app) {
  throw new Error('Missing #app container for mobile popup harness');
}

document.body.style.margin = '0';
document.body.style.overflow = 'hidden';

app.className = 'map-container';
app.style.width = '100vw';
app.style.height = '100vh';
app.style.position = 'relative';
app.style.overflow = 'hidden';

const overlays = document.createElement('div');
overlays.id = 'mapOverlays';
app.appendChild(overlays);

const sampleHotspot: Hotspot = {
  id: 'e2e-hotspot',
  name: 'E2E Hotspot',
  lat: 33.0,
  lon: 36.0,
  keywords: ['e2e', 'hotspot'],
  level: 'high',
  location: 'E2E Zone',
  description: 'Deterministic hotspot used for mobile popup QA.',
  agencies: ['E2E Agency'],
  status: 'monitoring',
};

const popup = new MapPopup(app);

const hotspot = document.createElement('div');
hotspot.className = 'hotspot';
hotspot.style.left = '50%';
hotspot.style.top = '50%';
hotspot.innerHTML = '<div class="hotspot-marker high"></div>';
hotspot.addEventListener('click', (e) => {
  e.stopPropagation();
  const rect = app.getBoundingClientRect();
  popup.show({
    type: 'hotspot',
    data: sampleHotspot,
    relatedNews: [],
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  });
});
overlays.appendChild(hotspot);

window.__mobileMapHarness = {
  ready: true,
  getPopupRect: () => {
    const element = document.querySelector('.map-popup') as HTMLElement | null;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  },
  getFirstHotspotRect: () => {
    const firstHotspot = document.querySelector('.hotspot') as HTMLElement | null;
    if (!firstHotspot) return null;
    const rect = firstHotspot.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  },
};
