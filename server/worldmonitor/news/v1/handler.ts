import type { NewsServiceHandler } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { summarizeArticle } from './summarize-article';
import { getSummarizeArticleCache } from './get-summarize-article-cache';
import { listFeedDigest } from './list-feed-digest';
import { listCountryHeadlines } from './list-country-headlines';
import { listLabelChanges } from './list-label-changes';
import { listErrorReports, reviewErrorReport, submitErrorReport } from './error-reports';
import { searchFactChecks } from './search-fact-checks';
import { searchClaimHeadlines } from './search-claim-headlines';

export const newsHandler: NewsServiceHandler = {
  summarizeArticle,
  getSummarizeArticleCache,
  listFeedDigest,
  listCountryHeadlines,
  listLabelChanges,
  submitErrorReport,
  listErrorReports,
  reviewErrorReport,
  searchFactChecks,
  searchClaimHeadlines,
};
