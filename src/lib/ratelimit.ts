/**
 * Per-IP rate limit with two backends, selected at runtime via env var
 * RATE_LIMIT_BACKEND ('kv' | 'd1', default 'kv').
 *
 * ### KV backend (default)
 * key = `rl:<ip>:<minute-epoch>`, value = count. TTL 120s for auto-cleanup.
 * Eventually consistent — within ~1s stale reads are possible, so parallel
 * bursts can exceed the limit slightly. Acceptable for opt-in telemetry.
 *
 * ### D1 backend
 * Atomic `INSERT OR REPLACE` with per-row `count` in the `rate_limit` table.
 * D1 serialises writes per row (single-writer model), so concurrent requests
 * for the same IP+bucket see the true running total. Latency is ~1–2 ms
 * higher than KV. Enable in staging via RATE_LIMIT_BACKEND=d1 before
 * switching production.
 */

const LIMIT = 60;
const BUCKET_SECONDS = 60;

// ---------------------------------------------------------------------------
// KV backend
// ---------------------------------------------------------------------------

export async function checkRateLimitKV(
  kv: KVNamespace,
  ip: string,
  now: number = Date.now(),
): Promise<{ ok: boolean; remaining: number }> {
  const bucket = Math.floor(now / 1000 / BUCKET_SECONDS);
  const key = `rl:${ip}:${bucket}`;
  const current = await kv.get(key);
  const count = current ? Number.parseInt(current, 10) : 0;
  if (count >= LIMIT) {
    return { ok: false, remaining: 0 };
  }
  await kv.put(key, String(count + 1), { expirationTtl: BUCKET_SECONDS * 2 });
  return { ok: true, remaining: LIMIT - count - 1 };
}

// ---------------------------------------------------------------------------
// D1 backend
// ---------------------------------------------------------------------------

/**
 * Atomically increments the counter for `<ip>:<bucket>` in the `rate_limit`
 * D1 table and returns whether the request is within the limit.
 *
 * Uses `INSERT INTO rate_limit … ON CONFLICT(ip_bucket) DO UPDATE SET count =
 * count + 1` so the increment happens in a single serialised write — no
 * read-modify-write race.
 */
export async function checkRateLimitD1(
  db: D1Database,
  ip: string,
  now: number = Date.now(),
): Promise<{ ok: boolean; remaining: number }> {
  const bucket = Math.floor(now / 1000 / BUCKET_SECONDS);
  const ipBucket = `${ip}:${bucket}`;
  // expires = end of the next bucket so rows linger at most 2 minutes.
  const expires = (bucket + 2) * BUCKET_SECONDS;

  // Atomic upsert: insert with count=1 on first hit; on conflict increment.
  // The returned `count` is the value *after* this request.
  const result = await db
    .prepare(
      `INSERT INTO rate_limit (ip_bucket, count, expires)
       VALUES (?, 1, ?)
       ON CONFLICT(ip_bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(ipBucket, expires)
    .first<{ count: number }>();

  const count = result?.count ?? 1;
  if (count > LIMIT) {
    return { ok: false, remaining: 0 };
  }
  return { ok: true, remaining: LIMIT - count };
}

// ---------------------------------------------------------------------------
// Unified facade — called by the ingest route
// ---------------------------------------------------------------------------

export async function checkRateLimit(
  kv: KVNamespace,
  ip: string,
  now?: number,
  db?: D1Database,
  backend?: string,
): Promise<{ ok: boolean; remaining: number }> {
  if (backend === 'd1' && db !== undefined) {
    return checkRateLimitD1(db, ip, now);
  }
  return checkRateLimitKV(kv, ip, now);
}

export const RATE_LIMIT_PER_MINUTE = LIMIT;
