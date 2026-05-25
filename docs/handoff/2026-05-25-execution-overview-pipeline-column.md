# 2026-05-25 — execution-overview-pipeline-column (Hiroyuki Onda)

## 한 일

All projects 의 Execution overview 표 개선 + pipeline 진행 표시 통합 (FE only, BE / migration 무변경).

- **Pinned snapshot 컬럼 신설**: 각 project 의 pinned snapshot version / name 을 표시. `usePinnedSnapshotsStore` + `useSnapshotsStore` 에서 derive. 이름 길면 ellipsis + hover title 로 full name 노출. 컬럼 폭은 `width=150` + 내부 `maxWidth=140` 로 고정 — `table-layout: auto` 라 충분한 강제력은 없으니 추후 컬럼이 추가되면 조정 필요.
- **Progress 컬럼 → Pipeline mini-bar 치환**: 기존 단일 progress bar (`0%`) 대신 7 stage (check / extract / reconcile / transform / audit / load / verify) 의 컬러 mini-bar 가로 나열. `activeRun` 이 없으면 phase 기반 fallback (`hypercare/done` → 전 stage 회색, 그 외 → 전 stage 앰버).
- **`lib/pipelineStages.ts` 신규** — `ExecutionPage.tsx` 에 사적이던 `BASE_STAGES` / `buildStages` / `buildStagesFromActiveRun` / `computeElapsedMs` / `STAGE_MS` 등을 공유 util 로 분리. `ExecutionPage` 와 `ExecutionOverviewPage` 양쪽이 import.
- **stop 직후 progress 계속 자라는 버그 수정**: `ActiveRunState` 에 `haltedAt: number | null` 추가. `failActiveRun` / `abortActiveRun` 시점에 `Date.now()` 고정, `retryActiveRun` 에서 null reset. `computeElapsedMs` 의 ref 우선순위는 `pausedAt → haltedAt → Date.now()`. persist `version: 2 → 3` migrate 로 옛 cache 의 `haltedAt` 결손 자동 보정.
- 그 외: 컬럼 별 정렬 정책 정리 (Tables / Errors / Warnings 중앙 · Columns 우 · Phase / Username 헤더만 중앙), 표 가독성 미세 조정.

## 다음 사람이 할 일

1. **list 폭 정밀 제어가 필요해지면 `table-layout: fixed` 화** — 현재 long Project / Pinned name 이 들어오면 다른 컬럼을 밀어낼 수 있음. Progress 컬럼이 백엔드 실데이터 (현재 mock) 로 교체될 때 폭 요건이 커지면 같이 진행 권장.
2. **Pipeline mini-bar 의 backend 연결**: 지금은 `useExecutionPreflightStore` 의 mock simulation 만 본다. 실제 run engine 이 들어오면 `activeRun` 갱신 소스를 WS 이벤트로 교체. `lib/pipelineStages.ts` 의 derive 함수는 그대로 재사용 가능.
3. **Pre-flight 8-check 결과의 노출 여부**: Progress 컬럼은 의도적으로 pipeline (실행 중 진행) 만. pre-flight readiness 를 표 안에서 보여줄지는 미정 — 현재는 ExecutionPage 진입 후에만 확인 가능.

## 함정 / 결정 이력

- **컬럼 정렬을 td/th 별도로 분기한 이유**: 헤더만 가운데로 했더니 td 우정렬과 시각적 어긋남이 컸음 → "컬럼 성질에 맞춰 헤더·셀 모두 같은 정렬" 로 통일. 단 `Columns (done / total)` 만 향후 자릿수가 커질 것을 보고 우정렬 유지.
- **Pinned 컬럼 셀이 isolate 가 어려운 이유**: `table-layout: auto` 에서 td 자체의 `maxWidth` 가 거의 무시됨. inline-flex wrap (`pinnedCell` `maxWidth=140`) + 자식 span 에 `display:block; maxWidth=140; ellipsis` 로 우회 — 완벽한 fixed 화는 향후 PR 에서.
- **`haltedAt` 신규 필드를 둔 이유**: `pausedAt` 재활용도 검토했으나 `isPaused = pausedAt !== null` 판정이 곳곳에 박혀 있어 `aborted` 시에도 paused 로 오해석되는 부작용. semantic 분리 우선.
- **`computeElapsedMs` import 누락 사고**: `lib` 추출 시 ExecutionPage 의 import 에 함수 하나 빠뜨려 Start run 이 runtime 에러로 죽었던 적 있음. `tsc --noEmit` 만으로 OK 보지 말고 dev server 에서 한 번 flow 통째 확인할 것.
- **persist v2 → v3 migration 은 비파괴**: 옛 activeRun 의 `haltedAt` 만 null 채움. selection / snapshot / preflight 결과 / runCounter 는 모두 보존.

## 안 한 것 (의도적으로)

- **데이터 셀의 실측 폭 / 행 높이 측정 없음** — `width={N}` 은 hint 수준 (`table-layout: auto` 라 보장 안 됨). 정밀 layout 은 Progress 백엔드 연결 시 같이.
- **분수 (예: `2 / 7`) 표시 추가 안 함** — 사용자 판단으로 mini-bar 만 두는 게 더 깔끔하다고 결론.
- **Pinned 컬럼에 pin 아이콘 안 붙임** — 한 번 붙였다가 사용자 판단으로 제거. 같은 행을 보면 Versions 페이지의 pin 과 1:1 대응이라 굳이 시각 중복 안 줌.
- **ONBOARDING.md / CLAUDE.md 갱신은 별도 task** — 본 handoff 와 함께 다음 단계로 처리 예정.
