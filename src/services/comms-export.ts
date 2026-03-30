import type { SavedPlace } from './saved-places';
import type { ResolvedCommsPlan } from './comms-plan';
import type { CommsDirectoryLink } from './comms-directory';

export interface CommsFieldCard {
  placeId: string;
  placeName: string;
  generatedAt: string;
  radiusKm: number;
  notes: string;
  contacts: ResolvedCommsPlan['contacts'];
  fallbackSteps: ResolvedCommsPlan['fallbackSteps'];
  checkInWindows: ResolvedCommsPlan['checkInWindows'];
  references: CommsDirectoryLink[];
  templates: ResolvedCommsPlan['templates'];
}

function csvRow(values: string[]): string {
  return values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',');
}

export function buildCommsFieldCard({
  place,
  plan,
  references,
  generatedAt = new Date(),
}: {
  place: SavedPlace;
  plan: ResolvedCommsPlan;
  references: CommsDirectoryLink[];
  generatedAt?: Date;
}): CommsFieldCard {
  return {
    placeId: place.id,
    placeName: place.name,
    generatedAt: generatedAt.toISOString(),
    radiusKm: place.radiusKm,
    notes: plan.notes,
    contacts: plan.contacts.map((contact) => ({ ...contact })),
    fallbackSteps: plan.fallbackSteps.map((step) => ({ ...step })),
    checkInWindows: plan.checkInWindows.map((window) => ({ ...window })),
    references: references.map((reference) => ({ ...reference })),
    templates: {
      safe: { ...plan.templates.safe },
      moving: { ...plan.templates.moving },
      stuck: { ...plan.templates.stuck },
      need_pickup: { ...plan.templates.need_pickup },
      need_meds: { ...plan.templates.need_meds },
    },
  };
}

export function buildCommsFieldCardJson(card: CommsFieldCard): string {
  return JSON.stringify(card, null, 2);
}

export function buildCommsFieldCardCsv(card: CommsFieldCard): string {
  const lines: string[] = [
    `Comms Field Card,${card.placeName}`,
    `Generated,${card.generatedAt}`,
    `Radius Km,${card.radiusKm}`,
  ];

  if (card.notes) {
    lines.push('', 'Notes', `"${card.notes.replace(/"/g, '""')}"`);
  }

  if (card.contacts.length > 0) {
    lines.push('', 'Contacts', 'Label,Value,Role');
    for (const contact of card.contacts) {
      lines.push(csvRow([contact.label, contact.value, contact.role]));
    }
  }

  lines.push('', 'Fallback Steps', 'Priority,Label,Kind,Instruction');
  for (const step of card.fallbackSteps) {
    lines.push(csvRow([
      String(step.priority),
      step.label,
      step.kind,
      step.instruction,
    ]));
  }

  lines.push('', 'Check-In Windows', 'Label,Cadence Minutes,Note');
  for (const window of card.checkInWindows) {
    lines.push(csvRow([
      window.label,
      String(window.cadenceMinutes),
      window.note,
    ]));
  }

  lines.push('', 'Templates', 'Status,Label,Lead,Action');
  for (const template of Object.values(card.templates)) {
    lines.push(csvRow([
      template.status,
      template.label,
      template.lead,
      template.action,
    ]));
  }

  lines.push('', 'References', 'Provider,Kind,Label,URL,Note');
  for (const reference of card.references) {
    lines.push(csvRow([
      reference.provider,
      reference.kind,
      reference.label,
      reference.url,
      reference.note,
    ]));
  }

  return lines.join('\n');
}
