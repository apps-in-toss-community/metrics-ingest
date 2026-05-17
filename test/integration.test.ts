import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { Env } from '../src/lib/env.js';
import { checkRateLimitD1, RATE_LIMIT_PER_MINUTE } from '../src/lib/ratelimit.js';
import { buildApp, FakeD1, FakeKV, makeEvent, makeTier0Event } from './helpers.js';

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
      tier: 1,
    });
  });

  it('rejects unknown source with 400 invalid_payload', async () => {
    const res = await postEvent(makeEvent({ source: 'unknown-source' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
    expect(db.rows).toHaveLength(0);
  });

  it('rejects event name not in the allowlist for the source', async () => {
    const res = await postEvent(makeEvent({ event: 'some_other_event' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('accepts console-cli cli_invoked event', async () => {
    const res = await postEvent(
      makeEvent({ source: 'console-cli', event: 'cli_invoked', meta: { command: 'app list' } }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ source: 'console-cli', event: 'cli_invoked', tier: 1 });
  });

  it('accepts console-cli cli_install event', async () => {
    const res = await postEvent(
      makeEvent({
        source: 'console-cli',
        event: 'cli_install',
        meta: { platform: 'darwin', arch: 'arm64' },
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ source: 'console-cli', event: 'cli_install', tier: 1 });
  });

  it('rejects console-cli event not in its allowlist', async () => {
    const res = await postEvent(makeEvent({ source: 'console-cli', event: 'unknown_event' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
    expect(db.rows).toHaveLength(0);
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
        tier: 1,
      },
      {
        source: 'devtools',
        event: 'panel_open',
        anon_id: 'b',
        version: '1',
        ts: now - 30 * MS_PER_DAY,
        country: null,
        meta: null,
        tier: 1,
      },
      {
        source: 'devtools',
        event: 'panel_open',
        anon_id: 'c',
        version: '1',
        ts: now,
        country: null,
        meta: null,
        tier: 1,
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

describe('D1 rate-limit backend', () => {
  it('counts correctly under sequential requests', async () => {
    const fakeDb = new FakeD1();
    const ip = '198.51.100.1';
    const now = Date.now();

    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      const result = await checkRateLimitD1(fakeDb as unknown as D1Database, ip, now);
      expect(result.ok).toBe(true);
      expect(result.remaining).toBe(RATE_LIMIT_PER_MINUTE - (i + 1));
    }

    // 61st request must be rejected.
    const overflow = await checkRateLimitD1(fakeDb as unknown as D1Database, ip, now);
    expect(overflow.ok).toBe(false);
    expect(overflow.remaining).toBe(0);
  });

  it('simulates parallel requests: all see accurate running total', async () => {
    const fakeDb = new FakeD1();
    const ip = '198.51.100.2';
    const now = Date.now();
    const PARALLEL = 100;

    // Fire all 100 calls "at once" via Promise.all — the FakeD1 increments
    // synchronously inside async wrappers, so this exercises the counting
    // path without race conditions in the fake (mirrors the D1 server-side
    // serial write behaviour).
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        checkRateLimitD1(fakeDb as unknown as D1Database, ip, now),
      ),
    );

    const accepted = results.filter((r) => r.ok).length;
    const rejected = results.filter((r) => !r.ok).length;

    // Exactly LIMIT requests should be accepted; the rest rejected.
    expect(accepted).toBe(RATE_LIMIT_PER_MINUTE);
    expect(rejected).toBe(PARALLEL - RATE_LIMIT_PER_MINUTE);
  });

  it('isolates buckets per IP', async () => {
    const fakeDb = new FakeD1();
    const now = Date.now();
    const ipA = '198.51.100.10';
    const ipB = '198.51.100.11';

    // Exhaust ipA.
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      await checkRateLimitD1(fakeDb as unknown as D1Database, ipA, now);
    }
    const aOverflow = await checkRateLimitD1(fakeDb as unknown as D1Database, ipA, now);
    const bOk = await checkRateLimitD1(fakeDb as unknown as D1Database, ipB, now);

    expect(aOverflow.ok).toBe(false);
    expect(bOk.ok).toBe(true);
  });

  it('uses D1 backend end-to-end when RATE_LIMIT_BACKEND=d1', async () => {
    const d1Db = new FakeD1();
    const kvStore = new FakeKV();
    const d1Env: Env = {
      EVENTS_DB: d1Db as unknown as D1Database,
      RATELIMIT_KV: kvStore as unknown as KVNamespace,
      RATE_LIMIT_BACKEND: 'd1',
    };
    const fetch = buildApp(d1Env);
    const ip = '198.51.100.20';

    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      const res = await fetch('http://t.local/e', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify(makeEvent()),
      });
      expect(res.status).toBe(202);
    }
    const overflow = await fetch('http://t.local/e', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify(makeEvent()),
    });
    expect(overflow.status).toBe(429);
    // KV store must be untouched when D1 backend is active.
    expect(kvStore.size).toBe(0);
  });
});

describe('Tier 0 — daily ping', () => {
  it('accepts a well-formed Tier 0 payload and writes one row', async () => {
    const res = await postEvent(makeTier0Event());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      source: 'devtools',
      event: 'daily_ping',
      anon_id: 'tier0',
      tier: 0,
    });
  });

  it('dedupes: second Tier 0 from same IP+UA returns 202 deduped:true, no extra DB row', async () => {
    const ip = '203.0.113.50';
    const first = await postEvent(makeTier0Event(), ip);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ ok: true });
    expect(db.rows).toHaveLength(1);

    const second = await postEvent(makeTier0Event(), ip);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ ok: true, deduped: true });
    // DB row count must not increase.
    expect(db.rows).toHaveLength(1);
  });

  it('rejects Tier 0 payload that includes anon_id (strict schema)', async () => {
    const res = await postEvent({
      tier: 0,
      source: 'devtools',
      version: '0.1.14',
      ts: Date.now(),
      anon_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
    expect(db.rows).toHaveLength(0);
  });

  it('rejects Tier 0 payload that includes meta (strict schema)', async () => {
    const res = await postEvent({
      tier: 0,
      source: 'devtools',
      version: '0.1.14',
      ts: Date.now(),
      meta: { foo: 'bar' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
    expect(db.rows).toHaveLength(0);
  });

  it('rejects Tier 0 payload that includes event (strict schema)', async () => {
    const res = await postEvent({
      tier: 0,
      source: 'devtools',
      version: '0.1.14',
      ts: Date.now(),
      event: 'panel_open',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
    expect(db.rows).toHaveLength(0);
  });

  it('accepts agent-plugin Tier 0 daily ping', async () => {
    const res = await postEvent(makeTier0Event({ source: 'agent-plugin' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      source: 'agent-plugin',
      event: 'daily_ping',
      anon_id: 'tier0',
      tier: 0,
    });
  });

  it('dedupes agent-plugin Tier 0 independently from devtools', async () => {
    const ip = '203.0.113.60';
    // devtools ping
    const r1 = await postEvent(makeTier0Event({ source: 'devtools' }), ip);
    expect(r1.status).toBe(202);
    expect(await r1.json()).toEqual({ ok: true });

    // agent-plugin ping — different source, different KV key, not a dupe
    const r2 = await postEvent(makeTier0Event({ source: 'agent-plugin' }), ip);
    expect(r2.status).toBe(202);
    expect(await r2.json()).toEqual({ ok: true });

    expect(db.rows).toHaveLength(2);
  });
});

describe('Tier 1 — opt-in event stream', () => {
  it('accepts agent-plugin Tier 1 skill_invoked', async () => {
    const res = await postEvent(
      makeEvent({ source: 'agent-plugin', event: 'skill_invoked', meta: { skill: 'deploy' } }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ source: 'agent-plugin', event: 'skill_invoked', tier: 1 });
  });

  it('rejects agent-plugin Tier 1 event not in allowlist', async () => {
    const res = await postEvent(makeEvent({ source: 'agent-plugin', event: 'unknown_event' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
    expect(db.rows).toHaveLength(0);
  });

  it('treats legacy payload (no tier field) as Tier 1', async () => {
    const legacyPayload = {
      source: 'devtools',
      event: 'panel_open',
      anon_id: '00000000-0000-4000-8000-000000000000',
      version: '0.1.0',
      ts: Date.now(),
    };
    const res = await postEvent(legacyPayload);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ tier: 1 });
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
