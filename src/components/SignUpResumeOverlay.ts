import type { ResumeSurface } from '@/services/sign-up-resume';

export const SIGN_UP_VERIFY_HASH = '#/verify-email-address';

export interface SignUpResumeMountProps {
  readonly routing: 'hash';
  readonly fallbackRedirectUrl: string;
}

export interface SignUpResumeOverlayDeps {
  readonly document: Document;
  readonly history: Pick<History, 'replaceState' | 'state'>;
  readonly location: Pick<Location, 'href'>;
  readonly mount: (host: HTMLDivElement, props: SignUpResumeMountProps) => void;
  readonly unmount: (host: HTMLDivElement) => void;
}

export function urlWithHash(_href: string, _hash: string): string {
  throw new Error('not implemented');
}

export function urlWithoutHash(_href: string): string {
  throw new Error('not implemented');
}

export function createSignUpResumeOverlay(_deps: Partial<SignUpResumeOverlayDeps> = {}): ResumeSurface {
  throw new Error('not implemented');
}
