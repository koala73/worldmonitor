import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const articleSchema = z.object({
  title: z.string(),
  description: z.string(),
  metaTitle: z.string(),
  keywords: z.string(),
  audience: z.string(),
  pubDate: z.coerce.date(),
  modifiedDate: z.coerce.date().optional(),
  author: z.string().optional(),
  authorType: z.enum(['Person', 'Organization']).optional(),
  authorUrl: z.string().url().optional(),
  authorBio: z.string().optional(),
  heroImage: z.string().optional(),
  pinned: z.boolean().optional(),
});

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: articleSchema,
});

const guides = defineCollection({
  loader: glob({ pattern: '{vs,alternatives,best}/*.md', base: './src/content/guides' }),
  schema: articleSchema,
});

export const collections = { blog, guides };
