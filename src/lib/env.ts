export interface Env {
  EVENTS_DB: D1Database;
  RATELIMIT_KV: KVNamespace;
  // ts skew tolerance window (ms). Payloads with |ts - now| > this are rejected.
  TS_SKEW_MS?: string;
  // Days of retention. cron deletes rows older than this.
  RETENTION_DAYS?: string;
}
