// Free alert ladder UI (#4273): mount the notifications settings panel as a
// signed-in FREE account (no entitlement snapshot = the free ladder) against
// fixture channel data, and capture the clamped surface — locked paid
// channels, (Pro) digest/sensitivity rungs, the 3-country cap and its
// upgrade-named error, and the legacy connected Slack row's paused note.
//
// The panel is mounted directly (renderNotificationsSettings via the dev
// server's module graph) rather than through the Clerk-gated settings modal:
// signing in is not scriptable here, and the host passes nothing but
// `isSignedIn` anyway. /api/notification-channels is stubbed with fixture
// data, so these screenshots are TEST DATA by construction.
export default async function run({ page, base, shot, log }) {
  const fixture = {
    channels: [
      { channelType: 'slack', verified: true, slackChannelName: 'alerts', slackTeamName: 'Acme' },
    ],
    alertRules: [{
      variant: 'full', enabled: true, eventTypes: [], sensitivity: 'critical',
      channels: ['slack', 'email'], digestMode: 'realtime', countries: ['UA', 'TW'],
    }],
  };
  await page.route('**/api/notification-channels*', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto(`${base}/dashboard`);
  await page.waitForSelector('html[data-wm-event-handlers-ready]', { timeout: 60_000 });

  await page.evaluate(async () => {
    // Signing in is not scriptable here: use the module's own test seam so
    // authFetch carries a dummy bearer into the stubbed route above.
    const channels = await import('/src/services/notification-channels.ts');
    channels.__setNotificationChannelsClientDepsForTests({
      getClerkToken: async () => 'e2e-fixture-token',
    });
    const m = await import('/src/services/notifications-settings.ts');
    // The capture is about the notifications panel alone: hide the dashboard
    // chrome (header, panels, and the workspace-chooser modal that pops on a
    // fresh profile) so nothing bleeds into the frame, and mount the host in
    // normal flow (not position:fixed) so fullPage captures its whole height.
    for (const el of Array.from(document.body.children)) el.style.display = 'none';
    document.body.style.background = 'var(--bg, #0a0e1a)';
    // The dashboard pins html/body to the viewport (overflow hidden); undo
    // that so the document grows with the panel and fullPage captures it all.
    for (const el of [document.documentElement, document.body]) {
      el.style.height = 'auto';
      el.style.minHeight = '100vh';
      el.style.overflow = 'visible';
    }
    const host = document.createElement('div');
    host.className = 'modal unified-settings-modal';
    // max-height/overflow unset: .modal would otherwise clamp the host to
    // 80vh and scroll inside it, which breaks the fullPage capture.
    host.style.cssText = 'position:relative;min-height:100vh;max-height:none;overflow:visible;display:flex;align-items:flex-start;justify-content:center;background:var(--bg,#0a0e1a);padding:24px 12px;';
    const inner = document.createElement('div');
    inner.className = 'unified-settings-tab-panel active';
    inner.style.cssText = 'display:block;max-width:560px;width:100%;';
    host.appendChild(inner);
    document.body.appendChild(host);
    const rendered = m.renderNotificationsSettings({ isSignedIn: true });
    inner.innerHTML = rendered.html;
    rendered.attach(inner);
  });

  // authFetch retries a null Clerk token once after 2s before dispatching the
  // (stubbed) request — give the panel time to pass that window.
  await page.waitForSelector('#usNotifContent', { state: 'visible', timeout: 30_000 });
  await page.waitForSelector('.us-notif-ch-locked', { timeout: 10_000 });
  log('free ladder panel rendered with fixture data');

  await shot('free-ladder-desktop', { fullPage: true });

  // Drive the country cap: UA + TW stored, add a third (allowed), then a
  // fourth — refused where the user clicks, with the upgrade named.
  const offChip = () => page.locator('#usNotifCountryPicker .us-notif-country-chip:not(.us-notif-country-chip-on)').first();
  await offChip().click();
  await offChip().click();
  await page.waitForSelector('#usNotifCountryPicker [data-country-error]:not([hidden])', { timeout: 5_000 });
  log('fourth country refused with upgrade-named error');
  await shot('free-ladder-country-cap', { locator: page.locator('#usNotifContent') });

  await page.setViewportSize({ width: 390, height: 844 });
  await shot('free-ladder-mobile', { fullPage: true });
}
