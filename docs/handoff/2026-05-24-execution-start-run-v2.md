# 2026-05-24 — execution-start-run-v2 (Jiyeong Im)

## 한 일
- **Mock pipeline simulation 완성** — `StartRunDialog` 삭제, Start 클릭 즉시 35초 / 7 stage 진행. `startedAt` 기반 derive 라 새로고침 후에도 정확히 복원.
- **State machine 확장** — `ActiveRunState` 에 `failedStageIndex/failureReason` + `runStatus`= running/completed/failed/aborted. `start/pause/resume/finish/fail/abort/retry/clear` 8 actions. Retry 는 실패 stage 처음부터 (Airflow/DBT 표준 atomic 재시도).
- **버튼 레이아웃 6 상태** — running `[Pause][Stop]`, paused `[Resume][Stop]`, completed `[Discard][Start over]`, failed/aborted `[Discard][Retry][Start over]`. `controlsLocked = activeRun!==null` 라 selection 항상 잠김 — Discard 가 풀기 위한 유일 진입로.
- **Demo 격리** — `AppShell` REPLACE 모드: real sites/projects/DDL 백업 → demo 만 노출 → exit 시 복원. polling 도 skip. 신규 `?demo=run-fail` URL (preflight 7 pass) 로 실패 시연 가능.
- **Snapshot UI 정리** — `SnapshotSelector` dropdown → `SnapshotDisplay` (read-only). `approved-snapshot` 체크 제거 (8→7). `selectedSnapshotId` field 는 `/versions` 향후 pinning 용으로 store 에 보존. `execution.preflight.snapshot*` / `approvedSnapshot.*` 죽은 키 10개씩 × 3 lang 삭제. `executionPreflight` persist version 1 으로 옛 캐시 invalidate.
- 커밋 `70fec7c` push 완료 (`feature/execution`).

## 다음 사람이 할 일

### P2 (다음 PR / 사이클)
- **#9** `execution.dialog.*` 20 키 × 3 lang = 60개 죽은 i18n 키 삭제 (StartRunDialog 잔재). 10분.
- **#6** Pre-flight stale invalidation — `setSelected` action 에서 `preflightPhase === 'done'` 이면 results clear. 30분. plan 파일에 코드 스니펫 있음.
- **#5** `/versions` 페이지에 snapshot pin 버튼 → `setSelectedSnapshot` 호출. 그래야 ExecutionPage 의 `SnapshotDisplay` 가 실제 값 표시.
- **#7** 백엔드 run engine 연결 — mock simulation → WS 이벤트. 사용자가 백엔드 작업 시작 후 frontend 의 `useExecutionPreflightStore` 액션 호출 지점 = 연결 포인트.
- **#8** 로그인 redirect 점검 — 사용자가 `?demo=...` 진입 시 로그인 페이지로 튕긴다고 보고. `localStorage.modernize-auth` 의 `expiresAt` 확인 필요. 코드 자체엔 이슈 없을 가능성.

### 직접 검증 (오늘)
- `http://localhost:5174` 새로고침 → 옛 8-체크 캐시 사라짐 확인 (persist v1 효과).
- happy path (실제 project) + `?demo=run-fail` (Simulate failure) + `?demo=preflight` (8 Fix 흐름 유지) 모두 시연.
- Demo isolation 검증 — 사이드바에 demo 만, exit 후 real 복원.

## 함정 / 결정 이력
- **Selection 잠금 두 번 뒤집힘** — 처음엔 `activeRun!==null` 잠금 → "completed 후 풀자" 로 좁힘 → 사용자 결정으로 다시 모든 상태에서 잠금. 새 selection 가려면 Discard 만이 유일 경로. "1 project = 1 run config" 원칙.
- **Reset run 제거 → Discard 재도입** — Reset 은 컨트롤이 unlock 일 때 잉여라 제거 → 하지만 selection 잠금 도입 후엔 비우기 entry 가 필요해서 Discard 로 재등장. 이전 3버튼 (`[Retry][Start run][Reset run]`) 과 모양은 비슷하지만 의미 다름.
- **버튼 라벨 ko/ja 영문 통일** — CLAUDE.md i18n 정책상 버튼 라벨 (Pause/Resume/Stop) 은 모든 언어 영문. `다시 실행` / `폐기` 도 `Start over` / `Discard` 로 일관성 맞춤. 툴팁(`*Hint`) 은 언어별 번역 유지.
- **Retry semantic** — failed stage 의 **처음부터** 재실행 (mid-stage resume 아님). 데이터 정합성 표준 — Airflow / DBT / Spring Batch 다 같은 패턴. plan 파일에 근거 기록.
- **Aborted 도 Retry 가능** — failed 와 동일. user-cancelled run 도 Spring Batch restart 처럼 멈춘 stage 부터 재개 의미 있음.
- **failed 와 aborted 시각 구분** — failed = err(빨강) stage + 빨강 banner ❌, aborted = idle(회색) stage + amber banner ⏹. tone 으로 구분.
- **Persist version bump = 사용자 영향** — localStorage 의 옛 8-체크 데이터 invalidate. 사용자가 보던 결과 한 번 사라짐 — 다시 Pre-flight 돌리면 회복.
- **Demo polling skip** — AppShell 의 10s sync interval 이 demo 중에 fetch 하면 백업한 real data 덮어쓰기. `isDemoRef` 로 skip.

## 안 한 것 (의도적으로)
- 백엔드 run engine 연결 (P2). 데이터 모델만 production-ready — `run_status` 가 `'failed'/'aborted'` 받을 수 있게 frontend 측 완성. 백엔드는 VARCHAR(16) plain string 이라 마이그레이션 불필요.
- `execution.dialog.*` 20 키 × 3 lang 청소 — StartRunDialog 삭제했지만 i18n 잔재. P2 #9 로 분리.
- Pre-flight stale 자동 invalidation (P2 #6) — 사용자가 selection 바꿔도 옛 결과 stale 하게 남음. setSelected 액션 1줄 수정으로 해결 가능, plan 파일에 코드 있음.
- `/versions` 페이지 snapshot pinning UI (P2 #5) — SnapshotDisplay 가 의미 있게 보이려면 누군가 `setSelectedSnapshot` 호출해야. /versions 페이지에 pin 버튼 추가 필요.
- Mid-stage resume (사용자의 옵션 b) — fine-grained checkpoint 없으면 불가. 백엔드 stage 별 checkpoint 모델 잡힌 후 재검토.
- Skip-on-error mode (옵션 e) — advanced. 데이터 정합성 위험 큰 모드라 별도 UI 필요. P2.

## 다음 AI 세션 시작 시 권장 흐름
1. `CLAUDE.md` 읽기
2. `docs/ONBOARDING.md` 훑기 (§18 Pre-flight Gate)
3. 이 handoff 노트
4. plan 파일: `~/.claude/plans/elegant-bubbling-crown.md` (P2 첫 묶음 코드 스니펫 포함)
5. 사용자에게 한 줄 확인: "어제 마무리한 Start run v2 이어서 P2 진행할지, 백엔드 연결 시작할지?"

## 작업 환경 메모
- `ExecutionPage.tsx` 1240 라인 (이전 1167 → +73). 분리 검토 가능 (RunHeader / SnapshotDisplay / PreflightPanel 등) — 이번 범위 밖.
- demo URL 두 개: `?demo=preflight` (8 Fix 시연) vs `?demo=run-fail` (실패 시연). 둘 다 같은 fixture 사용.
- dev server 포트 5174 (5173 점유 중).
- 사용자가 보고한 "로그인 redirect" 이슈는 코드보다 localStorage 만료 가능성. 점검 필요.
