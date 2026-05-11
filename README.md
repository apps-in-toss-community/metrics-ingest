# metrics-ingest

Anonymous, **opt-in** usage telemetry endpoint for [apps-in-toss-community](https://github.com/apps-in-toss-community) dev tools.

This is a community project. Not affiliated with or endorsed by Toss.

## What this is

A Cloudflare Workers + D1 service that accepts small, structured events from community-built dev tools (currently `@ait-co/devtools`). It exists to answer one question: **how actively are people using our tools?** — so we know when the surface is mature enough for a `1.0.0` stability commitment.

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

## What we do *not* collect

- No IP addresses
- No User-Agent strings
- No personally identifiable information of any kind
- No mock-call arguments or user-written code (only event names + tab labels)

## Consent

The client (`@ait-co/devtools`) is **opt-in**: telemetry is off until the user explicitly accepts. Users are prompted at most twice (initial + one reprompt after 30 days), then never again. Users can toggle telemetry from the devtools panel at any time.

Privacy details, including how to disable telemetry and how to request deletion of your anon_id, are published at <https://docs.aitc.dev/privacy>.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/e` | Ingest one event |
| `DELETE` | `/e?anon_id=<uuid>` | Delete all events for an anon_id |
| `GET` | `/health` | Liveness probe |

Rate-limited to 60 requests/minute per IP (KV-backed).

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

Activate the source-controlled pre-commit hook (Biome on staged files):

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
