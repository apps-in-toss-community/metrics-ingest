import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { DEFAULT_DAILY_THRESHOLD, runAntiAbuseCheck } from './lib/anti-abuse.js';
import type { Env } from './lib/env.js';
import { deleteRoute } from './routes/delete.js';
import { healthRoute } from './routes/health.js';
import { ingestRoute } from './routes/ingest.js';
import { statsRoute } from './routes/stats.js';

const DEFAULT_RETENTION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const app = new Hono<{ Bindings: Env }>();

// devtools (and future tools) run in arbitrary user origins — every
// mini-app dev's localhost / production host. We don't gate by Origin
// because the auth model is per-anon_id, not per-origin.
app.use(
  '/e',
  cors({
    origin: '*',
    allowMethods: ['POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type'],
    maxAge: 86400,
  }),
);

app.route('/health', healthRoute);
// POST /e and DELETE /e share the same path; Hono dispatches by method.
app.route('/e', ingestRoute);
app.route('/e', deleteRoute);
// Public read-only daily summary (populated by the daily cron).
app.route('/stats', statsRoute);

export default {
  fetch: app.fetch,
  // Daily cron handler — declared in wrangler.toml [triggers].
  // Runs at 03:00 UTC. Two tasks piggyback here:
  //   1. Retention sweep — delete events older than RETENTION_DAYS.
  //   2. Anti-abuse check — count today's rows, store history, alert if needed.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const retentionDays = Number.parseInt(env.RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS), 10);
    const cutoff = Date.now() - retentionDays * MS_PER_DAY;

    const threshold = Number.parseInt(
      env.DAILY_ROW_THRESHOLD ?? String(DEFAULT_DAILY_THRESHOLD),
      10,
    );

    ctx.waitUntil(
      Promise.all([
        env.EVENTS_DB.prepare('DELETE FROM events WHERE ts < ?').bind(cutoff).run(),
        runAntiAbuseCheck(env.EVENTS_DB, env.RATELIMIT_KV, threshold, env.ABUSE_ALERT_WEBHOOK),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;
