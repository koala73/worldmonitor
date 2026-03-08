export const config = { runtime: 'edge' };

import { ConvexHttpClient } from 'convex/browser';

const VALID_FREQUENCIES = ['hourly', '2h', '6h', 'daily', 'weekly', 'monthly'];
const FREQUENCY_LABELS = {
    hourly: 'Every hour',
    '2h': 'Every 2 hours',
    '6h': 'Every 6 hours',
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
};

const VARIANT_CATEGORIES = {
    full: ['politics', 'us', 'europe', 'middleeast', 'asia', 'africa', 'latam', 'tech', 'ai', 'finance', 'energy', 'gov', 'thinktanks', 'intel', 'crisis'],
    tech: ['tech', 'ai', 'startups', 'security', 'github', 'funding', 'cloud', 'layoffs', 'finance'],
    finance: ['markets', 'forex', 'bonds', 'commodities', 'crypto', 'centralbanks', 'economic', 'ipo', 'fintech', 'regulation', 'analysis'],
    happy: ['positive', 'science'],
};

export default async function handler(req) {
    const url = new URL(req.url);
    const token = url.searchParams.get('token');

    if (!token || typeof token !== 'string' || token.length > 100) {
        return htmlPage('Invalid Link', '<p>The manage link is invalid or has expired.</p>', 400);
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
        return htmlPage('Service Unavailable', '<p>Please try again later.</p>', 503);
    }

    const client = new ConvexHttpClient(convexUrl);

    if (req.method === 'POST') {
        return handlePost(req, client, token);
    }

    return handleGet(client, token, url.searchParams.get('updated') === '1');
}

async function handleGet(client, token, showUpdated) {
    try {
        const sub = await client.query('digestSubscriptions:getByToken', { token });
        if (!sub) {
            return htmlPage('Not Found', '<p>This subscription could not be found.</p>', 404);
        }

        const categories = VARIANT_CATEGORIES[sub.variant] || VARIANT_CATEGORIES.full;
        const flash = showUpdated ? '<div class="flash">✓ Preferences updated successfully!</div>' : '';

        const formHtml = `
      ${flash}
      <form method="POST" action="/api/digest/manage?token=${token}">
        <div class="field">
          <label>Email</label>
          <input type="email" value="${escapeHtml(sub.email)}" disabled class="input disabled" />
        </div>

        <div class="field">
          <label>Delivery frequency</label>
          <select name="frequency" class="input">
            ${VALID_FREQUENCIES.map(f =>
            `<option value="${f}"${sub.frequency === f ? ' selected' : ''}>${FREQUENCY_LABELS[f]}</option>`
        ).join('')}
          </select>
        </div>

        <div class="field">
          <label>Categories</label>
          <div class="pills">
            ${categories.map(cat =>
            `<label class="pill">
                <input type="checkbox" name="categories" value="${cat}"${(sub.categories || []).includes(cat) ? ' checked' : ''} />
                <span>${cat}</span>
              </label>`
        ).join('')}
          </div>
        </div>

        <button type="submit" class="btn">Update Preferences</button>
      </form>

      <div class="danger-zone">
        <a href="/api/digest/unsubscribe?token=${token}" class="unsub-link">Unsubscribe from all digests</a>
      </div>
    `;

        return htmlPage('Manage Digest', formHtml, 200);
    } catch (err) {
        console.error('[digest/manage] GET error:', err);
        return htmlPage('Error', '<p>Something went wrong. Please try again.</p>', 500);
    }
}

async function handlePost(req, client, token) {
    try {
        const formData = await req.formData();
        const frequency = formData.get('frequency');
        const categories = formData.getAll('categories');

        if (!frequency || !VALID_FREQUENCIES.includes(frequency)) {
            return htmlPage('Error', '<p>Invalid frequency selected.</p>', 400);
        }

        if (!categories || categories.length === 0) {
            return htmlPage('Error', '<p>Select at least one category.</p>', 400);
        }

        await client.mutation('digestSubscriptions:updatePreferences', {
            token,
            frequency,
            categories,
        });

        // Redirect back to GET with flash message
        return new Response(null, {
            status: 302,
            headers: { Location: `/api/digest/manage?token=${token}&updated=1` },
        });
    } catch (err) {
        console.error('[digest/manage] POST error:', err);
        return htmlPage('Error', '<p>Failed to update preferences. Please try again.</p>', 500);
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function htmlPage(title, body, status) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — World Monitor Digest</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'JetBrains Mono', monospace;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      max-width: 520px;
      width: 100%;
      background: #111;
      border: 1px solid #222;
      border-radius: 12px;
      padding: 40px 32px;
    }
    .logo { color: #44ff88; font-size: 24px; font-weight: 700; text-align: center; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; text-align: center; margin-bottom: 32px; }
    h1 { font-size: 18px; color: #fff; margin-bottom: 24px; text-align: center; }
    .field { margin-bottom: 20px; }
    .field label { display: block; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .input {
      width: 100%;
      background: #1a1a1a;
      border: 1px solid #333;
      color: #e0e0e0;
      padding: 10px 12px;
      font-family: inherit;
      font-size: 13px;
      border-radius: 6px;
      outline: none;
    }
    .input:focus { border-color: #44ff88; }
    .input.disabled { color: #666; cursor: not-allowed; }
    select.input { cursor: pointer; }
    .pills { display: flex; flex-wrap: wrap; gap: 8px; }
    .pill {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 20px;
      padding: 6px 14px;
      cursor: pointer;
      font-size: 12px;
      color: #aaa;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
    }
    .pill:has(input:checked) {
      border-color: rgba(68, 255, 136, 0.4);
      color: #44ff88;
      background: rgba(68, 255, 136, 0.08);
    }
    .pill input { display: none; }
    .btn {
      width: 100%;
      background: #44ff88;
      color: #0a0a0a;
      border: none;
      padding: 12px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.5px;
      cursor: pointer;
      transition: opacity 0.15s;
      margin-top: 8px;
    }
    .btn:hover { opacity: 0.9; }
    .danger-zone {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid #222;
      text-align: center;
    }
    .unsub-link { color: #ef4444; font-size: 12px; text-decoration: none; }
    .unsub-link:hover { text-decoration: underline; }
    .flash {
      background: rgba(68, 255, 136, 0.1);
      border: 1px solid rgba(68, 255, 136, 0.3);
      color: #44ff88;
      padding: 10px 16px;
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 20px;
      text-align: center;
    }
    p { color: #aaa; font-size: 14px; line-height: 1.6; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">World Monitor</div>
    <div class="subtitle">Digest Preferences</div>
    <h1>${title}</h1>
    ${body}
  </div>
</body>
</html>`;

    return new Response(html, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}
