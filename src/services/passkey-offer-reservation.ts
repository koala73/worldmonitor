import { getClerkToken } from '@/services/clerk';
import { createTimeoutSignal } from '@/services/timeout-signal';

export type AccountOfferReservation = 'reserved' | 'cap-reached' | 'unavailable';

const RESERVATION_TIMEOUT_MS = 20_000;

/** Claim one lifetime account slot immediately before the offer mounts. */
export async function reserveAccountOffer(): Promise<AccountOfferReservation> {
  let token: string | null;
  try {
    token = await getClerkToken();
  } catch {
    return 'unavailable';
  }
  if (!token) return 'unavailable';

  try {
    const response = await fetch('/api/user/passkey-offer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: createTimeoutSignal(RESERVATION_TIMEOUT_MS),
    });
    if (!response.ok) return 'unavailable';
    const body = (await response.json()) as { status?: unknown };
    if (body.status === 'reserved' || body.status === 'cap-reached') return body.status;
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}
