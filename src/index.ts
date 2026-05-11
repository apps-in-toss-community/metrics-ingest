import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './lib/env.js';
import { deleteRoute } from './routes/delete.js';
import { healthRoute } from './routes/health.js';
import { ingestRoute } from './routes/ingest.js';

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

export default {
  fetch: app.fetch,
  // Daily cron handler — declared in wrangler.toml [triggers].
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const retentionDays = Number.parseInt(env.RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS), 10);
    const cutoff = Date.now() - retentionDays * MS_PER_DAY;
    ctx.waitUntil(env.EVENTS_DB.prepare('DELETE FROM events WHERE ts < ?').bind(cutoff).run());
  },
} satisfies ExportedHandler<Env>;
