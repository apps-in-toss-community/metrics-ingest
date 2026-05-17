# metrics-ingest

**한국어** · [English](./README.en.md)

[apps-in-toss-community](https://github.com/apps-in-toss-community) 개발 도구를 위한 익명 사용 텔레메트리 엔드포인트입니다.

## 이게 뭔가요

Cloudflare Workers + D1 기반 서비스로, 커뮤니티가 만든 개발 도구(`@ait-co/devtools`, `@ait-co/console-cli`, `agent-plugin`)에서 발생하는 소규모 구조화 이벤트를 수집합니다. 존재 목적은 단 하나: **사람들이 우리 도구를 얼마나 활발히 쓰고 있는지**를 파악해, 언제 `1.0.0` 안정성 약속을 할 수 있을지 판단하는 것입니다.

## 동의 계층 (Tier)

| Tier | 기본 동작 | 수집 항목 | 식별자 |
|---|---|---|---|
| **Tier 0** | **기본 ON** (opt-out). 별도 프롬프트 없음 | `{source, version}` 일 1회 daily ping. `cf.country` | 서버 생성 (IP+UA daily hash, 저장 안 함) |
| **Tier 1** | **기본 OFF** (opt-in). 명시적 프롬프트 | 세부 이벤트 스트림 + `meta` + `cf.country` | 클라이언트 생성 UUID v4 (영속) |

- `AITC_TELEMETRY=off` 또는 `--no-telemetry` 플래그로 모든 tier 비활성화 가능.
- Tier 1 `granted` 사용자는 Tier 0 + Tier 1 모두 발송.
- Tier 1 `denied` 사용자는 Tier 0만 발송 (재프롬프트 없음).

자세한 설계는 [`docs/specs/2026-05-18-multi-tier-consent.md`](./docs/specs/2026-05-18-multi-tier-consent.md)를 참조하세요.

## 수집 항목

### Tier 0 — daily ping

```json
{
  "tier": 0,
  "source": "devtools",
  "version": "0.1.14",
  "ts": 1715423400000
}
```

Worker가 `cf.country`를 함께 기록합니다. **IP, User-Agent, `anon_id`는 저장하지 않습니다.** `event`는 서버가 `daily_ping`으로 채웁니다. 동일 클라이언트의 하루 중복 ping은 KV dedupe로 하나만 기록됩니다.

### Tier 1 — 세부 이벤트

```json
{
  "tier": 1,
  "source": "devtools",
  "event": "panel_open",
  "anon_id": "<사용자 브라우저 localStorage에 저장된 랜덤 UUID>",
  "version": "0.1.14",
  "ts": 1715423400000,
  "meta": { "tab": "iap" }
}
```

Worker는 발신 국가(Cloudflare의 `cf.country`, 두 글자 코드)도 함께 기록합니다. **IP와 User-Agent는 저장하지 않습니다.** `meta`는 256바이트로 제한됩니다.

### source별 허용 이벤트

| source | tier | event | meta |
|---|---|---|---|
| `devtools` | 0 | `daily_ping` *(서버 자동)* | — |
| `devtools` | 1 | `panel_mount` | — |
| `devtools` | 1 | `panel_open` | — |
| `devtools` | 1 | `tab_view` | — |
| `devtools` | 1 | `session_duration` | — |
| `console-cli` | 0 | `daily_ping` *(서버 자동)* | — |
| `console-cli` | 1 | `cli_invoked` | `{command: string}` |
| `console-cli` | 1 | `cli_install` | `{platform: string, arch: string}` |
| `agent-plugin` | 0 | `daily_ping` *(서버 자동)* | — |
| `agent-plugin` | 1 | `skill_invoked` | — |

이벤트는 **90일** 보존 후, 매일 실행되는 cron이 삭제합니다.

전체 스키마와 정책은 이 저장소의 소스 코드(`src/`, `migrations/`)에서 확인할 수 있습니다.

## 수집하지 않는 항목

- IP 주소
- User-Agent 문자열
- 개인 식별 정보 일체
- mock 호출 인자 또는 사용자 작성 코드 (이벤트 이름 + 탭 레이블만 수집)

## 데이터 정책 요약

| 항목 | Tier 0 | Tier 1 |
|---|---|---|
| 식별자 | 서버 생성 (저장 안 함) | 클라이언트 UUID v4 (DB 저장) |
| IP/UA | 저장 안 함 | 저장 안 함 |
| 국가 | `cf.country` 저장 | `cf.country` 저장 |
| `meta` | 없음 | 256바이트 상한 |
| 보존 | 90일 | 90일 |
| 삭제 요청 | 해당 없음 (저장 식별자 없음) | `DELETE /e?anon_id=<uuid>` |

개인정보 처리 세부 사항: <https://docs.aitc.dev/privacy>

## 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/e` | 이벤트 단건 수집 (Tier 0 / Tier 1) |
| `DELETE` | `/e?anon_id=<uuid>` | 특정 anon_id의 모든 이벤트 삭제 |
| `GET` | `/health` | Liveness probe |
| `GET` | `/stats` | 읽기 전용 일간 요약 (건수 및 날짜만 — 인증 없음, PII 없음). 일간 cron이 최소 한 번 실행되기 전까지 `503` 반환. |

`POST`/`DELETE /e`는 IP당 분당 60회로 rate-limit이 적용됩니다(KV 기반).

매일 cron(03:00 UTC)이 보존 기간이 지난 row를 삭제하고, 당일 row 수를 14일 rolling 히스토리에 기록합니다. `DAILY_ROW_THRESHOLD`를 초과하면 에러 로그를 남기고 선택적으로 `ABUSE_ALERT_WEBHOOK`에 POST합니다. `GET /stats`가 반환하는 것이 바로 이 최신 요약입니다.

## 스택

- Cloudflare Workers
- Hono 4
- Cloudflare D1 (이벤트) + KV (rate limit 상태 + Tier 0 dedupe)
- TypeScript strict, Biome, vitest, pnpm 10.33.0

## 로컬 개발

```bash
pnpm install
pnpm db:migrate:local
pnpm dev          # wrangler dev — http://localhost:8787
pnpm test
pnpm lint
pnpm typecheck
```

소스 관리되는 pre-commit hook 활성화 (staged 파일에 Biome 실행):

```bash
git config core.hooksPath .githooks
```

## 배포

이 저장소는 두 개의 Cloudflare 환경으로 배포됩니다:

- `staging` — 내부 검증
- `production` — 공개 엔드포인트 `https://t.aitc.dev/e`

```bash
pnpm db:migrate:staging      # staging D1에 마이그레이션 적용
pnpm deploy:staging
pnpm db:migrate:production   # production D1에 마이그레이션 적용
pnpm deploy:production
```

`TIER0_SECRET_BASE` secret 등록 (별도 step):

```bash
wrangler secret put TIER0_SECRET_BASE --env staging
wrangler secret put TIER0_SECRET_BASE --env production
```

## 라이선스

BSD-3-Clause. [LICENSE](./LICENSE) 참조.

---

커뮤니티 오픈소스 프로젝트입니다.
