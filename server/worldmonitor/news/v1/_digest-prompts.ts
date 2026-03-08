declare const process: { env: Record<string, string | undefined> };

const VARIANT_INSTRUCTIONS: Record<string, string> = {
    full: 'Focus on geopolitical significance. Mention threat implications where relevant. Note any escalation patterns or de-escalation signals.',
    tech: 'Focus on technology industry impact. Highlight AI developments, startup funding, cybersecurity incidents, and infrastructure changes.',
    finance: 'Focus on market-moving events. Note economic indicators, central bank actions, commodity shifts, and regulatory changes with potential financial impact.',
    happy: 'Focus on positive developments, scientific breakthroughs, humanitarian progress, and constructive global cooperation.',
};

const FREQUENCY_PERIODS: Record<string, string> = {
    hourly: 'past hour',
    '2h': 'past 2 hours',
    '6h': 'past 6 hours',
    daily: "today",
    weekly: "this week",
    monthly: "this month",
};

export interface DigestItem {
    title: string;
    source: string;
    category: string;
    link: string;
}

export interface DigestPromptOptions {
    variant: string;
    lang: string;
    frequency: string;
    items: DigestItem[];
}

export function buildDigestPrompt(options: DigestPromptOptions): {
    systemPrompt: string;
    userPrompt: string;
} {
    const { variant, lang, frequency, items } = options;

    const period = FREQUENCY_PERIODS[frequency] || 'today';
    const variantInst = VARIANT_INSTRUCTIONS[variant] || VARIANT_INSTRUCTIONS.full;
    const langInst = lang !== 'en' ? `\nWrite the digest in ${lang} language.` : '';

    const systemPrompt = `You are a senior news editor at a global intelligence briefing service.
Write a concise digest covering the ${period}'s most important developments.
Rules:
- Cover 3-5 top stories, each in 1-2 sentences
- Lead each story with WHAT happened and WHERE
- Maintain neutral, analytical tone
- If a story has geopolitical/market/tech implications, note them briefly
- ${variantInst}${langInst}
- Do NOT include headlines or bullet points — write flowing paragraphs
- Keep total length under 300 words`;

    // Group items by category
    const byCategory = new Map<string, DigestItem[]>();
    for (const item of items) {
        const cat = item.category || 'general';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(item);
    }

    let userPrompt = `Here are the ${period}'s top headlines by category:\n`;
    for (const [cat, catItems] of byCategory) {
        userPrompt += `\n## ${cat}\n`;
        for (const item of catItems.slice(0, 5)) {
            userPrompt += `- ${item.title} — ${item.source}\n`;
        }
    }
    userPrompt += '\nWrite a digest summarizing the most significant developments.';

    return { systemPrompt, userPrompt };
}

export async function generateDigestSummary(
    prompt: { systemPrompt: string; userPrompt: string },
): Promise<string> {
    // Try Groq first, then OpenRouter
    const groqKey = process.env.GROQ_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

    if (groqKey) {
        try {
            return await callLlm(
                'https://api.groq.com/openai/v1/chat/completions',
                groqKey,
                'llama-3.1-70b-versatile',
                prompt,
            );
        } catch (err) {
            console.error('[digest] Groq failed, trying OpenRouter:', err);
        }
    }

    if (openrouterKey) {
        return await callLlm(
            'https://openrouter.ai/api/v1/chat/completions',
            openrouterKey,
            'meta-llama/llama-3.1-70b-instruct',
            prompt,
        );
    }

    // Fallback: return a simple headline-based summary
    return 'AI summary unavailable — here are the top headlines for this period.';
}

async function callLlm(
    url: string,
    apiKey: string,
    model: string,
    prompt: { systemPrompt: string; userPrompt: string },
): Promise<string> {
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: prompt.systemPrompt },
                { role: 'user', content: prompt.userPrompt },
            ],
            max_tokens: 500,
            temperature: 0.4,
        }),
    });

    if (!resp.ok) {
        throw new Error(`LLM API error: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json() as {
        choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() || 'Summary generation failed.';
}
