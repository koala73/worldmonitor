import { afterEach, describe, expect, it, vi } from 'vitest';
import { dashboardInteractionTarget, observeDashboardFirstInteraction } from '@/components/dashboard-interaction-analytics';
import * as analytics from '@/services/analytics';

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('dashboard first interaction', () => {
  it.each([
    ['<div id="mapSection"><canvas></canvas></div>', 'map'],
    ['<div class="panel" data-panel="news"><button></button></div>', 'panel'],
    ['<div id="mapSection"><div class="panel" data-panel="live-news"><button></button></div></div>', 'live-news'],
    ['<a class="variant-option"><span></span></a>', 'switcher'],
    ['<button id="searchBtn"><span></span></button>', 'search'],
    ['<button data-mobile-tab="search"><span></span></button>', 'search'],
    ['<button class="auth-signin-btn"><span></span></button>', 'signin'],
    ['<div class="panel" data-panel="news"><a class="pro-banner-cta"><span></span></a></div>', 'upgrade'],
    ['<button id="unifiedSettingsBtn"><span></span></button>', undefined],
  ])('classifies nested controls: %s', (html, expected) => {
    document.body.innerHTML = html;
    expect(dashboardInteractionTarget(document.body.querySelector('span, canvas, button')!)).toBe(expected);
  });

  it('does not emit on installation, hover, or synthetic boot clicks', () => {
    const track = vi.spyOn(analytics, 'trackDashboardFirstInteraction');
    document.body.innerHTML = '<div id="app"><div id="mapSection"><button></button></div></div>';
    const stop = observeDashboardFirstInteraction(document.getElementById('app')!);
    document.querySelector('button')!.click();
    document.querySelector('button')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(track).not.toHaveBeenCalled();
    stop();
  });
});
