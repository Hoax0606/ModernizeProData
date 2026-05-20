# Modernize Pro Data — AI context

5명 팀(BE 3 / FE 2)이 각자 PC 에서 작업할 때, 모든 AI 세션이 같은 출발점을 갖도록 하는 파일이다. 새 세션을 시작했다면 **이 파일을 먼저 읽고**, 이어서 `docs/handoff/` 의 가장 최근 파일을 읽어라.

## 프로젝트 한 줄
일본 금융권용 데이터 이행 도구. 대상 사이트는 완전 폐쇄망(망연계·본사 모니터링 없음), 본사 ↔ 현장은 사람이 USB 로만 자료를 옮긴다. PoC 1차 마감 **2026-05-31**.

## 스택

### Backend (BE)
- Java + Spring Boot 3 + Spring Batch
- JPA / Hibernate, 메타 DB 는 PostgreSQL 18
- Flyway 마이그레이션 (`V{N}__{name}.sql`)
- Arrow Java, DuckDB JDBC (도구 내장 AS-IS DB)
- PostgreSQL `COPY` 는 `PgCopyManager` 로
- 빌드: Maven (`./mvnw` wrapper, `pom.xml`)
- IDE: **VSCode + Extension Pack for Java** (IntelliJ 아님)
- 배포: jpackage — K8s 는 PoC 단계에선 도입 안 함
- 테스트: Testcontainers + Flyway. **H2 금지** (운영 PG 와 차이 너무 큼)

### Frontend (FE)
- React 18 + Vite + TypeScript
- 상태관리: zustand (persist middleware)
- 라우팅: react-router-dom v6
- 서버 통신: 자체 `api/client.ts` (fetch wrapper)
- i18n: 자체 구현 (`src/i18n/{ko,ja,en}.ts` + `useT` 훅)

### 운영 형태
- **Coordinator (본사)** ↔ **Worker (현장)** 분리. Worker 는 Coordinator 의 REST + WebSocket 으로만 통신. 메타 DB 직접 접속 금지. 등록은 URL + 토큰으로.
- 인스톨러: PG 18 동봉, 기존 PG 가 있으면 그것을 사용하거나 별도 설치 선택.

## 디렉터리 맵

```
ModernizeProData/
├── backend/                    # Spring Boot
│   └── src/main/
│       ├── java/com/ksinfo/modernize_pro_data/
│       │   ├── common/         # config, dto, exception
│       │   └── coordinator/    # api, auth, site, ...
│       └── resources/
│           ├── application.yml
│           └── db/migration/   # V{N}__*.sql — Flyway
└── frontend/                   # React + Vite
    └── src/
        ├── api/                # client + endpoint wrappers
        ├── components/         # 재사용 컴포넌트·모달
        ├── i18n/               # ko/ja/en
        ├── layout/             # AppShell (사이드바·탑바·탭바)
        ├── pages/              # 페이지 컴포넌트
        ├── routes/             # ProtectedRoute
        └── store/              # zustand stores

Prototype/                       # HTML/JSX 프로토타입 — 참고 전용. 수정 금지.
docs/                            # 매뉴얼·아키텍처·handoff (.docx/.pdf 는 ignore)
```

## 컨벤션

### i18n 정책 (FE)
- `menu.*` / `tab.*` / `*.title` / `*.status.*` → **ko/ja/en 모두 동일 영문**
- `*.subtitle` / `*.desc` / `*.hint` / 에러 메시지 / 플레이스홀더 → 언어별 번역
- 사용자 발급/관리 화면은 항상 **"User Management"** 라고 부른다. 내부 변수명(`ClusterAdminModal` 등)은 그대로 둬도 됨.

### Backend 마이그레이션
- 새 테이블/필드는 반드시 Flyway `V{N}__name.sql` 로. 엔티티만 수정해서 Hibernate auto-DDL 에 맡기지 말 것.
- 기존 패턴: `V4__sites_projects.sql` · `V5__project_run_status.sql` · `V6__snapshots.sql`.

### Phase 모델
- 9 단계: `planning · analysis · test · sign-off · rehearsal · ready · cutover · hypercare · done`
- `cutover` 는 **production 환경에서만** 실행 가능.
- 스냅샷은 mapping snapshot 과 cutover snapshot 두 갈래.
- `runStatus` (`idle | running | completed`) 는 test/rehearsal/cutover 의 sub-status.
- 스냅샷 `version` 은 코드가 자동 채번 (`v1.0` 시작). **직전 snapshot 이 approved → major bump** (`v1.x → v2.0`), 그 외 (`draft/pending/rejected`) → **minor bump** (`v1.0 → v1.1`). 수동 편집 없음. 채번 로직은 `Snapshot.generateNextVersion`.
- `cutover` snapshot 생성 버튼은 **rehearsal 이후 phase** 에서만 활성 (`rehearsal · ready · cutover · hypercare · done`).

### 답변 스타일 (사용자 선호)
- 도구 방향성 논의에서 **V1/V2/Phase 단계로 답을 나누지 말 것**. 한 가지 권장안을 제시.
- 명시 요청이 없으면 **새 .md 파일을 만들지 말 것**. 기존 outdated 문서도 사용자 요청 없이는 정정하지 말 것.
- 매주 작업 보고는 **카톡용 간단 형태** — 3-5 bullet, 한국어, emoji 없음.

## 로컬 실행

### Backend
```powershell
# 첫 실행: PG 18 컨테이너 띄움 (compose.yaml 가 기본 OFF 상태)
docker compose up -d postgres   # 포트 5433

# 실행
$env:SPRING_PROFILES_ACTIVE = "local"
cd ModernizeProData/backend
./mvnw spring-boot:run
```
- 로컬 설정: `application-local.yml` (gitignore 됨 — 각자 작성)
- 메타 DB: `localhost:5433`, db `modernize`, user `modernize`

### Frontend
```powershell
cd ModernizeProData/frontend
npm install
npm run dev   # Vite proxy /api → localhost:8080
```

### 타입체크
```powershell
cd ModernizeProData/frontend; npx tsc --noEmit
```

## 도메인 용어

| 용어 | 의미 |
|---|---|
| Coordinator | 본사 관리 노드. 메타 DB 소유. 모든 권한 행사 지점. |
| Worker | 현장 격리망에 설치되는 실행 노드. REST/WS 로만 통신. |
| Site | 한 고객사의 한 운영 환경 단위. AS-IS / TO-BE / 환경 라벨(dev/test/stg/prod) 보유. |
| Project | Site 안의 이행 단위. 하나의 AS-IS → TO-BE 매핑 작업. |
| Phase | Project 의 진행 단계 (위 9단계). |
| Snapshot | 매핑 정의의 승인 단위. mapping snapshot / cutover snapshot 두 종. `version` 자동 채번 (`v1.0 → v1.1`, 승인 후 → `v2.0`). |
| Cutover | 본운영 전환. production 환경에서만, 승인된 snapshot 필요. |
| Rehearsal | dry-run. test 환경에서 cutover 시나리오 검증. |
| AS-IS DB (도구 내장) | 운영팀 야간 CSV 추출 파일을 도구가 받아 DuckDB 로 적재 — 외부 DB 직접 접속 X. |

## 세션 시작 시 권장 동작

1. 이 파일(CLAUDE.md) 을 처음에 한 번 읽음.
2. `docs/handoff/` 폴더의 가장 최근 파일을 읽음 (가장 최근 = 파일명 sort desc).
3. 작업 시작 전 사용자에게 "방금 본 handoff 노트가 X 였는데 이걸 이어받으면 되나?" 식으로 한 줄 확인.
4. 작업이 끝났을 때 `/handoff` slash command 로 다음 사람용 노트 작성.

## 외부 참조 (이 파일에 적지 말 것)

- 개인 선호·기억은 `~/.claude/projects/.../memory/` 에 (각자 따로).
- 진행 중 작업의 상세 컨텍스트는 `docs/handoff/YYYY-MM-DD-{slug}.md` 에.
- 슬래시 명령어는 `.claude/commands/*.md` 에.
