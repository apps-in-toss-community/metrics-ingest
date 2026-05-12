/**
 * Anti-abuse: daily row count monitoring.
 *
 * Called from the daily cron (piggyback on the 03:00 UTC retention sweep).
 * Queries the `events` table for today's row count, stores it in KV as part of
 * a 14-day rolling history, and emits a console.error + optional webhook POST
 * if the count exceeds the configured threshold.
 *
 * KV key: `abuse:history` → JSON DailyEntry[] (last 14 entries, newest first)
 * KV key: `stats:daily:latest` → JSON DailyStats (read by GET /stats)
 */

export const DEFAULT_DAILY_THRESHOLD = 5_000;
const HISTORY_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const S_PER_DAY = 24 * 60 * 60;

export interface DailyEntry {
  date: string; // YYYY-MM-DD UTC
  count: number;
}

export interface DailyStats {
  /** UTC date this summary covers (YYYY-MM-DD). */
  date: string;
  /** Total events inserted on that date. */
  count: number;
  /** Whether the count exceeded the configured threshold. */
  threshold_exceeded: boolean;
  /** The threshold in effect when this summary was computed. */
  threshold: number;
  /** Rolling 14-day history (newest first). */
  history: DailyEntry[];
  /** ISO timestamp when this summary was generated. */
  generated_at: string;
}

/**
 * Formats a Unix-ms timestamp as a YYYY-MM-DD UTC date string.
 */
export function utcDateString(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Queries D1 for the number of events inserted today (UTC), saves the result
 * to KV history, and fires an alert if the threshold is exceeded.
 *
 * @param db          D1Database binding
 * @param kv          KVNamespace binding (RATELIMIT_KV, prefix-namespaced)
 * @param threshold   Daily row count threshold (default: DEFAULT_DAILY_THRESHOLD)
 * @param webhookUrl  Optional webhook URL for fire-and-forget alert POST
 * @param nowMs       Current time in ms (injectable for testing)
 */
export async function runAntiAbuseCheck(
  db: D1Database,
  kv: KVNamespace,
  threshold: number = DEFAULT_DAILY_THRESHOLD,
  webhookUrl?: string,
  nowMs: number = Date.now(),
): Promise<DailyStats> {
  const date = utcDateString(nowMs);
  const dayStart = new Date(`${date}T00:00:00.000Z`).getTime();
  const dayEnd = dayStart + MS_PER_DAY;

  // Count events inserted today (UTC).
  const row = await db
    .prepare('SELECT COUNT(*) AS cnt FROM events WHERE ts >= ? AND ts < ?')
    .bind(dayStart, dayEnd)
    .first<{ cnt: number }>();
  const count = row?.cnt ?? 0;

  // Load existing history from KV.
  const historyRaw = await kv.get('abuse:history');
  let history: DailyEntry[] = historyRaw ? (JSON.parse(historyRaw) as DailyEntry[]) : [];

  // Remove stale (> 14 days) and any existing entry for today.
  const cutoffDate = utcDateString(nowMs - HISTORY_DAYS * MS_PER_DAY);
  history = history.filter((e) => e.date > cutoffDate && e.date !== date);

  // Prepend today's entry, keep at most HISTORY_DAYS.
  history = [{ date, count }, ...history].slice(0, HISTORY_DAYS);

  // Persist updated history (TTL: 16 days to survive clock drift).
  await kv.put('abuse:history', JSON.stringify(history), {
    expirationTtl: (HISTORY_DAYS + 2) * S_PER_DAY,
  });

  const threshold_exceeded = count > threshold;

  const stats: DailyStats = {
    date,
    count,
    threshold_exceeded,
    threshold,
    history,
    generated_at: new Date(nowMs).toISOString(),
  };

  // Store public-readable stats snapshot (TTL: 25h so it stays fresh).
  await kv.put('stats:daily:latest', JSON.stringify(stats), {
    expirationTtl: 25 * 60 * 60,
  });

  if (threshold_exceeded) {
    console.error(
      `[anti-abuse] Daily row count ${count} exceeds threshold ${threshold} on ${date}`,
    );
    if (webhookUrl) {
      // Fire-and-forget — do not await so the cron is not blocked by slow receivers.
      void fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alert: 'daily_threshold_exceeded', ...stats }),
      }).catch((err: unknown) => {
        console.error('[anti-abuse] webhook POST failed:', err);
      });
    }
  }

  return stats;
}
