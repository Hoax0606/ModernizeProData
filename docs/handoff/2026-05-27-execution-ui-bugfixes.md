# 2026-05-27 — execution-ui-bugfixes (onda)

## What was done

3 件の Execution / 設定 UI bug fix.

- **Fix highlight pulse 永続 bug** (`SiteSettingsModal.tsx` + `AppShell.tsx`):
  csv-arrived / conn-tobe の Fix ボタン押下時に SiteSettings 該当 section が pulse
  しなかった + 一度 pulse すると永続的にハイライト残る 2 重 bug.
  - AppShell が Modal に `highlight={...}` で渡してたが Modal は `focus` prop を期待.
    値も `'csv'` ↔ `'asis-csv'` の不一致. AppShell line 968 で `focus` 도 boundary 변환.
  - AppShell 가 `siteSettingsHighlight` 를 1 초후 null 로 reset → focus 가 변화 →
    Modal useEffect cleanup 가 pulse-off (1.5 초) timer 까지 cancel → pulse 영구.
    Cleanup 에서 scroll timer 만 cancel 하고 pulse-off 는 자연 fire 시키도록 수정.
- **deriveRunMode: non-prod + ready 를 block** (`ExecutionPage.tsx`):
  仕様「ready 期의 startrun 은 production 限定」が崩れて non-prod + ready 도 'test'
  허용으로 떨어졌던 것을 수정. block 대상은 ready / cutover / hypercare / done 의 4 phase.
- **Start run 시 sidebar chip flicker 修正** (`workspace.ts` + `ExecutionPage.tsx`):
  analysis → startrun 했을 때 一瞬 「test pink (=running)」→ 「test 색없음 (=non-running)」
  로 변하는 bug. `setProjectPhase` + `setProjectRunStatus` 의 2 BE call 병렬 race 가
  원인. 새 action `setProjectPhaseAndRunStatus(projectId, phase, runStatus)` 를 추가해서
  단일 BE 호출 + 楽観 update 동기 적용으로 race 회피. handleStartRun 의 2 call 을
  1 call 로 통합.

## What the next person should do

- 다른 브랜치 (per-table run tracking) 머지 후 polling 동작 확인 필요. 10 초 폴링이
  `fetchProjects` 로 runStatus 를 stale 데이터로 덮어쓸 가능성 있음 (오늘 의심 했지만
  적용 한 atomic update 만으로 충분히 회피되는지 실 환경에서 확인).
- `AppShell.tsx` 의 `siteSettingsHighlight` (1 초 reset timer) 와 modal 측 pulse (1.5 초)
  의 의미가 분리된 채로 共存. 통합/리네임 정리해도 됨 (현 동작은 문제 없음).
- Sidebar chip 色 룰 — `phaseColors(phase, runStatus)` 가 `test/rehearsal/cutover` 에서
  `runStatus !== 'running'` 일 때 무색 반환. run 완료 후 (status='completed') 도 무색에
  들어가는 점이 UX 상 의외 (run 끝나면 색이 빠짐). 「실행중만 색」 모델은 의도적인지
  「액티브 phase 는 항상 색」 모델로 변경하고 싶은지 사용자 의향 정리 필요.

## Pitfalls / decision history

- AppShell 의 1 초 reset 와 Modal 의 1.5 초 pulse 가 동일 effect 사이클에 묶이면
  cleanup 가 다음 사이클의 timer 까지 잡아먹는다. React useEffect cleanup 의 「부작용
  취소」 패턴은 「다음 effect run 까지 적용되는 부작용만 cancel」 이라는 원칙을
  지켜야 한다 (1.5 초 후 발사하는 setState 는 이펙트의 부작용이지만 다음 사이클까지
  유효하지 않으므로 cancel 하면 안 됨).
- `setProjectPhaseAndRunStatus` 는 楽観 update 를 동기적으로 먼저 적용 (다른
  `setProjectXxx` 들은 BE → set 순). UI 즉시 응답성을 위함. BE 실패 시 console.error
  만 남기고 store 는 롤백하지 않음 — mock 환경 보전 + run 시 UI lockup 회피 목적.
- `deriveRunMode` 의 「non-prod + ready = test 허용」 은 2 일 전 정정 작업에서
  순서 조건문 누락으로 발생한 regression. 매트릭스 (4 phase × 2 env) 가 작아서
  직접 if 체인이 깔끔하지만, 추후 phase 추가 시 enum-based table look-up 로
  바꾸는 것 검토 가능.

## Intentionally not done

- ONBOARDING §18.4 의 표 갱신 (이번 handoff 와 같이 묶어 commit).
- CLAUDE.md 의 Pre-flight 한 줄은 deriveRunMode 의 디테일을 언급하지 않으므로 변경 불요.
- BE side 변경 없음.
- React `border` / `borderColor` shorthand warning — 별건.
