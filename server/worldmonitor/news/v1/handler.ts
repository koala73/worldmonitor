import type { NewsServiceHandler } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { summarizeArticle } from './summarize-article';
import { listFeedDigest } from './list-feed-digest';

export const newsHandler: NewsServiceHandler = {
  summarizeArticle,
  listFeedDigest,
};
