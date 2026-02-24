import type { NewsServiceHandler } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { summarizeArticle } from './summarize-article';

export const newsHandler: NewsServiceHandler = {
  summarizeArticle,
};
