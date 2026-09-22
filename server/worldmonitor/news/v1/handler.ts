import type { NewsServiceHandler } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { summarizeArticle } from './summarize-article';
import { getSummarizeArticleCache } from './get-summarize-article-cache';
import { listFeedDigest } from './list-feed-digest';
import { listCountryHeadlines } from './list-country-headlines';

export const newsHandler: NewsServiceHandler = {
  summarizeArticle,
  getSummarizeArticleCache,
  listFeedDigest,
  listCountryHeadlines,
};
