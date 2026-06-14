import type { Clerk } from '@clerk/clerk-js';

export type LoadedClerk = InstanceType<typeof Clerk>;

const MONO_FONT = "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace";

let clerk: LoadedClerk | null = null;
let clerkLoadPromise: Promise<LoadedClerk> | null = null;

export async function ensureClerk(): Promise<LoadedClerk> {
  if (clerk) return clerk;
  if (clerkLoadPromise) return clerkLoadPromise;
  clerkLoadPromise = loadClerk().catch((err) => {
    clerkLoadPromise = null;
    throw err;
  });
  return clerkLoadPromise;
}

async function loadClerk(): Promise<LoadedClerk> {
  const { Clerk: C } = await import('@clerk/clerk-js');
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!key) throw new Error('VITE_CLERK_PUBLISHABLE_KEY not set');
  const instance = new C(key);
  await instance.load({
    appearance: {
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

  // Only publish the instance after load() succeeds, so a failed load does not
  // wedge ensureClerk()'s retry path.
  clerk = instance;
  return clerk;
}
