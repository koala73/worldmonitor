import type { Clerk } from '@clerk/clerk-js';
import { protectClerkDomFromTranslators } from './clerk-dom-safety';
import { EULA_PATH, PRIVACY_PATH } from '../../../shared/legal';

export type LoadedClerk = InstanceType<typeof Clerk>;

const MONO_FONT = "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace";

let clerk: LoadedClerk | null = null;
let clerkLoadPromise: Promise<LoadedClerk> | null = null;
let scheduledClerkLoadPromise: Promise<LoadedClerk> | null = null;
const clerkLoadSubscribers = new Set<(clerk: LoadedClerk) => void>();

export async function ensureClerk(): Promise<LoadedClerk> {
  if (clerk) return clerk;
  if (clerkLoadPromise) return clerkLoadPromise;
  clerkLoadPromise = loadClerk().catch((err) => {
    clerkLoadPromise = null;
    throw err;
  });
  return clerkLoadPromise;
}

export function scheduleClerkLoad(): Promise<LoadedClerk> | null {
  if (clerk) return Promise.resolve(clerk);
  if (clerkLoadPromise) return clerkLoadPromise;
  if (scheduledClerkLoadPromise) return scheduledClerkLoadPromise;
  if (typeof window === 'undefined') return null;
  if (!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) return null;

  scheduledClerkLoadPromise = new Promise((resolve, reject) => {
    const startLoad = (): void => {
      ensureClerk().then((loadedClerk) => {
        scheduledClerkLoadPromise = null;
        resolve(loadedClerk);
      }, (err) => {
        scheduledClerkLoadPromise = null;
        reject(err);
      });
    };

    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(startLoad, { timeout: 4000 });
      return;
    }

    if (document.readyState === 'complete') {
      setTimeout(startLoad, 0);
    } else {
      window.addEventListener('load', () => setTimeout(startLoad, 0), { once: true });
    }
  });

  return scheduledClerkLoadPromise;
}

export function subscribeClerkLoaded(cb: (clerk: LoadedClerk) => void): () => void {
  clerkLoadSubscribers.add(cb);
  if (clerk) cb(clerk);
  return () => {
    clerkLoadSubscribers.delete(cb);
  };
}

function publishClerkLoaded(instance: LoadedClerk): void {
  for (const cb of clerkLoadSubscribers) {
    try {
      cb(instance);
    } catch (err) {
      console.error('[auth] Clerk load subscriber threw:', err);
    }
  }
}

async function loadClerk(): Promise<LoadedClerk> {
  const { Clerk: C } = await import('@clerk/clerk-js');
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!key) throw new Error('VITE_CLERK_PUBLISHABLE_KEY not set');
  const instance = new C(key);
  const stopTranslatorProtection = protectClerkDomFromTranslators();
  try {
    await instance.load({
      appearance: {
        // Sign-up carries the same assent line as checkout (#6976): Clerk renders
        // Terms/Privacy links in the auth card footer when these are set, so the
        // documents are presented at account creation, not only at purchase.
        layout: {
          // The EULA, not the Terms: sign-up should show the document that
          // states what the account is licensed to do (#6983). Clerk exposes one
          // "terms" slot; the EULA links the Terms from its section 2.
          termsPageUrl: EULA_PATH,
          privacyPageUrl: PRIVACY_PATH,
        },
        variables: {
          colorBackground: '#0f0f0f',
          colorInputBackground: '#141414',
          colorInputText: '#e8e8e8',
          colorText: '#e8e8e8',
          colorTextSecondary: '#aaaaaa',
          colorPrimary: '#44ff88',
          colorNeutral: '#e8e8e8',
          colorDanger: '#ff4444',
          borderRadius: '4px',
          fontFamily: MONO_FONT,
          fontFamilyButtons: MONO_FONT,
        },
        elements: {
          card: { backgroundColor: '#111111', border: '1px solid #2a2a2a', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' },
          formButtonPrimary: { color: '#000000', fontWeight: '600' },
          footerActionLink: { color: '#44ff88' },
          socialButtonsBlockButton: { borderColor: '#2a2a2a', color: '#e8e8e8', backgroundColor: '#141414' },
        },
      },
    });
  } catch (error) {
    stopTranslatorProtection();
    throw error;
  }

  // Only publish the instance after load() succeeds, so a failed load does not
  // wedge ensureClerk()'s retry path.
  clerk = instance;
  publishClerkLoaded(clerk);
  return clerk;
}
