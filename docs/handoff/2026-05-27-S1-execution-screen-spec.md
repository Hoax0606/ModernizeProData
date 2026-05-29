# 2026-05-27 — S1 실행 화면 (Execution Pipeline) 작업 명세

> Execution "EBCDIC 빼고 전부 이행" 작업의 **S1 스트림** (팀원 담당). 전체 분담은 `2026-05-27-execution-arch6-and-wiring-plan.md` 참고. S2(서버)는 다른 사람이 병렬 진행 중 — **소유 파일이 안 겹치고, API 계약으로만 만난다.**

## 목표
ExecutionPage 의 Pipeline 영역(버튼·진행률·실행 이력)을 **mock 타이머 시뮬레이션 → 실 backend 연결**로 교체. 에러 모델 = **하이브리드**.

## 내가(S1) 수정할 파일 — S2와 안 겹침
- `frontend/src/pages/ExecutionPage.tsx`
- `frontend/src/lib/pipelineStages.ts`
- `frontend/src/store/executionPreflight.ts`  (데모 전용으로 격리)
- `frontend/src/api/runs.ts`
- (신규) `frontend/src/hooks/usePipelineProgress.ts`

## 쓸 backend API (계약 — 고정. 이대로 호출하면 됨)
- **시작**: `POST /api/v1/runs` `{ projectId, runType?, tables?(선택 TO-BE 테이블명 배열) }` → `{ runId, status: STARTED|REJECTED|LOCKED, reason }`
- **진행률**: `GET /api/v1/runs/{runId}/stages` → `StageView[]` `{ stageKey, seq, status(pending/running/success/failed), pct(0~100), tablesTotal, tablesSuccess, tablesFailed, startedAt, finishedAt, durationMs, errorSummary, tables[] }`
- **상태**: `GET /api/v1/runs/{runId}` → `{ status(pending/running/success/failed/aborted/timed_out), errorMessage, finishedAt, durationMs }`
- **중단**: `POST /api/v1/runs/{runId}/abort` `{ reason? }`
- (나중) **일시정지/재개**: `POST /api/v1/runs/{id}/pause | /resume`
- 인증: 기존 axios JWT 인터셉터 자동 (`api/client.ts`). 폴링: react-query `useQuery + refetchInterval`(2초), terminal 상태면 멈춤 (`useLogCounts` 패턴 참고).

### 지금 바로 쓸 수 있는지
- ✅ 이미 동작(push됨): **start / stages / get**
- 🔜 S2 가 곧 push: **abort / tables(부분실행) / pause·resume** → 계약 고정이니 FE 미리 작성 가능. 아직인 엔드포인트는 임시로 비활성/숨김.

## 할 일 (체크리스트)
- [ ] `api/runs.ts`: `stages(runId)` 추가, `abort(runId, reason)` 추가, `start` 에 `tables` 인자
- [ ] `hooks/usePipelineProgress.ts`(신규): stages + run 상태 폴링(2초), terminal 이면 중지
- [ ] `pipelineStages.ts`: `buildStagesFromStageViews(StageView[])` 추가 (실데이터→UI 모델). 기존 `buildStagesFromActiveRun`(mock)은 데모 전용 유지
- [ ] `ExecutionPage` 버튼 재배선:
  - Start = `start(projectId, runMode, selectedTables)` → runId 저장 → 폴링 시작
  - Retry = 전체 재실행(새 runId) · Stop = `abort` · Discard = 화면 정리(폴링 중지) · Pause = 실모드 숨김
- [ ] 250ms tick 시뮬레이션 제거 → 폴링 데이터로 렌더
- [ ] ★ **하이브리드 표시**: 끝까지 돈 run = 모든 단계 + 단계별 성공/실패 수 / 게이트로 중단된 run = 이후 단계 `pending`(미실행) 구분 (StageView.status 사용). Retry=전체 재실행
- [ ] 실행 이력 카드 = `runsApi.listByProject` 실데이터
- [ ] 데모 모드(`useDemoMode`)는 기존 mock 그대로 유지

## 주의 (S2와 조율)
- 위 **API 계약(JSON 형태)은 고정** — 바뀌면 S2 담당과 먼저 합의.
- pause/resume 엔드포인트는 S2 후반 → 그 전엔 pause 버튼 숨김으로 두기.
- 에러 모델 하이브리드: 화면이 fail-fast(실패 후 회색) 가정으로 돼 있던 걸, "모든 단계 실행 + 단계별 성공/실패" + "게이트 중단 시 이후 pending" 으로 바꾸는 게 핵심.

## 검증 (최소)
- [ ] `npx tsc --noEmit`
- [ ] backend 띄우고 실제 project Start → Pipeline 이 실 진행으로 표시되는지 1회 확인
