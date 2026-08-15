'use strict';

const OPENROUTER_FREE_PRIMARY_MODEL = 'google/gemma-4-26b-a4b-it:free';
const OPENROUTER_FREE_BACKUP_MODEL = 'openai/gpt-oss-20b:free';
const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-20b';
const OPENROUTER_PROVIDER_ROUTING = {
  ignore: ['baidu', 'alibaba', 'deepseek', 'siliconflow', 'streamlake', 'novita'],
  sort: 'throughput',
};

module.exports = {
  GROQ_DEFAULT_MODEL,
  OPENROUTER_FREE_BACKUP_MODEL,
  OPENROUTER_FREE_PRIMARY_MODEL,
  OPENROUTER_PROVIDER_ROUTING,
};
