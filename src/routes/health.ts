import { Hono } from 'hono';
import type { Env } from '../lib/env.js';

export const healthRoute = new Hono<{ Bindings: Env }>().get('/', (c) =>
  c.json({ ok: true, service: 'metrics-ingest' }),
);
