// @vitest-environment node

/**
 * #7275 — router.allowedMethods() advertises HEAD for every GET route, but
 * match() used the exact method key and never bound HEAD to the GET handler.
 */

import { describe, test, expect, vi } from 'vitest';
import { createRouter } from '../router';

const STATIC_GET = '/api/natural/v1/list-natural-events';
const DYNAMIC_GET = '/api/v2/shipping/webhooks/{subscriberId}';
const DYNAMIC_URL = 'https://worldmonitor.app/api/v2/shipping/webhooks/sub-1';
const POST_ONLY = '/api/leads/v1/submit-contact';

function handler(label: string) {
  return vi.fn(async () => new Response(label, { status: 200 }));
}

describe('router HEAD→GET fallback (#7275)', () => {
  test('a static GET route matches HEAD and still advertises HEAD', () => {
    const getHandler = handler('static-get');
    const router = createRouter([{ method: 'GET', path: STATIC_GET, handler: getHandler }]);

    const matched = router.match(new Request(`https://worldmonitor.app${STATIC_GET}`, { method: 'HEAD' }));
    expect(matched).toBe(getHandler);
    expect(router.allowedMethods(STATIC_GET)).toEqual(['GET', 'HEAD']);
  });

  test('a dynamic GET route matches HEAD and still advertises HEAD', () => {
    const getHandler = handler('dynamic-get');
    const router = createRouter([{ method: 'GET', path: DYNAMIC_GET, handler: getHandler }]);

    const matched = router.match(new Request(DYNAMIC_URL, { method: 'HEAD' }));
    expect(matched).toBe(getHandler);
    expect(router.allowedMethods('/api/v2/shipping/webhooks/sub-1')).toEqual(['GET', 'HEAD']);
  });

  test('an explicit HEAD handler wins over the GET fallback', () => {
    const getHandler = handler('get');
    const headHandler = handler('head');
    const router = createRouter([
      { method: 'GET', path: STATIC_GET, handler: getHandler },
      { method: 'HEAD', path: STATIC_GET, handler: headHandler },
    ]);

    expect(router.match(new Request(`https://worldmonitor.app${STATIC_GET}`, { method: 'HEAD' }))).toBe(headHandler);
    expect(router.match(new Request(`https://worldmonitor.app${STATIC_GET}`, { method: 'GET' }))).toBe(getHandler);
  });

  test('a POST-only route does not match HEAD and does not advertise HEAD', () => {
    const postHandler = handler('post');
    const router = createRouter([{ method: 'POST', path: POST_ONLY, handler: postHandler }]);

    expect(router.match(new Request(`https://worldmonitor.app${POST_ONLY}`, { method: 'HEAD' }))).toBeNull();
    expect(router.allowedMethods(POST_ONLY)).toEqual(['POST']);
  });

  test('GET matching is unchanged', () => {
    const getHandler = handler('get');
    const router = createRouter([{ method: 'GET', path: STATIC_GET, handler: getHandler }]);

    expect(router.match(new Request(`https://worldmonitor.app${STATIC_GET}`, { method: 'GET' }))).toBe(getHandler);
  });
});
