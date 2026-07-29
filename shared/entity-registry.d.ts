export type EntityType = 'company' | 'index' | 'commodity' | 'crypto' | 'sector' | 'country';

export interface EntityEntry {
  id: string;
  type: EntityType;
  name: string;
  aliases: string[];
  keywords: string[];
  sector?: string;
  related?: string[];
}

export declare const ENTITY_REGISTRY: EntityEntry[];

export declare function getEntityById(id: string): EntityEntry | undefined;
