export const config = { runtime: 'edge' };

import { ConvexHttpClient } from 'convex/browser';

export default async function handler(req) {
    if (req.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(req.url);
    const token = url.searchParams.get('token');

    if (!token || typeof token !== 'string' || token.length > 100) {
        return htmlResponse('Invalid Link', 'The unsubscribe link is invalid or has expired.', 400);
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
        return htmlResponse('Service Unavailable', 'Please try again later.', 503);
    }

    try {
        const client = new ConvexHttpClient(convexUrl);
        const result = await client.mutation('digestSubscriptions:unsubscribe', { token });

        if (result.status === 'not_found') {
            return htmlResponse('Not Found', 'This subscription could not be found. You may have already unsubscribed.', 404);
        }

        return htmlResponse('Unsubscribed', "You've been unsubscribed from World Monitor digests. You won't receive any more emails.", 200);
    } catch (err) {
        console.error('[digest/unsubscribe] Error:', err);
        return htmlResponse('Error', 'Something went wrong. Please try again.', 500);
    }
}

function htmlResponse(title, message, status) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — World Monitor</title>
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
      max-width: 480px;
      width: 100%;
      background: #111;
      border: 1px solid #222;
      border-radius: 12px;
      padding: 48px 32px;
      text-align: center;
    }
    .logo { color: #44ff88; font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { color: #666; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 32px; }
    h1 { font-size: 22px; margin-bottom: 16px; color: #fff; }
    p { color: #aaa; font-size: 14px; line-height: 1.6; }
    a { color: #44ff88; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">World Monitor</div>
    <div class="subtitle">Email Digest</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p style="margin-top:32px;"><a href="https://worldmonitor.app" style="color:#44ff88;font-size:13px;">← Back to World Monitor</a></p>
  </div>
</body>
</html>`;

    return new Response(html, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}
