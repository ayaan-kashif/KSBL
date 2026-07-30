/**
 * src/lib/vouchers.ts
 *
 * Shared server-side helpers for the HORECA voucher routes. Same convention as
 * src/lib/customer.ts — Postgres is reached over Supabase REST, never Prisma
 * Client at runtime.
 */

/** Ambiguous glyphs removed: staff read these aloud and type them by hand, so
 *  O/0 and I/1 are the difference between a redemption and a support call. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export function generateVoucherCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

export function restHeaders(key: string, extra?: Record<string, string>): HeadersInit {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

/** Voucher.status is never written as 'expired' — the expiry cron is out of
 *  scope (TODO-horeca.md) — so expiry is always derived from expires_at. */
export function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}
