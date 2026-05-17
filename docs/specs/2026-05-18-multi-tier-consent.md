---
date: 2026-05-18
status: Draft
supersedes:
  - devtools (통합 이전 단일 opt-in 모델, ~2026-05-13)
  - console-cli PR #140 (단일 opt-in 모델, 2026-05-17)
  - metrics-ingest PR #12 (console-cli source 추가, 2026-05-17)
authors:
  - Dave (정책 결정)
  - Claude Code (초안 작성)
---

# Multi-tier Consent Telemetry — 설계 명세

## 1. Status & Date

**상태**: Draft · 2026-05-18  
**작성**: Dave (정책 결정), Claude Code (초안 작성)

이 문서는 2026-05-13 이전까지 devtools에, 2026-05-17 console-cli PR [#140](https://github.com/apps-in-toss-community/console-cli/pull/140) 및 metrics-ingest PR [#12](https://github.com/apps-in-toss-community/metrics-ingest/pull/12)에 탑재된 **단일 opt-in 모델**을 대체한다. 이 명세가 머지된 이후의 모든 후속 PR은 여기서 결정된 설계를 따른다.

---

## 2. Motivation

기존 단일 opt-in 모델은 두 가지 성격이 전혀 다른 동의 필요를 하나로 묶었다.

**(a) "이 도구를 쓰는 사람이 있긴 한가?"** — 일일 활성 사용자(DAU) 신호. 행동 추적이 필요 없다. `{source, version, platform}` 세 필드면 충분하고, 그 외 PII가 없으면 별도 동의 프롬프트를 요구할 근거가 약하다.

**(b) "어떤 기능이 실제로 쓰이는가?"** — 세부 이벤트 스트림. 커맨드 인자, 탭 식별, 세션 길이 같은 맥락이 포함되어 명시적 동의가 적절하다.

기존 모델은 둘을 하나의 프롬프트로 묶었기 때문에, 동의를 거부한 사용자에게서 **(a)마저 잃는다**. (a)는 조직 전체의 1.0.0 cut 판단 기준인 "실제 활성 사용자 확보"의 핵심 신호다. opt-in에만 의존하는 DAU 집계는 대부분의 사용자가 프롬프트를 닫아버리면 의미가 없다.

Multi-tier 분리는 이 문제를 정면으로 해결한다. Tier 0은 사용자 행동을 추적하지 않으면서도 DAU 신호를 보존하고, Tier 1은 명시적 동의를 얻은 사용자에게서만 세부 데이터를 수집한다.

---

## 3. Two-tier Model

| Tier | 기본 동작 | 수집 항목 | PII | `anon_id` |
|---|---|---|---|---|
| **Tier 0** (opt-out) | **기본 ON**. 별도 프롬프트 없음. | `{source, version, platform}` daily ping 1회/일. `cf.country` (2자리 코드). | 없음 | 서버 생성. IP+UA daily hash (서버 메모리에서만 계산, 저장 안 함) |
| **Tier 1** (opt-in) | **기본 OFF**. 명시적 프롬프트(TTY/UI). | 기존 세부 events + session duration + error/crash + 세밀 meta (커맨드 인자 일부, 탭 식별 등). `cf.country`. | 없음 | 클라이언트 생성 UUID v4, 영속 저장 |

**Tier 0의 의미 경계**: Tier 0 ping이 전달하는 정보는 딱 "이 source의 이 version이 오늘 이 국가에서 실행됐다"뿐이다. 어떤 기능을 쓰는지, 얼마나 자주 쓰는지는 전혀 알 수 없다.

동의 흐름 요약:

- 미동의(undecided) 사용자 → Tier 0 ping만 발송.
- Tier 1 `granted` 사용자 → Tier 0 + Tier 1 모두 발송.
- Tier 1 `denied` 사용자 → Tier 0만 발송 (Tier 1 프롬프트 재표시 없음).
- `--no-telemetry` / `AITC_TELEMETRY=off` → 모든 tier 비활성.

---

## 4. Endpoint Shape

**결정: 단일 `POST /e`, `tier: 0 | 1` 필드 추가. 별도 `/p` 엔드포인트 없음.**

근거: rate-limit과 dedupe 인프라를 공유하고, D1 스키마 분기가 없으며, 클라이언트 로직이 단순하다(플래그 하나). 별도 엔드포인트는 코드 분리는 깔끔하지만 인프라 중복이 더 크다.

### 서버 동작

**Tier 0 (`tier: 0`):**
- 클라이언트가 제공하는 `anon_id`는 무시한다 (zod 스키마에서 금지, 포함 시 `400`).
- 서버에서 `sha256(ip || ua || YYYY-MM-DD || daily_salt)` 계산 → 앞 16자만 사용 (truncated).
- IP, UA, 전체 해시는 어디에도 저장하지 않는다. `daily_salt`는 매일 자정 UTC에 교체.
- D1에는 `{source, version, platform, cf.country, tier: 0, anon_id: <16-char truncated hash>}` 저장.

**Tier 1 (`tier: 1`):**
- 클라이언트 제공 `anon_id` (UUID v4 필수, 없으면 `400`)를 그대로 사용.
- 기존 event 스트림 그대로.

**공통:**
- `cf.country` 2자리 코드 저장. 그 외 Cloudflare 메타데이터 저장 금지.
- 에러 응답은 `{"error": "invalid_payload"}` 짧은 형식 유지.

### zod 스키마 (개략)

```typescript
// Tier 0 페이로드 — anon_id 금지
const Tier0Schema = z.object({
  tier: z.literal(0),
  source: z.enum(SOURCES),
  version: z.string(),
  platform: z.string(),
  // anon_id 없음
});

// Tier 1 페이로드 — anon_id 필수
const Tier1Schema = z.object({
  tier: z.literal(1),
  source: z.enum(SOURCES),
  event: z.string(),
  anon_id: z.string().uuid(),
  version: z.string(),
  ts: z.number(),
  meta: z.string().max(256).optional(),
});

const IngestSchema = z.discriminatedUnion("tier", [Tier0Schema, Tier1Schema]);
```

기존 `tier` 필드가 없는 레거시 페이로드는 마이그레이션 기간 동안 Tier 1로 해석한다 (아래 스키마 마이그레이션 섹션 참조).

---

## 5. Daily Dedupe (Tier 0)

Tier 0의 신호는 "이 anon_id가 오늘 ping했는가, 안 했는가"이다. 동일 클라이언트가 하루에 여러 번 실행되어도 DAU가 부풀면 안 된다.

**KV dedupe 키**: `t0:${source}:${ip_ua_hash}:${YYYY-MM-DD}`  
**TTL**: 36시간 (자정 이후 안전 마진)  
**동작**: 키가 존재하면 → `202 Accepted` silent drop (D1 write 없음). 키가 없으면 → D1 insert 후 KV set.

기존 Tier 1 rate limit (60 req/min per IP)은 변경 없이 유지. Tier 0 dedupe은 rate limit과 별개 계층이다.

---

## 6. Schema Migration

`events` 테이블에 `tier` 컬럼을 추가한다.

```sql
-- migrations/0002_tier.sql
ALTER TABLE events ADD COLUMN tier INTEGER NOT NULL DEFAULT 1;
```

`DEFAULT 1` 이유: 기존 모든 row는 Tier 1 세부 이벤트였으므로 Tier 1로 읽히는 것이 정확하다. 백필 불필요.

인덱스: `tier`별 집계 쿼리가 빈번해지면 `CREATE INDEX idx_events_tier ON events(tier)` 추가를 고려하지만 초기에는 불필요.

**마이그레이션 순서**:
1. metrics-ingest server PR에서 `0002_tier.sql` 추가.
2. staging 적용 → 회귀 테스트.
3. production 적용.
4. 클라이언트 PR들은 server가 배포된 이후 순차 출시. 그 전까지 레거시 페이로드(`tier` 필드 없음)는 server에서 Tier 1로 폴백 처리.

---

## 7. Per-product Scope

### devtools (`@ait-co/devtools`)

| | Tier 0 | Tier 1 |
|---|---|---|
| 트리거 | 패널 첫 mount, 1일 1회 | 기존 `panel_open` / `tab_view` / `session_duration` 등 |
| anon_id | 서버 생성 | 클라이언트 UUID v4 (localStorage 유지) |
| opt-out | 패널 토글 (기존 "opt-out" 토글을 Tier 0도 커버하도록 확장) + `AITC_TELEMETRY=off` | 기존 consent toast |

Tier 0 ping은 `panel_mounted` 이벤트 대신 `daily_ping` 이벤트명으로 발송한다.

### console-cli (`@ait-co/console-cli`)

| | Tier 0 | Tier 1 |
|---|---|---|
| 트리거 | 모든 invocation (서버 dedupe로 1일 1회 D1 write) | 기존 `cli_invoked` / `cli_install` + 신규 (session duration, error/crash) |
| opt-out | `--no-telemetry` 플래그 / `AITC_TELEMETRY=off` | 기존 `aitcc telemetry disable` |

`aitcc telemetry status`에서 Tier 0 / Tier 1 상태를 각각 표시한다.

### polyfill (`@ait-co/polyfill`)

**결정**: polyfill 라이브러리 자체에는 네트워크 코드를 추가하지 않는다.

npm postinstall ping은 공급망 안티패턴으로 **명시 거부**. 이 결정은 번복되지 않는다.

기본 가설: polyfill이 dev-time에 로드되면 devtools가 이를 감지하여 Tier 1 meta에 `{loaded: ['polyfill']}` 포함. 감지 방식은 polyfill auto-entry가 `globalThis`에 sentinel을 설정하고, devtools unplugin이 이를 읽는다.

**sentinel 이름은 별도 합의 필요** — 현재 후보는 아래 "Open Questions" 참조. polyfill 자체는 sentinel을 설정하는 코드 한 줄이 전부이며 네트워크 송신은 없다.

이 전략의 결과: devtools 없이 polyfill만 사용하는 환경에서는 사용 신호가 수집되지 않는다. npm 다운로드 카운트로 대신한다.

### agent-plugin

| | Tier 0 | Tier 1 |
|---|---|---|
| 트리거 | 모든 `/ait <skill>` 호출 (공통 skill prelude에서 fire-and-forget) | 기존 없음 → skill명 + 결과 타입 (opt-in 후) |
| `anon_id` 재사용 | `~/.config/aitcc/telemetry.json` (console-cli 파일) 존재 시 재사용. 없으면 `~/.config/ait-plugin/telemetry.json` 자체 생성. | 동일 |
| 공통 helper | 모든 skill이 import하는 단일 `shared/telemetry.ts` 모듈 | — |

`source` allowlist에 `agent-plugin` 추가 필요 (metrics-ingest PR에서 동시 처리).

### Out of scope

| 제품 | 이유 |
|---|---|
| `oidc-bridge` / `oidc-bridge-cloud` | 운영 서비스. OTel Phase 8로 별도 관리. |
| `docs` | Cloudflare Web Analytics |
| `sdk-example` | Cloudflare Web Analytics |
| `apps-in-toss-community.github.io` | Cloudflare Web Analytics |

---

## 8. Privacy Doc & UI Copy

`docs.aitc.dev/privacy` 페이지가 현재 존재하지 않는다. 이번 rollout의 일환으로 **신규 작성이 필수**다. 이 명세가 머지된 이후 Privacy 페이지 PR이 열려야 한다.

**Privacy 페이지 필수 항목**:
- Tier 0 / Tier 1 데이터 수집 표 (수집 항목, 저장 기간, 저장 위치)
- opt-out 방법 (환경 변수, CLI 플래그, 패널 토글)
- `anon_id` 삭제 절차 (`DELETE /e?anon_id=<uuid>`)
- Tier 0 server-side hash가 저장되지 않음을 명시

**각 product README "텔레메트리" 섹션 갱신 기준**:
1. Tier 0이 기본 ON이며 `--no-telemetry` 또는 `AITC_TELEMETRY=off`로 끌 수 있다.
2. Tier 1은 별도 프롬프트로 opt-in이며 수집 항목이 다름을 설명.
3. 두 tier 모두에 대해 `docs.aitc.dev/privacy` 링크.

언어: 각 `README.md`(한국어 primary) / `README.en.md`(영어 sub) 각각 해당 언어로. 한 파일에 두 언어 병기 금지.

---

## 9. Policy Version Bump

현재 `CURRENT_POLICY_VERSION = '2026-05-12'` (devtools, console-cli).

**새 값**: `'2026-05-18'`

**bump 효과**:
- 기존 `granted` 사용자 → `undecided`로 회귀 → 다음 실행 시 새 문구로 Tier 1 재동의 프롬프트.
- 기존 `denied` 사용자 → `denied` 유지 → Tier 1 프롬프트 다시 표시 안 함.
- Tier 0은 동의 상태와 무관하게 동작 (단, `AITC_TELEMETRY=off` 시 비활성).
- 신규 사용자 → Tier 0 ON, Tier 1 `undecided` (첫 실행 시 프롬프트).

**bump 시점**: 이 명세 PR은 bump를 포함하지 않는다. 각 product(devtools, console-cli, agent-plugin)의 클라이언트 재설계 PR에서 동시에 bump. 이 명세 PR 이후에 열리는 클라이언트 PR이 적용 시점이다.

---

## 10. Opt-out Mechanism

"opt-out 기본 ON"이 정직하려면 off-switch가 명확하고 문서화되어 있어야 한다.

| 스위치 | 적용 범위 | 동작 |
|---|---|---|
| `AITC_TELEMETRY=off` 환경 변수 | 모든 product, 모든 tier | 공유 클라이언트 lib 진입 시 감지 → 모든 네트워크 송신 skip |
| `--no-telemetry` CLI 플래그 | console-cli, agent-plugin entry | 단일 실행 단위에서 모든 tier 비활성 |
| devtools 패널 토글 | devtools | 현재 Tier 1만 커버 → **Tier 0도 커버하도록 확장** 필요 (클라이언트 PR에서 처리) |

**환경 변수 이름 최종화 여부**: `AITC_TELEMETRY=off` (lib-wide 단일 이름)을 권장하지만, console-cli가 이미 다른 이름을 쓰고 있다면 "Open Questions" 참조.

각 product README에 정확한 off-switch 방법을 명시한다. Privacy 페이지도 링크.

---

## 11. Rollout Order

아래 순서는 의존 관계 기준. 병렬 가능한 항목은 명시함.

1. **metrics-ingest server** — `0002_tier.sql` schema migration + Tier 0 path (`tier: 0` 처리, anon_id 서버 생성, `daily_salt` 로직) + KV-based daily dedupe + zod discriminated union 확장 + Tier 1 regression 0 보장. `source` allowlist에 `agent-plugin` 추가.
2. **devtools 클라이언트 재설계** — Tier 0 daily ping (panel mount) + Tier 1 유지 + 패널 토글 Tier 0 확장 + `policy_version` `'2026-05-18'` bump + README ko/en 갱신.
3. **console-cli 클라이언트 재설계** — Tier 0 ping (invocation, daily dedupe) + Tier 1 유지 + 신규 Tier 1 events (session duration, error) + `aitcc telemetry status` 두 tier 노출 + `policy_version` bump + README ko/en 갱신.
4. **agent-plugin 공통 prelude + skill 배선** — `shared/telemetry.ts` + 모든 skill에 Tier 0 ping 삽입 + anon_id 파일 전략 결정 + SKILL.md 갱신. (#2와 병렬 가능)
5. **polyfill sentinel + devtools 감지** — polyfill auto-entry에 sentinel 설정 + devtools unplugin에서 감지 → Tier 1 meta 포함. sentinel 이름 합의 필요. (#4와 병렬 가능)
6. **Privacy 페이지** — `docs.aitc.dev/privacy` ko/en 신규 작성. (#2~5와 병렬 가능, 단 #1 이후)
7. **metrics-ingest README/source-event 표 갱신** — `tier` 컬럼 추가, Tier 0 / 1 이벤트 분리 표. (#1과 같은 PR에 포함 가능)

---

## 12. Open Questions

다음 항목은 후속 PR에서 결정이 필요하다. 이 명세를 블로킹하지는 않는다.

1. **Tier 1 `cli_invoked` 샘플링**: console-cli의 `cli_invoked`를 invocation마다 Tier 1 row로 쌓을지, 커맨드 타입별 1일 1회로 다운샘플링할지. row volume 관리 측면에서 검토 필요.

2. **Tier 0 `cf.country` 충분성**: country-level granularity로 "지리적" vs "기업형" 사용 패턴을 구분할 수 있는가? ASN의 첫 바이트를 추가하면 더 명확해지지만 PII 경계 검토 필요.

3. **환경 변수 이름 통일**: `AITC_TELEMETRY=off` (lib-wide 단일)을 쓸지, `AITCC_TELEMETRY=off` 같은 product별 이름으로 갈지. lib-wide가 단순하지만 console-cli 기존 환경 변수 컨벤션과 충돌 가능성 확인 필요.

4. **polyfill sentinel 이름**: `window.__AIT_POLYFILL__`, `globalThis.__AITC_POLYFILL__`, document attribute 중 하나. polyfill이 무엇을 export해야 하는지와 직결되므로 polyfill PR 이전에 합의 필요.

---

## 13. Non-goals

이 명세는 다음을 명시적으로 범위 밖으로 둔다.

- **식별 사용자 / 인증 텔레메트리** — 익명 유지. 로그인 사용자와 연결하지 않는다.
- **서버 측 cross-product 사용자 연결** — source가 다르면 각각 독립 집계. 동일 사용자를 devtools + console-cli 양쪽에서 하나로 묶는 경우 없음.
- **`cf.country` 이상의 geo 정보** — IP 주소, 도시, 지역 코드 저장 안 함.
- **npm postinstall ping** — 공급망 안티패턴. 명시 거부 (번복 불가).
- **실시간 분석 대시보드 (Grafana)** — Tier 0/1 분리 view는 1.0.0 cut 검토 시점에 재평가. 지금은 `GET /stats` + 14일 rolling history로 충분.
- **Codex / Gemini 에이전트** — agent-plugin 듀얼 배포 계획이 있지만 텔레메트리 적용은 Claude Code 통합 안정화 이후.

---

*커뮤니티 오픈소스 프로젝트입니다.*
