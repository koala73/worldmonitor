interface ConflictConfig {
  name: string;
  start: Date;
  active: boolean;
}

const ACTIVE_CONFLICTS: ConflictConfig[] = [
  { name: 'UKRAINE WAR', start: new Date('2022-02-24'), active: true },
  { name: 'GAZA', start: new Date('2023-10-07'), active: true },
  { name: 'SUDAN', start: new Date('2023-04-15'), active: true },
  { name: 'HAITI CRISIS', start: new Date('2024-02-29'), active: true },
];

export function getConflictDayCounts(): { name: string; days: number }[] {
  const now = Date.now();
  return ACTIVE_CONFLICTS
    .filter(c => c.active)
    .map(c => ({
      name: c.name,
      days: Math.floor((now - c.start.getTime()) / 86_400_000),
    }));
}

export function renderConflictDaysHtml(): string {
  const counts = getConflictDayCounts();
  if (counts.length === 0) return '';
  const items = counts.map(c => `<span class="conflict-day-item">${c.name} · DAY ${c.days.toLocaleString()}</span>`).join('');
  return `<div class="conflict-days-bar" title="Days since conflict began">${items}</div>`;
}
