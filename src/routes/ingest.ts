import { type Context, Hono } from 'hono';
import { FALLBACK_SECRET, tier0DedupeKey, tryReserveTier0 } from '../lib/dedupe.js';
import type { Env } from '../lib/env.js';
import { checkRateLimit } from '../lib/ratelimit.js';
import { eventSchema } from '../lib/schema.js';

const DEFAULT_TS_SKEW_MS = 24 * 60 * 60 * 1000;

function clientIp(c: Context): string {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
}

function clientUa(c: Context): string {
  return c.req.header('User-Agent') ?? 'unknown';
}

function country(c: Context): string | null {
  // Hono types Cloudflare's `request.cf` loosely; cast narrowly.
  const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf;
  return cf?.country ?? null;
}

function utcDateString(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // 'YYYY-MM-DD'
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

  // Backward compat: legacy payloads without a `tier` field are treated as Tier 1.
  if (typeof body === 'object' && body !== null && !('tier' in body)) {
    (body as Record<string, unknown>).tier = 1;
  }

  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload' }, 400);
  }

  const now = Date.now();

  // ---------------------------------------------------------------------------
  // Tier 0 — anonymous daily ping
  // ---------------------------------------------------------------------------
  if (parsed.data.tier === 0) {
    const { source, version, ts, platform } = parsed.data;

    const skew = Number.parseInt(c.env.TS_SKEW_MS ?? String(DEFAULT_TS_SKEW_MS), 10);
    if (Math.abs(ts - now) > skew) {
      return c.json({ error: 'ts_out_of_range' }, 400);
    }

    const dateUtc = utcDateString(now);
    const secretBase = c.env.TIER0_SECRET_BASE ?? FALLBACK_SECRET;
    const ua = clientUa(c);
    const dedupeKey = await tier0DedupeKey(secretBase, source, ip, ua, dateUtc);
    const reserved = await tryReserveTier0(c.env.RATELIMIT_KV, dedupeKey);

    if (!reserved) {
      // Already seen this client today — silent drop, no D1 write.
      return c.json({ ok: true, deduped: true }, 202);
    }

    const countryCode = country(c);

    await c.env.EVENTS_DB.prepare(
      'INSERT INTO events (source, event, anon_id, version, ts, country, meta, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        source,
        'daily_ping',
        'tier0',
        version,
        ts,
        countryCode,
        platform ? JSON.stringify({ platform }) : null,
        0,
      )
      .run();

    return c.json({ ok: true }, 202);
  }

  // ---------------------------------------------------------------------------
  // Tier 1 — detailed opt-in event stream
  // ---------------------------------------------------------------------------
  const skew = Number.parseInt(c.env.TS_SKEW_MS ?? String(DEFAULT_TS_SKEW_MS), 10);
  if (Math.abs(parsed.data.ts - now) > skew) {
    return c.json({ error: 'ts_out_of_range' }, 400);
  }

  const { source, event, anon_id, version, ts, meta } = parsed.data;

  await c.env.EVENTS_DB.prepare(
    'INSERT INTO events (source, event, anon_id, version, ts, country, meta, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(source, event, anon_id, version, ts, country(c), meta ? JSON.stringify(meta) : null, 1)
    .run();

  return c.json({ ok: true }, 202);
});
