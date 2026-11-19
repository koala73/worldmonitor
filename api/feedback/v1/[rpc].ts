export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createFeedbackServiceRoutes } from '../../../src/generated/server/worldmonitor/feedback/v1/service_server';
import { feedbackHandler } from '../../../server/worldmonitor/feedback/v1/handler';
import { withFeedbackBodyLimit } from '../../../server/worldmonitor/feedback/v1/body-limit';

export default withFeedbackBodyLimit(createDomainGateway(
  createFeedbackServiceRoutes(feedbackHandler, serverOptions),
));
