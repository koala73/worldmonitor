import { ValidationError } from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

export function macroHistoryWindow(limit: number | undefined): <T>(rows: T[]) => T[] {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0 || limit > 366)) {
    throw new ValidationError([{ field: 'limit', description: 'Expected an integer from 0 through 366; omit or use 0 for the full stored history.' }]);
  }
  return <T>(rows: T[]): T[] => limit ? rows.slice(-limit) : rows;
}
