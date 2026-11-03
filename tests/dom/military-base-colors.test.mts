import { expect, it } from 'vitest';
import { getMilitaryBaseColor } from '@/config/military-base-colors';

it('gives each documented military operator its own color', () => {
  const colors = ['us-nato', 'russia', 'china', 'uk', 'france', 'india', 'japan', 'italy', 'uae', 'turkey', 'other'].map(type => getMilitaryBaseColor(type, 128));
  expect(new Set(colors.map(String)).size).toBe(colors.length);
  expect(getMilitaryBaseColor('unknown', 128)).toEqual(getMilitaryBaseColor('other', 128));
});

