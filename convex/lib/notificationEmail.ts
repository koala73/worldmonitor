import { ConvexError } from "convex/values";

/** Only the authenticated identity or the server's Clerk lookup supplies proof. */
export function requireVerifiedAccountEmail(requested: string | undefined, verifiedEmail: string | undefined): string {
  const email = verifiedEmail?.trim();
  if (!email || typeof requested !== "string" || requested.trim().toLowerCase() !== email.toLowerCase()) {
    throw new ConvexError({ code: "EMAIL_OWNERSHIP_REQUIRED", message: "Connect your verified account email to receive notifications." });
  }
  return email;
}

export async function lookupVerifiedAccountEmail(userId: string, options: { allowMissingUser?: boolean } = {}): Promise<string | undefined> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error("EMAIL_VERIFICATION_UNAVAILABLE");
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${secret}`, "User-Agent": "worldmonitor-convex/1.0" },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404 && options.allowMissingUser) return undefined;
  if (!response.ok) throw new Error("EMAIL_VERIFICATION_UNAVAILABLE");
  const user = await response.json() as {
    id?: string;
    primary_email_address_id?: string;
    email_addresses?: Array<{ id: string; email_address: string; verification?: { status?: string } }>;
  };
  if (user.id !== userId) throw new Error("EMAIL_VERIFICATION_UNAVAILABLE");
  return user.email_addresses?.find(address =>
    address.id === user.primary_email_address_id && address.verification?.status === "verified",
  )?.email_address;
}
