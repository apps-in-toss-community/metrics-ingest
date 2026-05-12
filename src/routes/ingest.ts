import { type Context, Hono } from 'hono';
import type { Env } from '../lib/env.js';
import { checkRateLimit } from '../lib/ratelimit.js';
import { eventSchema } from '../lib/schema.js';

const DEFAULT_TS_SKEW_MS = 24 * 60 * 60 * 1000;

function clientIp(c: Context): string {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
}

function country(c: Context): string | null {
  // Hono types Cloudflare's `request.cf` loosely; cast narrowly.
  const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf;
  return cf?.country ?? null;
}

export const ingestRoute = new Hono<{ Bindings: Env }>().post('/', async (c) => {
  const ip = clientIp(c);
  const rl = await checkRateLimit(
    c.env.RATELIMIT_KV,
    ip,
    undefined,
    c.env.EVENTS_DB,
    c.env.RATE_LIMIT_BACKEND,
  );
  if (!rl.ok) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload' }, 400);
  }

  const skew = Number.parseInt(c.env.TS_SKEW_MS ?? String(DEFAULT_TS_SKEW_MS), 10);
  const now = Date.now();
  if (Math.abs(parsed.data.ts - now) > skew) {
    return c.json({ error: 'ts_out_of_range' }, 400);
  }

  const { source, event, anon_id, version, ts, meta } = parsed.data;

  await c.env.EVENTS_DB.prepare(
    'INSERT INTO events (source, event, anon_id, version, ts, country, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(source, event, anon_id, version, ts, country(c), meta ? JSON.stringify(meta) : null)
    .run();

  return c.json({ ok: true }, 202);
});
