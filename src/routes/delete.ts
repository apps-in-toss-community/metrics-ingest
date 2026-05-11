import { type Context, Hono } from 'hono';
import type { Env } from '../lib/env.js';
import { checkRateLimit } from '../lib/ratelimit.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clientIp(c: Context): string {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
}

export const deleteRoute = new Hono<{ Bindings: Env }>().delete('/', async (c) => {
  const ip = clientIp(c);
  const rl = await checkRateLimit(c.env.RATELIMIT_KV, ip);
  if (!rl.ok) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const anonId = c.req.query('anon_id');
  if (!anonId || !UUID_V4.test(anonId)) {
    return c.json({ error: 'invalid_anon_id' }, 400);
  }

  const result = await c.env.EVENTS_DB.prepare('DELETE FROM events WHERE anon_id = ?')
    .bind(anonId)
    .run();

  return c.json({ ok: true, deleted: result.meta.changes ?? 0 });
});
