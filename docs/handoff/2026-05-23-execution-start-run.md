# 2026-05-23 — execution-start-run (Jiyeong Im)

## 한 일 (오늘)
- **Pre-flight UX 개선**: 토글 기본 펼침, ↺ Reset 버튼 (테스트용), `?demo=preflight` 의 demo 8개 모두 fail 로 통일해 8개 Fix 흐름 한 번에 시연.
- **approved-snapshot 검사 정정**: phase 기반 추론 → `useSnapshotsStore` 의 실제 approved snapshot 존재 직접 검사. snapshot 삭제 후 phase 가 sign-off 에 남는 거짓 pass 케이스 해결.
- **`SnapshotSelector` 패널 신설** (`ExecutionPage.tsx`): TableSelector 와 같은 패턴. approved 가 아닌 스냅샷도 선택 가능. `executionPreflight` store 에 `selectedSnapshotId` 영속화.
- **하이라이트 통일**: 모든 Fix 도착지 강조를 `DdlSchemaPanel` 의 teal border + glow 정적 효과로 일원화. `.mpd-fix-highlight` CSS (외곽 2px deep teal + 4px glow). 다중 row 동시 강조 (`querySelectorAll`).
- **i18n 정정**: `tobe-bindings` 의 detail 텍스트를 table-level routing 의미로 (ko/ja/en × pass / demo-fail).
- **Start run 활성 단순화**: `canStart = preflightPassed` 만. mappingReady phase 배열 제거.
- **워커 권한 게이팅 도입 → 다시 원복**: ExecutionPage 의 TableSelector/Pre-flight/Reset/Start 를 worker 면 본인 executionAssignee 프로젝트만 가능하게 했다가, 사용자 결정으로 원래대로 (`store/readOnly.ts` 의 `isProjectExecutionReadOnly` 와 hook 도 제거).
- **Fix 도착지**: `approved-snapshot` Fix → `/versions` (프로젝트 단위 스냅샷 페이지). `tobe-bindings` Fix → `/mapping` Table binding 패널 강조.
- **Demo 모드 fixture**: `?demo=preflight` 진입 시 가짜 site/project/AS-IS·TO-BE DDL 스키마 자동 inject. `useDemoMode` (sessionStorage 기반) 으로 페이지 navigate 후에도 demo 유지.

## 다음 사람이 할 일 — Start run 흐름 재설계 (사용자 요청)

요구사항:
1. **StartRunDialog 모달 삭제** — Start 버튼 클릭 시 모달 없이 즉시 trigger.
2. **선택된 테이블만 파이프라인 시작** — TableSelector 의 `selectedTables` 만 대상.
3. **phase = 'test'** 로 변경 + chip 색 초록 → Pipeline stages 의 `Verify` 까지 완료되면 chip 회색.
4. **Start 클릭 후 Pause 버튼만 활성**, 다른 모든 컨트롤 비활성.

결정 대기 (사용자 — 내일 첫 질문 4 개):
- **D1**: simulation 방식 (frontend mock vs 백엔드 run engine 호출)
- **D2**: Verify 완료 후 상태 (`runStatus = 'completed'` + phase 그대로 vs phase 자동 전환)
- **D3**: simulation 진행 속도 (각 stage 가 몇 초? 총 길이?)
- **D4**: activeRun mock 의 store 위치 (ExecutionPage local state vs store 영속)

추가 보류 plan: "approved-snapshot 체크 항목 자체 삭제 + Start run 활성 조건에 `selectedSnapshotId` 포함" — Start run 재설계와 같이 처리하는 게 자연스러움.

핵심 코드 위치:
- RunHeader 함수: `ExecutionPage.tsx` L173 부근
- StartRunDialog: `ExecutionPage.tsx` L703 부근
- `BASE_STAGES` (7 stage 정의): L928-936
- `buildStages(phase)` (phase 별 stage 진행 상태): L938-962
- `animateStages(stages, tick, running)` (tick 기반 pct 증가): L964-971
- `projectApi.update` 패턴: `store/workspace.ts:309, 325, 340` (cutover 흐름 참고)

## 함정 / 결정 이력
- **권한 게이팅 두 번 뒤집힘**: ExecutionPage 의 worker readOnly 처리 추가 → 사용자 결정으로 다시 원복. `store/readOnly.ts` 의 `isProjectReadOnly` (mapping/general assignee 용) 만 유지. ExecutionOverviewPage 의 `isSelectable` / `isMine` 는 그대로 (worker 본인 행만 체크 가능).
- **`canStart = preflightPassed` 만**: 어느 phase 든 Pre-flight pass 면 Start run 활성. phase 별 mode 매핑 (test/rehearsal/cutover) 은 사용자 팀 논의 대기 — 그 결정과 Start run 재설계가 연결됨.
- **`approved-snapshot` 검사**: phase 기반 추론 → snapshots store 기반으로 변경했지만, SnapshotSelector 추가 후 다시 "선택된 snapshot 의 status approved" 로 변경. 사용자 다음 결정 = "체크 자체 삭제 + Start run 게이트로 옮김" — 보류 중.
- **Demo mode 의 phase 모델 충돌**: demo 의 approved-snapshot 이 fail/skip 으로 표시되지만 demo fixture 의 project.phase 는 'test'. 실 흐름과 다름 — demo 는 시각 검증용.
- **하이라이트 강조 효과**: navy outline (굵은 선) → mpd-fix-pulse animation → DdlSchemaPanel 정적 효과 (.mpd-fix-highlight) 세 단계 거쳐 통일. 모든 Fix 도착지가 같은 톤.
- **`mpd-fix-highlight` 의 box-shadow**: layout shift 없도록 inset 대신 외곽 2px solid + 4px glow (box-shadow stacking).

## 안 한 것 (의도적으로)
- StartRunDialog 모달 삭제 — 사용자 명시 요청이지만 4개 결정 대기 항목이 남아 있어 내일 진행.
- Pipeline stages 의 mock simulation 진행 로직 — D1·D3 결정 후 구현.
- 활성 run 중 모든 컨트롤 disabled 처리 — Start 흐름 구현과 묶여 있어 보류.
- phase chip 표시 위치 — 현재 RunHeader 에 없음. 내일 추가 위치 결정 + 구현.
- `approved-snapshot` 체크 항목 제거 + Start run 게이트로 이전 — 이전 plan 보류 상태. Start 재설계와 같이.
- `mappingReady` phase 배열 제거 — 이미 했지만 내일 phase 모델 정정 시 다시 검토 가능.
- handoff 노트의 후속 정리 (다른 사람이 Pre-flight test 모드 진입 추가 등) — 팀 논의 후.

## 다음 AI 세션 시작 시 권장 흐름
1. **`CLAUDE.md`** 읽기 (1회)
2. **`docs/ONBOARDING.md`** 훑기 (특히 §18 Pre-flight Gate)
3. **이 handoff 노트** 읽기 (`docs/handoff/2026-05-23-execution-start-run.md`)
4. **plan 파일** 읽기 (`~/.claude/plans/tranquil-booping-finch.md` 의 "Start run 흐름 재설계 (내일 재개)" 섹션)
5. 사용자에게 한 줄 확인: "어제 Start run 흐름 재설계 plan 이어받으면 되나? D1-D4 결정 먼저 받고 싶은데."
6. 사용자 D1-D4 결정 받은 후 실제 코드 변경 진행.

## 작업 환경 메모
- ExecutionPage.tsx 가 약 1000 라인 — buildPreflightChecks / buildDemoPreflightChecks / SnapshotSelector / TableSelector / PreflightPanel / RunHeader / StartRunDialog 가 한 파일에 모두 있음. 큰 변경 시 컴포넌트 분리 검토 가능 (이번 작업의 범위 밖).
- demo URL `?demo=preflight` 로 들어가면 가짜 데이터 + Pre-flight 8 fail 시연 가능. Start 흐름 검증도 demo 안에서 가능.
- 진행 중 merge (UU) 4 파일 (`SiteSettingsModal.tsx` / `AppShell.tsx` / `MappingPage.tsx` / `ONBOARDING.md`) 은 origin/dev 와의 충돌이지만 ExecutionPage 와 무관. 해결은 별 작업.
