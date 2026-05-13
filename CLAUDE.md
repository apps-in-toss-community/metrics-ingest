# CLAUDE.md

## 프로젝트 성격

`apps-in-toss-community`는 **비공식(unofficial) 오픈소스 커뮤니티**다. 토스/앱인토스 팀과 제휴 없음, 공식 프로젝트 아님.

사용자에게 보여지는 모든 산출물(README, UI 카피, 패키지 설명, 커밋/PR 메시지, 코드 주석 등)에서 다음 표현 **금지**:

- "공식(official)", "공식 플러그인/도구", "토스가 제공하는", "앱인토스에서 만든", "powered by Toss"
- 토스와의 제휴/후원/인증을 암시하는 모든 표현

대신 "커뮤니티(community)" 같은 자연스러운 표현. 의심스러우면 빼라.

**톤 가이드** (방어적 disclaimer 금지): README 푸터에 한 줄로 1회만 명시 — `Community open-source project.` (이 repo는 영어 primary). "제휴 아님" 같은 방어적 표현 대신 "커뮤니티 오픈소스" 정체성만 자연스럽게. 헤더 직후의 `>` blockquote 박스, ⚠️ 아이콘, 굵은 글씨, `unofficial`/`비공식` 같은 강한 라벨, 영/한 병기는 모두 쓰지 않는다. 기술적 caveat(예: rate-limit, opt-in 정책)은 disclaimer에 묶지 않고 자연스러운 본문 섹션에 둔다.

## 프로젝트 개요

**metrics-ingest** — 커뮤니티 dev 도구의 **익명 opt-in** 사용 텔레메트리를 받는 Cloudflare Workers 엔드포인트. 초기 source는 `@ait-co/devtools` 한 도구이지만, 향후 `console-cli` / `agent-plugin` 등이 같은 엔드포인트로 모인다.

**존재 이유**: "1.0.0 cut 시점은 다운로드 수가 아니라 실제 활성 사용자 확보"라는 정책의 신호원. opt-in이라 표본은 작지만 봇/CI 노이즈가 없어 신호 품질이 높다.

## 데이터 정책 (변경 시 외부 공개 페이지 동반 갱신)

| 항목 | 정책 |
|---|---|
| 식별자 | `anon_id` (브라우저 localStorage random UUID v4). cookie 아님. |
| 저장하지 않는 것 | IP, User-Agent, mock 인자, 사용자 코드 |
| `meta` 컬럼 | 도구별 자유 JSON. `JSON.stringify(meta).length ≤ 256` (Worker에서 cap) |
| 국가 | Cloudflare `cf.country` 2-letter code만 |
| 보존 기간 | 90일. 매일 03:00 UTC cron이 `ts < now - 90d` row DELETE |
| 삭제 요청 | `DELETE /e?anon_id=<uuid>` 사용자가 패널에서 직접 호출 가능 |
| Rate limit | 60 req/min per IP. Backend: `RATE_LIMIT_BACKEND=kv` (default, eventual consistency) or `d1` (atomic UPSERT, strong consistency). KV default kept; staging validates D1 before production switch. |
| `source` allowlist | 현재 `['devtools']`. 새 도구 추가는 별도 PR로 allowlist 확장 |
| 일일 row-count 모니터링 | 같은 03:00 UTC cron이 당일(UTC) row 수 집계 → KV `abuse:history`에 14일 rolling 저장. `DAILY_ROW_THRESHOLD` (staging 5k / prod 50k) 초과 시 `console.error` + 선택적 webhook POST (`ABUSE_ALERT_WEBHOOK`). 개수·날짜만 — PII 없음 |
| 집계 공개 | `GET /stats` — 마지막 `DailyStats` 스냅샷(개수, 날짜, threshold, 14일 history)을 인증 없이 read-only 노출. cron 미실행 시 503. Grafana 대시보드의 경량 대안 |

**정책 변경 시 동반 갱신할 곳**:
- 이 파일 (source of truth)
- `README.md` (repo)
- `docs.aitc.dev/privacy` (docs repo) — 외부 노출 정본
- devtools client의 consent 토스트 카피
- `__ait_telemetry:policy_version` localStorage 키 bump → 동의 reprompt 트리거

## 기술 스택

공통: **Node 24 LTS**, **pnpm 10.33.0** (`packageManager` 고정), **TypeScript strict**, **Biome** (lint + formatter, ESLint/Prettier 사용 안 함). Commit message는 **Conventional Commits**.

Pre-commit hook은 source-controlled (`.githooks/pre-commit`), contributor가 수동 활성화:

```bash
git config core.hooksPath .githooks
```

이 repo 고유:

- **Cloudflare Workers + Hono 4** — `src/index.ts` entrypoint
- **D1** — `events` 테이블 (`migrations/*.sql`)
- **KV** — rate limit 상태
- **zod 4** — payload validation
- **vitest + miniflare** — 단위/통합 테스트
- **wrangler 4** — 로컬 dev / 배포

## 배포

이 repo는 **service** 배포 타입 (Type C) — main 머지 시 staging 자동 배포, production은 manual approval. Changesets 없음.

환경:
- `staging` — `t-staging.aitc.dev` (검증용)
- `production` — `t.aitc.dev` (공개)

D1/KV는 환경별 별도 인스턴스. wrangler.toml의 `[env.staging]` / `[env.production]` 분기.

## 명령어

자주 쓰는 것 (전체는 `package.json`):

```bash
pnpm dev                      # wrangler dev
pnpm typecheck
pnpm lint / lint:fix
pnpm test
pnpm db:migrate:local         # 로컬 D1 마이그레이션
pnpm db:migrate:staging       # 원격 staging D1
pnpm db:migrate:production    # 원격 production D1
pnpm deploy:staging
pnpm deploy:production
```

## 프로젝트 구조

```
src/
├── index.ts          # Hono app + scheduled (cron) handler
├── routes/
│   ├── ingest.ts     # POST /e (validation + rate limit + D1 insert)
│   ├── delete.ts     # DELETE /e?anon_id=...
│   └── health.ts     # GET /health
├── lib/
│   ├── ratelimit.ts  # KV per-IP rate limit
│   ├── schema.ts     # zod payload schema + SOURCES allowlist
│   └── env.ts        # Worker env binding types
└── __tests__/        # vitest

migrations/
└── 0001_init.sql     # events table + indexes
```

## 코딩 컨벤션

- **payload 검증은 zod에서 끝낸다** — schema 통과 후 코드는 unknown → typed 변환 없이 그대로 사용.
- **D1 writes는 prepared statement 또는 batch** — 직접 string concat 금지.
- **rate limit 실패는 429** — 본 응답에서 D1 write 안 함.
- **cf.country 외 어떤 cf.* 필드도 저장 금지** — 정책 일관성.
- **에러 응답 본문은 짧게** — `{ "error": "invalid_payload" }` 형태. 디버깅 디테일은 응답에 안 넣음 (abuse 표면 최소화).

## 외부 정책 참조

- umbrella `CLAUDE.md`: `apps-in-toss-community/umbrella/CLAUDE.md` (organization 단위 공통 정책)
- umbrella `TODO.md`: 항목 추가/완료는 umbrella TODO가 single source of truth. sub-repo TODO 안 둠.
- 데이터 정책 외부 정본: `docs.aitc.dev/privacy` (docs repo `apps-in-toss-community/docs`)
