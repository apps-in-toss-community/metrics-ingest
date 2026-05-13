# metrics-ingest

**한국어** · [English](./README.en.md)

[apps-in-toss-community](https://github.com/apps-in-toss-community) 개발 도구를 위한 익명 **opt-in** 사용 텔레메트리 엔드포인트입니다.

## 이게 뭔가요

Cloudflare Workers + D1 기반 서비스로, 커뮤니티가 만든 개발 도구(현재 `@ait-co/devtools`)에서 발생하는 소규모 구조화 이벤트를 수집합니다. 존재 목적은 단 하나: **사람들이 우리 도구를 얼마나 활발히 쓰고 있는지**를 파악해, 언제 `1.0.0` 안정성 약속을 할 수 있을지 판단하는 것입니다.

## 수집 항목

이벤트 단위 수집 데이터:

```json
{
  "source": "devtools",
  "event": "panel_open",
  "anon_id": "<사용자 브라우저 localStorage에 저장된 랜덤 UUID>",
  "version": "0.1.14",
  "ts": 1715423400000,
  "meta": { "tab": "iap" }
}
```

Worker는 발신 국가(Cloudflare의 `cf.country`, 두 글자 코드)도 함께 기록합니다. **IP와 User-Agent는 저장하지 않습니다.** `meta`는 256바이트로 제한됩니다.

이벤트는 **90일** 보존 후, 매일 실행되는 cron이 삭제합니다.

전체 스키마와 정책은 이 저장소의 소스 코드(`src/`, `migrations/`)에서 확인할 수 있습니다.

## 수집하지 않는 항목

- IP 주소
- User-Agent 문자열
- 개인 식별 정보 일체
- mock 호출 인자 또는 사용자 작성 코드 (이벤트 이름 + 탭 레이블만 수집)

## 동의

클라이언트(`@ait-co/devtools`)는 **opt-in** 방식입니다: 사용자가 명시적으로 동의하기 전까지 텔레메트리는 꺼져 있습니다. 동의 요청은 최대 두 번(초기 + 30일 후 재요청)으로 제한되며, 이후에는 다시 묻지 않습니다. 사용자는 언제든지 devtools 패널에서 텔레메트리를 켜거나 끌 수 있습니다.

텔레메트리 비활성화 방법과 `anon_id` 삭제 요청 방법을 포함한 개인정보 처리 세부 사항은 <https://docs.aitc.dev/privacy>에 게시되어 있습니다.

## 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/e` | 이벤트 단건 수집 |
| `DELETE` | `/e?anon_id=<uuid>` | 특정 anon_id의 모든 이벤트 삭제 |
| `GET` | `/health` | Liveness probe |
| `GET` | `/stats` | 읽기 전용 일간 요약 (건수 및 날짜만 — 인증 없음, PII 없음). 일간 cron이 최소 한 번 실행되기 전까지 `503` 반환. |

`POST`/`DELETE /e`는 IP당 분당 60회로 rate-limit이 적용됩니다(KV 기반).

매일 cron(03:00 UTC)이 보존 기간이 지난 row를 삭제하고, 당일 row 수를 14일 rolling 히스토리에 기록합니다. `DAILY_ROW_THRESHOLD`를 초과하면 에러 로그를 남기고 선택적으로 `ABUSE_ALERT_WEBHOOK`에 POST합니다. `GET /stats`가 반환하는 것이 바로 이 최신 요약입니다.

## 스택

- Cloudflare Workers
- Hono 4
- Cloudflare D1 (이벤트) + KV (rate limit 상태)
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

## 라이선스

BSD-3-Clause. [LICENSE](./LICENSE) 참조.

---

커뮤니티 오픈소스 프로젝트입니다.
