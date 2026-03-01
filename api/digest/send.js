export const config = { runtime: 'edge' };

import { ConvexHttpClient } from 'convex/browser';
import { buildDigestEmail } from './_email-template.js';

const DIGEST_CACHE = new Map();

export default async function handler(req) {
    // Only allow GET or POST (Vercel cron sends GET)
    if (req.method !== 'GET' && req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    // Verify cron secret
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const auth = req.headers.get('authorization');
        if (auth !== `Bearer ${cronSecret}`) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }

    const convexUrl = process.env.CONVEX_URL;
    const resendKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.DIGEST_FROM_EMAIL || 'digest@worldmonitor.app';

    if (!convexUrl) {
        return jsonResponse({ error: 'CONVEX_URL not configured' }, 503);
    }
    if (!resendKey) {
        return jsonResponse({ error: 'RESEND_API_KEY not configured' }, 503);
    }

    try {
        const client = new ConvexHttpClient(convexUrl);

        // 1. Get all due subscriptions
        const dueSubs = await client.query('digestSubscriptions:getDueSubscriptions', {});
        if (!dueSubs || dueSubs.length === 0) {
            return jsonResponse({ sent: 0, errors: 0, cached: 0, message: 'No due subscriptions' });
        }

        // 2. Group by (variant, lang) for efficient digest generation
        const groups = new Map();
        for (const sub of dueSubs) {
            const key = `${sub.variant}:${sub.lang}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(sub);
        }

        let sent = 0;
        let errors = 0;
        let cached = 0;
        const sentIds = [];

        // 3. For each (variant, lang) group, generate or retrieve digest
        for (const [groupKey, subs] of groups) {
            const [variant, lang] = groupKey.split(':');
            const dateHour = new Date().toISOString().slice(0, 13); // e.g. 2026-03-01T22
            const cacheKey = `digest:email:v2:${variant}:${lang}:${dateHour}`;

            let digest = DIGEST_CACHE.get(cacheKey);
            if (digest) {
                cached++;
            } else {
                // Try Redis cache
                digest = await getRedisCache(cacheKey);
                if (digest) {
                    cached++;
                    DIGEST_CACHE.set(cacheKey, digest);
                }
            }

            if (!digest) {
                // Generate digest via feed aggregation + LLM
                digest = await generateDigest(variant, lang);
                if (digest) {
                    DIGEST_CACHE.set(cacheKey, digest);
                    await setRedisCache(cacheKey, digest, 3600); // 1h TTL
                }
            }

            if (!digest) {
                console.error(`[digest/send] Failed to generate digest for ${groupKey}`);
                errors += subs.length;
                continue;
            }

            // 4. Send to each subscriber, filtering by their categories
            for (const sub of subs) {
                try {
                    // Filter articles to subscriber's categories
                    const filteredArticles = (digest.articles || []).filter(
                        (a) => sub.categories.length === 0 || sub.categories.includes(a.category),
                    );

                    const emailHtml = buildDigestEmail({
                        digestText: digest.summary || 'No summary available for this period.',
                        articles: filteredArticles.slice(0, 15),
                        variant: sub.variant,
                        frequency: sub.frequency,
                        token: sub.token,
                    });

                    await sendEmail(resendKey, fromEmail, sub.email, emailHtml, variant);
                    sentIds.push(sub._id);
                    sent++;
                } catch (err) {
                    console.error(`[digest/send] Failed to send to ${sub.email}:`, err);
                    errors++;
                }
            }
        }

        // 5. Batch update lastSentAt
        if (sentIds.length > 0) {
            try {
                await client.mutation('digestSubscriptions:markSent', { ids: sentIds });
            } catch (err) {
                console.error('[digest/send] Failed to markSent:', err);
            }
        }

        return jsonResponse({ sent, errors, cached, total: dueSubs.length });
    } catch (err) {
        console.error('[digest/send] Fatal error:', err);
        return jsonResponse({ error: 'Internal error' }, 500);
    }
}

async function generateDigest(variant, lang) {
    try {
        // Fetch feed data from our own API
        const baseUrl = process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : 'https://worldmonitor.app';

        const feedUrl = `${baseUrl}/server/worldmonitor/news/v1/list-feed-digest?variant=${variant}&lang=${lang}`;
        const resp = await fetch(feedUrl, {
            headers: { 'User-Agent': 'WorldMonitor-Digest/1.0' },
            signal: AbortSignal.timeout(20_000),
        });

        if (!resp.ok) {
            console.error(`[digest/send] Feed fetch failed: ${resp.status}`);
            return null;
        }

        const feedData = await resp.json();
        const categories = feedData.categories || {};

        // Flatten all items across categories
        const allItems = [];
        for (const [catKey, bucket] of Object.entries(categories)) {
            const items = bucket.items || [];
            for (const item of items) {
                allItems.push({
                    title: item.title,
                    source: item.source,
                    category: catKey,
                    link: item.link,
                    publishedAt: item.publishedAt,
                    timeAgo: getTimeAgo(item.publishedAt),
                });
            }
        }

        // Sort by recency and take top items
        allItems.sort((a, b) => b.publishedAt - a.publishedAt);
        const topItems = allItems.slice(0, 15);

        // Generate AI summary
        let summary = '';
        const groqKey = process.env.GROQ_API_KEY;
        const openrouterKey = process.env.OPENROUTER_API_KEY;

        if (groqKey || openrouterKey) {
            summary = await generateSummary(topItems, variant, lang, groqKey, openrouterKey);
        }

        if (!summary) {
            summary = topItems
                .slice(0, 5)
                .map((item) => `${item.title} (${item.source})`)
                .join('. ');
        }

        return {
            summary,
            articles: topItems,
            generatedAt: new Date().toISOString(),
        };
    } catch (err) {
        console.error('[digest/send] generateDigest error:', err);
        return null;
    }
}

async function generateSummary(items, variant, lang, groqKey, openrouterKey) {
    const VARIANT_INST = {
        full: 'Focus on geopolitical significance. Note escalation patterns.',
        tech: 'Focus on technology industry impact. Highlight AI, startups, cybersecurity.',
        finance: 'Focus on market-moving events. Note economic indicators.',
        happy: 'Focus on positive developments and scientific breakthroughs.',
    };

    const systemPrompt = `You are a senior news editor at a global intelligence briefing service.
Write a concise digest in 2-3 paragraphs covering the most important developments.
Rules:
- Cover 3-5 top stories, each in 1-2 sentences
- Lead each story with WHAT happened and WHERE
- Maintain neutral, analytical tone
- ${VARIANT_INST[variant] || VARIANT_INST.full}
${lang !== 'en' ? `- Write entirely in ${lang} language` : ''}
- Keep total length under 300 words`;

    let userPrompt = "Here are the latest top headlines:\n";
    for (const item of items.slice(0, 12)) {
        userPrompt += `- ${item.title} — ${item.source} (${item.category})\n`;
    }
    userPrompt += '\nWrite a digest summarizing the most significant developments.';

    // Try Groq first
    if (groqKey) {
        try {
            return await callLlm(
                'https://api.groq.com/openai/v1/chat/completions',
                groqKey,
                'llama-3.1-70b-versatile',
                systemPrompt,
                userPrompt,
            );
        } catch (err) {
            console.error('[digest/send] Groq failed:', err);
        }
    }

    // Fallback to OpenRouter
    if (openrouterKey) {
        try {
            return await callLlm(
                'https://openrouter.ai/api/v1/chat/completions',
                openrouterKey,
                'meta-llama/llama-3.1-70b-instruct',
                systemPrompt,
                userPrompt,
            );
        } catch (err) {
            console.error('[digest/send] OpenRouter failed:', err);
        }
    }

    return null;
}

async function callLlm(url, apiKey, model, systemPrompt, userPrompt) {
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 500,
            temperature: 0.4,
        }),
    });

    if (!resp.ok) throw new Error(`LLM API error: ${resp.status}`);

    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
}

function getTimeAgo(publishedAt) {
    const diff = Date.now() - publishedAt;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

async function sendEmail(resendKey, from, to, html, variant) {
    const VARIANT_SUBJECTS = {
        full: 'World Monitor Intelligence Digest',
        tech: 'World Monitor Tech Digest',
        finance: 'World Monitor Finance Digest',
        happy: 'World Monitor Good News Digest',
    };

    const subject = `${VARIANT_SUBJECTS[variant] || 'World Monitor Digest'} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

    const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: `World Monitor <${from}>`,
            to: [to],
            subject,
            html,
        }),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Resend error ${resp.status}: ${text}`);
    }
}

async function getRedisCache(key) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    try {
        const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.result ? JSON.parse(data.result) : null;
    } catch {
        return null;
    }
}

async function setRedisCache(key, value, ttl) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return;
    try {
        await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}/EX/${ttl}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(3000),
        });
    } catch { /* best-effort */ }
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
