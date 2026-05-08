import { loadFromStorage, saveToStorage } from '@/utils';
import { STORAGE_KEYS } from '@/config';
import type { WorkspaceTab } from '@/types';

export function getWorkspaces(): WorkspaceTab[] {
  return loadFromStorage<WorkspaceTab[]>(STORAGE_KEYS.workspaceTabs, []);
}

export function saveWorkspaces(tabs: WorkspaceTab[]): void {
  saveToStorage(STORAGE_KEYS.workspaceTabs, tabs);
}

export function getActiveWorkspaceId(): string | null {
  return localStorage.getItem(STORAGE_KEYS.activeWorkspaceTab);
}

export function setActiveWorkspaceId(id: string | null): void {
  if (id) {
    localStorage.setItem(STORAGE_KEYS.activeWorkspaceTab, id);
  } else {
    localStorage.removeItem(STORAGE_KEYS.activeWorkspaceTab);
  }
}

export function backupMainWorkspace(): void {
  const panelSettings = loadFromStorage<Record<string, any>>(STORAGE_KEYS.panels, {});
  let panelOrder: string[] | undefined ;
  const savedOrder = localStorage.getItem('panel-order');
  if (savedOrder) {
    try {
      panelOrder = JSON.parse(savedOrder);
    } catch { }
  }
  saveToStorage(STORAGE_KEYS.mainWorkspaceBackup, { panelSettings, panelOrder });
}

export function restoreMainWorkspace(): void {
  const backup = loadFromStorage<{ panelSettings?: Record<string, any>, panelOrder?: string[] } | null>(STORAGE_KEYS.mainWorkspaceBackup, null);
  if (backup?.panelSettings) {
    saveToStorage(STORAGE_KEYS.panels, backup.panelSettings);
    if (backup.panelOrder) {
      localStorage.setItem('panel-order', JSON.stringify(backup.panelOrder));
    } else {
      localStorage.removeItem('panel-order');
    }
  } else {
    localStorage.removeItem(STORAGE_KEYS.panels);
    localStorage.removeItem('panel-order');
  }
}

export function createWorkspace(name: string): WorkspaceTab {
  const id = 'workspace-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
  const panelSettings = loadFromStorage<Record<string, any>>(STORAGE_KEYS.panels, {});
  let panelOrder: string[] | undefined ;
  const savedOrder = localStorage.getItem('panel-order');
  if (savedOrder) {
    try {
      panelOrder = JSON.parse(savedOrder);
    } catch { }
  }
  
  const tab: WorkspaceTab = {
    id,
    name,
    panelSettings,
    panelOrder,
  };
  
  const tabs = getWorkspaces();
  tabs.push(tab);
  saveWorkspaces(tabs);
  return tab;
}

export function loadWorkspace(id: string, newWindow = false): void {
  const tabs = getWorkspaces();
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  
  if (newWindow) {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', id);
    window.open(url.toString(), '_blank');
    return;
  }
  
  if (getActiveWorkspaceId() === null) {
    backupMainWorkspace();
  }
  
  // Apply to local storage and reload
  saveToStorage(STORAGE_KEYS.panels, tab.panelSettings);
  if (tab.panelOrder) {
    localStorage.setItem('panel-order', JSON.stringify(tab.panelOrder));
  } else {
    localStorage.removeItem('panel-order');
  }
  setActiveWorkspaceId(id);
  window.location.reload();
}

export function deleteWorkspace(id: string): void {
  const tabs = getWorkspaces();
  const newTabs = tabs.filter(t => t.id !== id);
  saveWorkspaces(newTabs);
  if (getActiveWorkspaceId() === id) {
    setActiveWorkspaceId(null);
    restoreMainWorkspace();
    window.location.reload();
  }
}

export function updateActiveWorkspace(): void {
  const id = getActiveWorkspaceId();
  if (!id) return;
  
  const tabs = getWorkspaces();
  const tabIndex = tabs.findIndex(t => t.id === id);
  if (tabIndex === -1) return;
  
  const panelSettings = loadFromStorage<Record<string, any>>(STORAGE_KEYS.panels, {});
  let panelOrder: string[] | undefined ;
  const savedOrder = localStorage.getItem('panel-order');
  if (savedOrder) {
    try {
      panelOrder = JSON.parse(savedOrder);
    } catch { }
  }
  
  tabs[tabIndex] = {
    ...tabs[tabIndex]!,
    panelSettings,
    panelOrder,
  };
  saveWorkspaces(tabs);
}

export function renameWorkspace(id: string, newName: string): void {
  const tabs = getWorkspaces();
  const tabIndex = tabs.findIndex(t => t.id === id);
  if (tabIndex === -1) return;
  
  tabs[tabIndex] = {
    ...tabs[tabIndex]!,
    name: newName,
  };
  saveWorkspaces(tabs);
}

