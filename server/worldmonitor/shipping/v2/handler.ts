import type { ShippingV2ServiceHandler } from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';

import { routeIntelligence } from './route-intelligence';
import { registerWebhook } from './register-webhook';
import { listWebhooks } from './list-webhooks';

export const shippingV2Handler: ShippingV2ServiceHandler = {
  routeIntelligence,
  registerWebhook,
  listWebhooks,
};
