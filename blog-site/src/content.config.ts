import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    metaTitle: z.string(),
    keywords: z.string(),
    audience: z.string(),
    pubDate: z.coerce.date(),
    modifiedDate: z.coerce.date().optional(),
    author: z.string().optional(),
    authorUrl: z.string().url().optional(),
    authorBio: z.string().optional(),
    heroImage: z.string().optional(),
  }),
});

export const collections = { blog };
