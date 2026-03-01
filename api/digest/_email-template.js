/**
 * Build HTML email for a digest issue.
 *
 * @param {object} options
 * @param {string} options.digestText   - AI-generated summary paragraphs
 * @param {Array}  options.articles     - Top articles: { title, link, source, category, timeAgo }
 * @param {string} options.variant      - 'full' | 'tech' | 'finance' | 'happy'
 * @param {string} options.frequency    - 'hourly' | 'daily' | 'weekly' etc.
 * @param {string} options.token        - Subscriber token for manage/unsub links
 * @param {string} [options.date]       - Human-readable date string
 * @returns {string} HTML email
 */
export function buildDigestEmail({
    digestText,
    articles = [],
    variant = 'full',
    frequency = 'daily',
    token,
    date,
}) {
    const dateStr = date || new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    const FREQUENCY_LABELS = {
        hourly: 'Hourly',
        '2h': 'Bi-Hourly',
        '6h': '6-Hour',
        daily: 'Daily',
        weekly: 'Weekly',
        monthly: 'Monthly',
    };

    const VARIANT_LABELS = {
        full: 'Intelligence Briefing',
        tech: 'Tech Digest',
        finance: 'Finance Digest',
        happy: 'Good News Digest',
    };

    const briefingType = `${FREQUENCY_LABELS[frequency] || 'Daily'} ${VARIANT_LABELS[variant] || 'Briefing'}`;
    const manageUrl = `https://worldmonitor.app/api/digest/manage?token=${token}`;
    const unsubUrl = `https://worldmonitor.app/api/digest/unsubscribe?token=${token}`;

    const articlesHtml = articles
        .map(
            (a) => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #1a1a1a;">
          <a href="${escapeAttr(a.link)}" style="color:#e0e0e0;text-decoration:none;font-size:14px;line-height:1.4;display:block;" target="_blank">${escape(a.title)}</a>
          <span style="color:#666;font-size:11px;margin-top:4px;display:block;">${escape(a.source)}${a.timeAgo ? ` · ${escape(a.timeAgo)}` : ''}${a.category ? ` · ${escape(a.category)}` : ''}</span>
        </td>
      </tr>`,
        )
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>World Monitor Digest — ${dateStr}</title>
  <!--[if mso]>
  <style>body,table,td { font-family: Arial, sans-serif !important; }</style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background:#050505;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',monospace;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#050505;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:8px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="padding:32px 28px 20px;border-bottom:1px solid #1a1a1a;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <span style="color:#44ff88;font-size:22px;font-weight:700;letter-spacing:-0.5px;">◆ World Monitor</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding-top:8px;">
                    <span style="color:#888;font-size:12px;letter-spacing:1px;text-transform:uppercase;">${dateStr} — ${escape(briefingType)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- AI Summary -->
          <tr>
            <td style="padding:28px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-bottom:12px;">
                    <span style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#44ff88;">AI-GENERATED SUMMARY</span>
                    <div style="width:40px;height:2px;background:#44ff88;margin-top:6px;border-radius:1px;"></div>
                  </td>
                </tr>
                <tr>
                  <td style="color:#ccc;font-size:14px;line-height:1.7;">
                    ${digestText.split('\n').filter(Boolean).map(p => `<p style="margin:0 0 12px;">${escape(p)}</p>`).join('')}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${articles.length > 0 ? `
          <!-- Top Stories -->
          <tr>
            <td style="padding:0 28px 28px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-bottom:12px;">
                    <span style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#888;">TOP STORIES</span>
                    <div style="width:32px;height:1px;background:#333;margin-top:6px;"></div>
                  </td>
                </tr>
                ${articlesHtml}
              </table>
            </td>
          </tr>
          ` : ''}

          <!-- Footer -->
          <tr>
            <td style="padding:20px 28px;border-top:1px solid #1a1a1a;text-align:center;">
              <a href="${manageUrl}" style="color:#44ff88;font-size:12px;text-decoration:none;margin-right:16px;">Manage preferences</a>
              <a href="${unsubUrl}" style="color:#666;font-size:12px;text-decoration:none;">Unsubscribe</a>
              <p style="color:#444;font-size:10px;margin-top:16px;">Powered by World Monitor — worldmonitor.app</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escape(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
