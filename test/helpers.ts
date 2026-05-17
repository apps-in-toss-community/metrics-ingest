import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '../src/lib/env.js';
import { deleteRoute } from '../src/routes/delete.js';
import { healthRoute } from '../src/routes/health.js';
import { ingestRoute } from '../src/routes/ingest.js';
import { statsRoute } from '../src/routes/stats.js';

// Minimal in-memory fakes for D1 and KV. We deliberately avoid pulling in
// miniflare's full runtime: the routes only exercise a handful of SQL
// statements (insert event, delete by anon_id, delete by ts cutoff,
// rate-limit upsert, daily count) and the standard KV `get`/`put` shape, so
// stubbing them keeps the test suite fast and deterministic. The real CF
// runtime is exercised by `wrangler dev` and the staging deploy — this layer
// is for the route logic.

export interface EventRow {
  source: string;
  event: string;
  anon_id: string;
  version: string;
  ts: number;
  country: string | null;
  meta: string | null;
  tier: number;
}

export interface RateLimitRow {
  ip_bucket: string;
  count: number;
  expires: number;
}

export class FakeD1 implements D1Database {
  readonly rows: EventRow[] = [];
  readonly rateLimitRows: RateLimitRow[] = [];

  prepare(sql: string): D1PreparedStatement {
    return new FakeStatement(this, sql) as unknown as D1PreparedStatement;
  }

  // Unused by the routes — stub the rest of the surface so the type matches.
  dump(): Promise<ArrayBuffer> {
    throw new Error('not implemented');
  }
  batch<T = unknown>(_: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    throw new Error('not implemented');
  }
  exec(_: string): Promise<D1ExecResult> {
    throw new Error('not implemented');
  }
  withSession(): D1DatabaseSession {
    throw new Error('not implemented');
  }
}

class FakeStatement {
  private readonly bindings: unknown[] = [];
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): FakeStatement {
    this.bindings.push(...values);
    return this;
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const normalized = this.sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('INSERT INTO events')) {
      const [source, event, anon_id, version, ts, country, meta, tier] = this.bindings as [
        string,
        string,
        string,
        string,
        number,
        string | null,
        string | null,
        number,
      ];
      this.db.rows.push({ source, event, anon_id, version, ts, country, meta, tier: tier ?? 1 });
      return { success: true, meta: { changes: 1 } };
    }
    if (normalized === 'DELETE FROM events WHERE anon_id = ?') {
      const [anonId] = this.bindings as [string];
      const before = this.db.rows.length;
      const kept = this.db.rows.filter((r) => r.anon_id !== anonId);
      this.db.rows.length = 0;
      this.db.rows.push(...kept);
      return { success: true, meta: { changes: before - this.db.rows.length } };
    }
    if (normalized === 'DELETE FROM events WHERE ts < ?') {
      const [cutoff] = this.bindings as [number];
      const before = this.db.rows.length;
      const kept = this.db.rows.filter((r) => r.ts >= cutoff);
      this.db.rows.length = 0;
      this.db.rows.push(...kept);
      return { success: true, meta: { changes: before - this.db.rows.length } };
    }
    throw new Error(`FakeD1: unhandled SQL ${normalized}`);
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    throw new Error('not implemented');
  }

  /**
   * Handles two `first()` SQL patterns:
   *
   * 1. D1 rate-limit atomic upsert (RETURNING count):
   *    INSERT INTO rate_limit ... ON CONFLICT ... RETURNING count
   *
   * 2. Anti-abuse daily count query:
   *    SELECT COUNT(*) AS cnt FROM events WHERE ts >= ? AND ts < ?
   */
  async first<T = unknown>(): Promise<T | null> {
    const normalized = this.sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('INSERT INTO rate_limit')) {
      const [ipBucket, expires] = this.bindings as [string, number];
      const existing = this.db.rateLimitRows.find((r) => r.ip_bucket === ipBucket);
      if (existing) {
        existing.count += 1;
        return { count: existing.count } as T;
      }
      const row: RateLimitRow = { ip_bucket: ipBucket, count: 1, expires };
      this.db.rateLimitRows.push(row);
      return { count: 1 } as T;
    }
    if (normalized === 'SELECT COUNT(*) AS cnt FROM events WHERE ts >= ? AND ts < ?') {
      const [from, to] = this.bindings as [number, number];
      const cnt = this.db.rows.filter((r) => r.ts >= from && r.ts < to).length;
      return { cnt } as T;
    }
    throw new Error(`FakeD1.first: unhandled SQL ${normalized}`);
  }

  async raw<T = unknown>(): Promise<T[]> {
    throw new Error('not implemented');
  }
}

export class FakeKV {
  private readonly store = new Map<string, string>();

  get size(): number {
    return this.store.size;
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export function buildApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
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
  app.route('/e', ingestRoute);
  app.route('/e', deleteRoute);
  app.route('/stats', statsRoute);
  // Inject env on every request — Hono's app.request doesn't expose a
  // dispatcher with bindings, so we attach via fetch wrapper.
  return async (input: string, init?: RequestInit) => app.fetch(new Request(input, init), env);
}

export function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tier: 1,
    source: 'devtools',
    event: 'panel_open',
    anon_id: '00000000-0000-4000-8000-000000000000',
    version: '0.1.14',
    ts: Date.now(),
    ...overrides,
  };
}

export function makeTier0Event(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tier: 0,
    source: 'devtools',
    version: '0.1.14',
    ts: Date.now(),
    ...overrides,
  };
}
