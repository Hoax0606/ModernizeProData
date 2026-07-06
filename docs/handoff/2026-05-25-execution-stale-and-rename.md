# 2026-05-25 — execution-stale-and-rename (Jiyeong Im)

## 한 일
- **Pre-flight stale flag (P2 #6)** — `PreflightEntry.isStale`. selection/snapshot 변경 시 phase==done 이면 stale 처리, UI 앰버 배너 + Start 비활성. Demo 도 시연 가능 (`demoStale` local state + 진입 시 fixture 자동 선택).
- **runId 형식 교체** — `reh-{timestamp}` → `{projectId} - {runIndex}`. `runCounter` 추가, persist `v1→v2 + migrate` 로 옛 캐시 자동 invalidate. DB project id 가 `p-{8hex}` 라 head 표시 자연스러움.
- **7-stage 재구성** — `Check / Extract / Reconcile / Transform / Audit / Load / Verify`. 매 변환 사이 명시적 parity 검증. `Stage.shortName` 으로 `OverallProgress` 라벨 충돌 해소.
- **Paused state** — `RunStatus` 에 `'paused'` 추가 + Pause/Resume 시 `setProjectRunStatus` 동기화. 사이드바·탑바 phase 배지가 paused 시 흰색으로 빠짐.
- **UI 톤 통일** — Phase 배지 RunHeader 중복 제거 (4 곳 일관 — running 일 때만 색). Status 배지 swap (running=초록, completed=회색). PipelineStages 색 통일 (LIVE 초록, DONE 회색, QUEUED 앰버). Discard `btnDanger`.
- 커밋 `991967e` (`dev` 머지됨).

## 다음 사람이 할 일
- **P2 #7 백엔드 run engine 연결** — mock 35초 simulation → 실 stage execution. WS 이벤트가 frontend store action 진입로.
- **`paused` runStatus 백엔드 호환** — `projectApi.update` 가 `'paused'` 보내는데 backend enum/validator 거부 가능성. silent drift 방지.
- **Stage cache (PoC 2차)** — Extract/Profile 결과 cache 재사용해서 매핑 수정 후 Transform 부터 재실행. dbt `--state` / Spring Batch `JobInstance` 패턴. run engine 설계 시 같이.
- **`SiteSettingsModal.tsx` `highlight` 흐름 재점검** — 머지 충돌 정리 (`a9597db`) 시 line 92-99 통째 삭제됨. Pre-flight Fix 의 `csv-arrived` / `conn-tobe` 진입로 깨졌을 가능성.
- 어제 handoff 의 다른 P2 (#5 `/versions` snapshot pinning, #8 로그인 redirect, #9 `execution.dialog.*` 60키 청소) 그대로.

## 함정 / 결정 이력
- **Retry 의미 = (a) 해석** — 같은 run·failed stage 부터 재실행. 매핑 수정 안 한 케이스만. 매핑 수정 후엔 Discard → Start over 가 정상 흐름. Stage cache 도입 시 의미 확장 예정.
- **Stage cache 는 PoC 2차** — frontend 단독 해결 불가. 사용자 시나리오 (매핑 수정 후 Transform 부터 재개) 의 근본 해결책이지만 백엔드 checkpoint 모델 필요.
- **DB project id = `p-{8hex}` (UUID 아님)** — head 표시·로깅에 truncate 불필요.
- **Persist v1→v2 migrate** — 옛 `reh-` activeRun 만 invalidate. 다른 entry 필드 (selection/snapshot/pre-flight 결과) 보존.
- **`failActiveRun` 자동 stale invalidate 검토 → 제거** — 일시 오류 후 Retry 케이스 보호 위해. selection/snapshot 변경 시점에만 stale.
- **PipelineStages LIVE 색 두 번 뒤집힘** — "row 강조 위해 앰버 유지" → "header running 초록과 통일" 로 swap. 최종 LIVE=초록.

## 안 한 것 (의도적으로)
- **Stage cache (PoC 2차)** — 위 결정 이력 참고.
- **Backend `paused` enum 처리** — 점검 결과 OK 였음 (아래 Backend 섹션 참고).
- **버튼 layout 단순화** — 다른 팀원의 "Retry 만 노출" 의견. (a) 해석 합의로 현재 3-버튼 (`Discard·Retry·Start over`) 유지. PoC 2차 재논의.
- **i18n `execution.dialog.*` 60키 청소 (P2 #9)** — StartRunDialog 잔재. 다음 사이클.

---

## Backend (오후) — 미 commit

### 한 일
- **`paused` runStatus 호환 점검** — `Project.runStatus` 가 plain `String` (VARCHAR(16)) + validator 없어서 `'paused'` 그대로 통과. 코드 변경 X.
- **`RunService.java` cutover trigger 가드 수정** — `expectedPhaseForRunType(RunType)` static helper 추가 + `startRun` 의 phase 가드 교체. `phase=ready` + `runType=cutover` 가 통과되도록 (`resolveRunTypeFromPhase` 의 역방향 매칭). 컴파일 통과 (`./mvnw compile` exit 0).

### Sprint 0 결정 5 (팀 결정 기록)
1. **Run engine = 자체 engine** (Spring Batch X)
2. **실행 모델 = stage-by-stage + continue-on-error** — 한 stage 안 한 테이블 fail 시에도 나머지 테이블 처리 후 stage 끝에 fail
3. **Worker 분리 = PoC 1차 도입** (마감 위험 감수) — 단, 사용자(execution 담당) 측에선 `WorkerExecutor` 인터페이스만 추상화하고 `LocalWorkerExecutor` (Coordinator 내장) 로 시작. Worker 인프라는 다른 팀원
4. **Cutover stage = Audit 빠진 6-stage** (Check/Extract/Reconcile/Transform/Load/Verify). test/rehearsal 는 7-stage 그대로
5. **Output 저장** = `{tool-install}/output/{projectId}/{runIndex}-{timestamp}/{parquet1|parquet2|quarantine}/` + `metadata.json`

Frontend 페이지 분기:
- test → `/execution`
- rehearsal/cutover → `/execution/overview` (All projects)
- cutover trigger 조건: `environment === 'production' && phase === 'ready'`

### 큰 발견 (다른 팀원 이미 구현)
- `RunHistory` Entity (= `RunInstance` 역할) + `V20260522210002__run_history.sql`
- `RunService` (3-경로 통합 입구, lock 가드, phase 가드, prod 가드, approved snapshot 가드)
- `RunController` (`POST /runs`, `/runs/all`, `GET /runs/{id}`)
- `WorkerDispatcher` + WS dispatch
- Audit log infra

→ 사용자 작업 범위가 좁아짐. Run engine 새로 만들 필요 X — 기존 위에 부족한 부분만 추가.

### 내일 진입로 (추천 순)
- (a) **RunService commit** + **audit log hook 추가** — `startRun/completeRun/failRun/abortRun` 안에 `auditLogService.record(...)`. 작음
- (b) **Snapshot pin backend** — `projects.pinned_snapshot_id` 컬럼 + Flyway + Controller endpoint 3 개. 중간
- (c) **Stage 분해 모델** — `StageInstance` + `StageTableResult` Entity + Flyway. RunHistory 와 연결. 중간
- (d) **Pre-flight backend API** — `POST /api/v1/projects/{id}/preflight` + 7 체크 + `detail` fail reason. 큼
- (e) **Worker 측 stage runner 점검** — Worker 모듈 위치 파악 + 7-stage 구현 수준. 조사

### 함정 / 결정 이력 (Backend)
- **Cutover trigger 가드 미스매치** — 기존 코드의 `runType.name() == phase` 매칭은 `cutover` runType 이 `phase=cutover` 만 통과. 그러나 `resolveRunTypeFromPhase("ready") → cutover` 라 호출 자체 실패. 사용자 결정 (`ready→cutover`) 반영해서 helper 로 분리.
- **`paused` 처리는 backend 변경 불필요** — plain string + validator 없음. silent drift 위험 0.
