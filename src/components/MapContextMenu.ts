export interface MapContextMenuItem {
  label: string;
  action: () => void;
}

let activeMenu: HTMLElement | null = null;

function onEscape(e: KeyboardEvent): void {
  if (e.key === 'Escape') dismissMapContextMenu();
}

export function dismissMapContextMenu(): void {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
    document.removeEventListener('keydown', onEscape);
  }
}

export function showMapContextMenu(x: number, y: number, items: MapContextMenuItem[]): void {
  dismissMapContextMenu();
  const menu = document.createElement('div');
  menu.className = 'map-context-menu';
  const clampedX = Math.min(x, window.innerWidth - 200);
  const clampedY = Math.min(y, window.innerHeight - items.length * 32 - 8);
  menu.style.left = `${clampedX}px`;
  menu.style.top = `${clampedY}px`;
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'map-context-menu-item';
    el.textContent = item.label;
    el.addEventListener('click', (e) => { e.stopPropagation(); item.action(); dismissMapContextMenu(); });
    menu.append(el);
  });
  requestAnimationFrame(() => {
    document.addEventListener('click', dismissMapContextMenu, { once: true });
  });
  document.addEventListener('keydown', onEscape);
  document.body.appendChild(menu);
  activeMenu = menu;
}
