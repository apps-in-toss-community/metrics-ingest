/**
 * Per-IP rate limit backed by Workers KV.
 *
 * Bucket strategy: key = `rl:<ip>:<minute-epoch>`, value = count. Each minute
 * gets its own key with TTL 60s, so cleanup is automatic and the limit is a
 * sliding window approximation. KV writes are eventually consistent — bursts
 * within ~1s may exceed the limit slightly, which is acceptable for abuse
 * prevention (not for billing).
 */

const LIMIT = 60;
const BUCKET_SECONDS = 60;

export async function checkRateLimit(
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

export const RATE_LIMIT_PER_MINUTE = LIMIT;
