/**
 * Tier 0 daily deduplication using KV.
 *
 * The dedupe key is derived from IP + UA per UTC day. The derived hash is used
 * only as a KV key — it is never stored in D1 or returned in responses.
 *
 * Salt rotation: `sha256(TIER0_SECRET_BASE + dateUtc)` produces a daily salt
 * from a single long-lived secret, avoiding the operational overhead of
 * rotating a wrangler secret every day. The secret itself must be set via
 * `wrangler secret put TIER0_SECRET_BASE --env <staging|production>`.
 *
 * KV key format: `t0:<source>:<16-char-hex>:<YYYY-MM-DD>`
 * TTL: 36 hours (safe margin past UTC midnight).
 * Namespace: reuses RATELIMIT_KV — the `t0:` prefix avoids collisions with
 * rate-limit keys (`rl:` prefix).
 */

const DEDUPE_TTL_SECONDS = 36 * 3600;
const FALLBACK_SECRET = 'aitc-tier0-fallback-insecure';

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derives the daily-scoped dedupe key for a Tier 0 ping.
 *
 * @param secretBase - `TIER0_SECRET_BASE` wrangler secret (or fallback).
 * @param source     - e.g. `'devtools'` or `'agent-plugin'`.
 * @param ip         - Client IP from CF-Connecting-IP header.
 * @param ua         - User-Agent request header value.
 * @param dateUtc    - UTC date string, e.g. `'2026-05-18'`.
 */
export async function tier0DedupeKey(
  secretBase: string,
  source: string,
  ip: string,
  ua: string,
  dateUtc: string,
): Promise<string> {
  // Derive a per-day salt so yesterday's hashes cannot be used to identify
  // today's pings even if the derived hash leaks.
  const dailySalt = await sha256Hex(`${secretBase}|${dateUtc}`);
  const inputHex = await sha256Hex(`${dailySalt}|${ip}|${ua}`);
  const hex16 = inputHex.slice(0, 16);
  return `t0:${source}:${hex16}:${dateUtc}`;
}

/**
 * Attempts to reserve a Tier 0 dedupe slot for today.
 *
 * @returns `true`  — first ping today; caller should write to D1.
 *          `false` — duplicate; caller should respond 202 deduped, skip D1.
 */
export async function tryReserveTier0(kv: KVNamespace, key: string): Promise<boolean> {
  const existing = await kv.get(key);
  if (existing !== null) {
    return false;
  }
  await kv.put(key, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
  return true;
}

export { FALLBACK_SECRET };
