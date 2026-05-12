export interface Env {
  EVENTS_DB: D1Database;
  RATELIMIT_KV: KVNamespace;
  // ts skew tolerance window (ms). Payloads with |ts - now| > this are rejected.
  TS_SKEW_MS?: string;
  // Days of retention. cron deletes rows older than this.
  RETENTION_DAYS?: string;
  // Rate-limit backend selector. 'kv' (default) uses Workers KV (eventual
  // consistency, ~1s stale reads possible). 'd1' uses D1 atomic UPSERT
  // (strong consistency, slightly higher latency). Set to 'd1' in staging to
  // validate before switching production.
  RATE_LIMIT_BACKEND?: 'kv' | 'd1';
  // Daily row-count threshold above which the anti-abuse check fires an alert.
  DAILY_ROW_THRESHOLD?: string;
  // Optional webhook URL the anti-abuse check POSTs to when the threshold trips.
  ABUSE_ALERT_WEBHOOK?: string;
}
