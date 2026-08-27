import type { SafetyServiceHandler } from '../../../../src/generated/server/worldmonitor/safety/v1/service_server';
import { getTorontoSafety } from './get-toronto-safety';

export const safetyHandler: SafetyServiceHandler = { getTorontoSafety };
