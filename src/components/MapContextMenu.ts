export interface MapContextMenuItem {
  label: string;
  action: () => void;
}

let activeMenu: HTMLElement | null = null;
let returnFocus: HTMLElement | null = null;
let clickDismiss: AbortController | null = null;

function menuItems(): HTMLElement[] {
  return activeMenu ? Array.from(activeMenu.querySelectorAll<HTMLElement>('.map-context-menu-item')) : [];
}

function menuContainsFocus(): boolean {
  return !!activeMenu?.contains(document.activeElement);
}

function onMenuFocusIn(e: FocusEvent): void {
  const target = e.target;
  if (activeMenu && target instanceof Node && !activeMenu.contains(target)) {
    dismissMapContextMenu();
  }
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' || e.key === 'Tab') {
    dismissMapContextMenu();
    return;
  }
  if (!activeMenu || !menuContainsFocus()) return;

  const items = menuItems();
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLElement);

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[(current + 1) % items.length]?.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[(current - 1 + items.length) % items.length]?.focus();
  } else if (e.key === 'Home') {
    e.preventDefault();
    items[0]?.focus();
  } else if (e.key === 'End') {
    e.preventDefault();
    items[items.length - 1]?.focus();
  } else if ((e.key === 'Enter' || e.key === ' ') && current >= 0) {
    e.preventDefault();
    items[current]?.click();
  }
}

export function dismissMapContextMenu(): void {
  if (activeMenu) {
    const hadFocus = activeMenu.contains(document.activeElement);
    const menu = activeMenu;
    clickDismiss?.abort();
    clickDismiss = null;
    menu.remove();
    activeMenu = null;
    document.removeEventListener('keydown', onMenuKeydown);
    document.removeEventListener('focusin', onMenuFocusIn);
    // Removing the menu while focus was inside drops focus to <body>;
    // hand it back to whatever had it before the menu opened — unless
    // another overlay already took focus (Cmd+K / search).
    const active = document.activeElement;
    const keepCurrent = active instanceof HTMLElement
      && active.isConnected
      && active !== document.body
      && active !== menu;
    if (hadFocus && !keepCurrent && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }
}

export function showMapContextMenu(x: number, y: number, items: MapContextMenuItem[]): void {
  dismissMapContextMenu();
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const menu = document.createElement('div');
  menu.className = 'map-context-menu';
  menu.setAttribute('role', 'menu');
  const clampedX = Math.min(x, window.innerWidth - 200);
  const clampedY = Math.min(y, window.innerHeight - items.length * 32 - 8);
  menu.style.left = `${clampedX}px`;
  menu.style.top = `${clampedY}px`;
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'map-context-menu-item';
    el.setAttribute('role', 'menuitem');
    el.tabIndex = -1;
    el.textContent = item.label;
    el.addEventListener('click', (e) => { e.stopPropagation(); item.action(); dismissMapContextMenu(); });
    menu.append(el);
  });
  clickDismiss = new AbortController();
  const { signal } = clickDismiss;
  requestAnimationFrame(() => {
    if (signal.aborted || !activeMenu) return;
    document.addEventListener('click', dismissMapContextMenu, { once: true, signal });
  });
  document.addEventListener('keydown', onMenuKeydown);
  document.addEventListener('focusin', onMenuFocusIn);
  document.body.appendChild(menu);
  activeMenu = menu;
  // Menu pattern: focus moves into the menu on open; arrows walk the items.
  menuItems()[0]?.focus();
}
