import type { NewsServiceHandler } from '../../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { listNewsItems } from './list-news-items';
import { summarizeHeadlines } from './summarize-headlines';
import { summarizeArticle } from './summarize-article';

export const newsHandler: NewsServiceHandler = {
  listNewsItems,
  summarizeHeadlines,
  summarizeArticle,
};
