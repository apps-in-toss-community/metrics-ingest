/**
 * GET /stats — public read-only daily summary endpoint.
 *
 * Returns the last DailyStats snapshot written by the daily anti-abuse cron
 * (see src/lib/anti-abuse.ts). Serves as a lightweight alternative to a
 * full Grafana dashboard for external contributors.
 *
 * - No auth required (read-only, no PII — counts and dates only).
 * - Returns 503 if the cron has never run (no KV entry yet).
 * - Cache-Control: max-age=3600 so CDN / browsers cache for 1 h.
 */
import { Hono } from 'hono';
import type { Env } from '../lib/env.js';

export const statsRoute = new Hono<{ Bindings: Env }>().get('/', async (c) => {
  const raw = await c.env.RATELIMIT_KV.get('stats:daily:latest');
  if (!raw) {
    return c.json({ error: 'stats_not_available' }, 503);
  }
  return new Response(raw, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  });
});
