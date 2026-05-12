-- Per-IP rate limit counter table.
--
-- Each row represents a one-minute bucket for a single IP. The primary key
-- (`ip_bucket`) is the string `<ip>:<minute-epoch>` which makes atomic UPSERT
-- safe: D1's serialised write model ensures only one writer wins per key.
--
-- `count`   : requests accepted in this bucket so far.
-- `expires` : Unix epoch seconds after which this row can be swept. The daily
--             cron in index.ts already handles events; rate-limit rows get
--             their own lightweight check (they expire quickly so accumulation
--             is not a concern — the sweep is a belt-and-braces measure).

CREATE TABLE IF NOT EXISTS rate_limit (
  ip_bucket TEXT PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 0,
  expires   INTEGER NOT NULL
);
