import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { BasketConfigSchema, RetailerConfigSchema } from './types.js';
import type { BasketConfig, RetailerConfig } from './types.js';

const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../configs');

export function loadRetailerConfig(slug: string): RetailerConfig {
  const filePath = join(CONFIG_DIR, 'retailers', `${slug}.yaml`);
  const raw = readFileSync(filePath, 'utf8');
  const parsed = RetailerConfigSchema.parse(yaml.load(raw));
  return parsed.retailer;
}

export function loadAllRetailerConfigs(): RetailerConfig[] {
  const dir = join(CONFIG_DIR, 'retailers');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  return files.map((f) => {
    const raw = readFileSync(join(dir, f), 'utf8');
    return RetailerConfigSchema.parse(yaml.load(raw)).retailer;
  });
}

export function loadBasketConfig(slug: string): BasketConfig {
  const filePath = join(CONFIG_DIR, 'baskets', `${slug}.yaml`);
  const raw = readFileSync(filePath, 'utf8');
  const parsed = BasketConfigSchema.parse(yaml.load(raw));
  return parsed.basket;
}

export function loadAllBasketConfigs(): BasketConfig[] {
  const dir = join(CONFIG_DIR, 'baskets');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  return files.map((f) => {
    const raw = readFileSync(join(dir, f), 'utf8');
    return BasketConfigSchema.parse(yaml.load(raw)).basket;
  });
}
