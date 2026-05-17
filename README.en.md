# metrics-ingest

[한국어](./README.md) · **English**

Anonymous usage telemetry endpoint for [apps-in-toss-community](https://github.com/apps-in-toss-community) dev tools.

## What this is

A Cloudflare Workers + D1 service that accepts small, structured events from community-built dev tools (`@ait-co/devtools`, `@ait-co/console-cli`, `agent-plugin`). It exists to answer one question: **how actively are people using our tools?** — so we know when the surface is mature enough for a `1.0.0` stability commitment.

## Consent tiers

| Tier | Default | Collected | Identity |
|---|---|---|---|
| **Tier 0** | **ON by default** (opt-out). No prompt | `{source, version}` once-daily ping. `cf.country` | Server-derived (IP+UA daily hash, never stored) |
| **Tier 1** | **OFF by default** (opt-in). Explicit prompt | Detailed event stream + `meta` + `cf.country` | Client-generated UUID v4 (persisted) |

- `AITC_TELEMETRY=off` or `--no-telemetry` disables all tiers.
- Tier 1 `granted` users send both Tier 0 and Tier 1.
- Tier 1 `denied` users send Tier 0 only (no re-prompt).

Full design: [`docs/specs/2026-05-18-multi-tier-consent.md`](./docs/specs/2026-05-18-multi-tier-consent.md).

## What we collect

### Tier 0 — daily ping

```json
{
  "tier": 0,
  "source": "devtools",
  "version": "0.1.14",
  "ts": 1715423400000
}
```

The Worker records `cf.country`. **IP, User-Agent, and `anon_id` are not stored.** `event` is set server-side to `daily_ping`. KV dedupe ensures only one row per client per UTC day.

### Tier 1 — detailed events

```json
{
  "tier": 1,
  "source": "devtools",
  "event": "panel_open",
  "anon_id": "<random UUID stored in the user's browser localStorage>",
  "version": "0.1.14",
  "ts": 1715423400000,
  "meta": { "tab": "iap" }
}
```

The Worker additionally records the originating country (Cloudflare's `cf.country`, two-letter code). **IP and User-Agent are not stored.** `meta` is capped at 256 bytes.

### Allowed events per source

| source | tier | event | meta |
|---|---|---|---|
| `devtools` | 0 | `daily_ping` *(server-set)* | — |
| `devtools` | 1 | `panel_mount` | — |
| `devtools` | 1 | `panel_open` | — |
| `devtools` | 1 | `tab_view` | — |
| `devtools` | 1 | `session_duration` | — |
| `console-cli` | 0 | `daily_ping` *(server-set)* | — |
| `console-cli` | 1 | `cli_invoked` | `{command: string}` |
| `console-cli` | 1 | `cli_install` | `{platform: string, arch: string}` |
| `agent-plugin` | 0 | `daily_ping` *(server-set)* | — |
| `agent-plugin` | 1 | `skill_invoked` | — |

Events are kept for **90 days**, then deleted by a daily cron.

The full schema and policy are visible in this repository's source code (`src/`, `migrations/`).

## What we do *not* collect

- No IP addresses
- No User-Agent strings
- No personally identifiable information of any kind
- No mock-call arguments or user-written code (only event names + tab labels)

## Data policy summary

| Item | Tier 0 | Tier 1 |
|---|---|---|
| Identity | Server-derived (not stored) | Client UUID v4 (stored in DB) |
| IP / UA | Not stored | Not stored |
| Country | `cf.country` stored | `cf.country` stored |
| `meta` | None | 256-byte cap |
| Retention | 90 days | 90 days |
| Deletion | N/A (no stored identity) | `DELETE /e?anon_id=<uuid>` |

Privacy details: <https://docs.aitc.dev/privacy>

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/e` | Ingest one event (Tier 0 or Tier 1) |
| `DELETE` | `/e?anon_id=<uuid>` | Delete all events for an anon_id |
| `GET` | `/health` | Liveness probe |
| `GET` | `/stats` | Read-only daily summary (counts and dates only — no auth, no PII). `503` until the daily cron has run at least once. |

`POST`/`DELETE /e` are rate-limited to 60 requests/minute per IP (KV-backed).

A daily cron (03:00 UTC) sweeps rows older than the retention window and records that day's row count in a rolling 14-day history; if the count exceeds `DAILY_ROW_THRESHOLD` it logs an error and (optionally) POSTs to `ABUSE_ALERT_WEBHOOK`. The latest summary is what `GET /stats` returns.

## Stack

- Cloudflare Workers
- Hono 4
- Cloudflare D1 (events) + KV (rate limit state + Tier 0 dedupe)
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

Register the `TIER0_SECRET_BASE` secret (separate step):

```bash
wrangler secret put TIER0_SECRET_BASE --env staging
wrangler secret put TIER0_SECRET_BASE --env production
```

## License

BSD-3-Clause. See [LICENSE](./LICENSE).

---

Community open-source project.
