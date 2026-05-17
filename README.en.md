# metrics-ingest

[한국어](./README.md) · **English**

Anonymous, **opt-in** usage telemetry endpoint for [apps-in-toss-community](https://github.com/apps-in-toss-community) dev tools.

## What this is

A Cloudflare Workers + D1 service that accepts small, structured events from community-built dev tools (`@ait-co/devtools`, `@ait-co/console-cli`). It exists to answer one question: **how actively are people using our tools?** — so we know when the surface is mature enough for a `1.0.0` stability commitment.

## What we collect

Per event:

```json
{
  "source": "devtools",
  "event": "panel_open",
  "anon_id": "<random UUID stored in the user's browser localStorage>",
  "version": "0.1.14",
  "ts": 1715423400000,
  "meta": { "tab": "iap" }
}
```

The Worker additionally records the originating country (Cloudflare's `cf.country`, two-letter code). **IP and User-Agent are not stored.** `meta` is capped at 256 bytes.

Events are kept for **90 days**, then deleted by a daily cron.

The full schema and policy are visible in this repository's source code (`src/`, `migrations/`).

### Allowed events per source

| source | event | meta |
|---|---|---|
| `devtools` | `panel_mount` | — |
| `devtools` | `panel_open` | — |
| `devtools` | `tab_view` | — |
| `devtools` | `session_duration` | — |
| `console-cli` | `cli_invoked` | `{command: string}` |
| `console-cli` | `cli_install` | `{platform: string, arch: string}` |

## What we do *not* collect

- No IP addresses
- No User-Agent strings
- No personally identifiable information of any kind
- No mock-call arguments or user-written code (only event names + tab labels)

## Consent

Clients (`@ait-co/devtools`, `@ait-co/console-cli`) are **opt-in**: telemetry is off until the user explicitly accepts. Users are prompted at most twice (initial + one reprompt after 30 days), then never again. Users can toggle telemetry from the devtools panel at any time.

Privacy details, including how to disable telemetry and how to request deletion of your anon_id, are published at <https://docs.aitc.dev/privacy>.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/e` | Ingest one event |
| `DELETE` | `/e?anon_id=<uuid>` | Delete all events for an anon_id |
| `GET` | `/health` | Liveness probe |
| `GET` | `/stats` | Read-only daily summary (counts and dates only — no auth, no PII). `503` until the daily cron has run at least once. |

`POST`/`DELETE /e` are rate-limited to 60 requests/minute per IP (KV-backed).

A daily cron (03:00 UTC) sweeps rows older than the retention window and records that day's row count in a rolling 14-day history; if the count exceeds `DAILY_ROW_THRESHOLD` it logs an error and (optionally) POSTs to `ABUSE_ALERT_WEBHOOK`. The latest summary is what `GET /stats` returns.

## Stack

- Cloudflare Workers
- Hono 4
- Cloudflare D1 (events) + KV (rate limit state)
- TypeScript strict, Biome, vitest, pnpm 10.33.0

## Local development

```bash
pnpm install
pnpm db:migrate:local
pnpm dev          # wrangler dev — http://localhost:8787
pnpm test
pnpm lint
pnpm typecheck
```

Activate the source-controlled pre-commit hook (runs Biome on staged files):

```bash
git config core.hooksPath .githooks
```

## Deployment

This repo is deployed to two Cloudflare environments:

- `staging` — internal verification
- `production` — public endpoint `https://t.aitc.dev/e`

```bash
pnpm db:migrate:staging      # apply migrations to staging D1
pnpm deploy:staging
pnpm db:migrate:production   # apply migrations to production D1
pnpm deploy:production
```

## License

BSD-3-Clause. See [LICENSE](./LICENSE).

---

Community open-source project.
