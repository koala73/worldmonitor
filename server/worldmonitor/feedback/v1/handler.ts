import type { FeedbackServiceHandler } from '../../../../src/generated/server/worldmonitor/feedback/v1/service_server';

import { submitReport } from './submit-report';

export const feedbackHandler: FeedbackServiceHandler = {
  submitReport,
};
