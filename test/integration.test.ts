import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { Env } from '../src/lib/env.js';
import { RATE_LIMIT_PER_MINUTE } from '../src/lib/ratelimit.js';
import { buildApp, FakeD1, FakeKV, makeEvent } from './helpers.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

let db: FakeD1;
let kv: FakeKV;
let env: Env;
let fetchApp: (input: string, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  db = new FakeD1();
  kv = new FakeKV();
  env = {
    EVENTS_DB: db,
    RATELIMIT_KV: kv as unknown as KVNamespace,
  };
  fetchApp = buildApp(env);
});

function postEvent(body: unknown, ip = '203.0.113.1') {
  return fetchApp('http://t.local/e', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

describe('POST /e', () => {
  it('accepts a well-formed event and writes one row', async () => {
    const res = await postEvent(makeEvent());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      source: 'devtools',
      event: 'panel_open',
      anon_id: '00000000-0000-4000-8000-000000000000',
    });
  });

  it('rejects unknown source with 400 invalid_payload', async () => {
    const res = await postEvent(makeEvent({ source: 'console-cli' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
    expect(db.rows).toHaveLength(0);
  });

  it('rejects event name not in the allowlist for the source', async () => {
    const res = await postEvent(makeEvent({ event: 'some_other_event' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('rejects meta payloads exceeding 256 bytes', async () => {
    const bigString = 'x'.repeat(260);
    const res = await postEvent(makeEvent({ meta: { tab: bigString } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('rejects ts outside the 24h skew window', async () => {
    const longAgo = Date.now() - 10 * MS_PER_DAY;
    const res = await postEvent(makeEvent({ ts: longAgo }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'ts_out_of_range' });
  });

  it('rejects malformed JSON with 400 invalid_json', async () => {
    const res = await fetchApp('http://t.local/e', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.2' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 429 once the per-IP limit is exceeded', async () => {
    const ip = '203.0.113.99';
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      const ok = await postEvent(makeEvent(), ip);
      expect(ok.status).toBe(202);
    }
    const overflow = await postEvent(makeEvent(), ip);
    expect(overflow.status).toBe(429);
    expect(await overflow.json()).toEqual({ error: 'rate_limited' });
  });

  it('isolates rate-limit buckets per IP', async () => {
    const a = '203.0.113.10';
    const b = '203.0.113.11';
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      await postEvent(makeEvent(), a);
    }
    const aOverflow = await postEvent(makeEvent(), a);
    const bOk = await postEvent(makeEvent(), b);
    expect(aOverflow.status).toBe(429);
    expect(bOk.status).toBe(202);
  });
});

describe('DELETE /e', () => {
  it('removes all rows for the given anon_id and returns the count', async () => {
    const anon = '11111111-1111-4111-8111-111111111111';
    const other = '22222222-2222-4222-8222-222222222222';
    await postEvent(makeEvent({ anon_id: anon }));
    await postEvent(makeEvent({ anon_id: anon, event: 'tab_view' }));
    await postEvent(makeEvent({ anon_id: other }));
    expect(db.rows).toHaveLength(3);

    const res = await fetchApp(`http://t.local/e?anon_id=${anon}`, {
      method: 'DELETE',
      headers: { 'CF-Connecting-IP': '203.0.113.5' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 2 });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]?.anon_id).toBe(other);
  });

  it('rejects malformed anon_id with 400', async () => {
    const res = await fetchApp('http://t.local/e?anon_id=not-a-uuid', {
      method: 'DELETE',
      headers: { 'CF-Connecting-IP': '203.0.113.5' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_anon_id' });
  });

  it('rejects missing anon_id with 400', async () => {
    const res = await fetchApp('http://t.local/e', {
      method: 'DELETE',
      headers: { 'CF-Connecting-IP': '203.0.113.5' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_anon_id' });
  });
});

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const res = await fetchApp('http://t.local/health');
    expect(res.status).toBe(200);
  });
});

describe('scheduled (cron retention sweep)', () => {
  it('deletes rows older than RETENTION_DAYS and keeps the rest', async () => {
    const now = Date.now();
    db.rows.push(
      {
        source: 'devtools',
        event: 'panel_open',
        anon_id: 'a',
        version: '1',
        ts: now - 100 * MS_PER_DAY,
        country: null,
        meta: null,
      },
      {
        source: 'devtools',
        event: 'panel_open',
        anon_id: 'b',
        version: '1',
        ts: now - 30 * MS_PER_DAY,
        country: null,
        meta: null,
      },
      {
        source: 'devtools',
        event: 'panel_open',
        anon_id: 'c',
        version: '1',
        ts: now,
        country: null,
        meta: null,
      },
    );

    const pending: Promise<unknown>[] = [];
    const ctx: ExecutionContext = {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
      props: {},
    };

    const scheduledEnv: Env = { ...env, RETENTION_DAYS: '90' };
    await worker.scheduled?.({} as ScheduledController, scheduledEnv, ctx);
    await Promise.all(pending);

    expect(db.rows).toHaveLength(2);
    expect(db.rows.map((r) => r.anon_id).sort()).toEqual(['b', 'c']);
  });
});

describe('CORS', () => {
  it('responds to OPTIONS preflight on /e with permissive headers', async () => {
    const res = await fetchApp('http://t.local/e', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://app.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const allowMethods = res.headers.get('access-control-allow-methods') ?? '';
    expect(allowMethods).toContain('POST');
    expect(allowMethods).toContain('DELETE');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('echoes Access-Control-Allow-Origin on POST /e', async () => {
    const res = await postEvent(makeEvent());
    expect(res.status).toBe(202);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('echoes Access-Control-Allow-Origin on DELETE /e', async () => {
    const res = await fetchApp('http://t.local/e?anon_id=00000000-0000-4000-8000-000000000000', {
      method: 'DELETE',
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
