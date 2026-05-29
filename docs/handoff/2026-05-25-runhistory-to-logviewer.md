# 2026-05-25 — runhistory-to-logviewer (Hiroyuki Onda)

## 한 일

- **Run history 위치 이동** — Project Settings → Schedule 탭에 있던 per-project run history 를 `LogViewerPage` 의 3 번째 탭 (`Stream / Quarantine / Run history`) 으로 옮김. Schedule 탭은 내용이 없어져 `PSSchedule` 함수째 삭제, `SectionKey` 에서 `'schedule'` 제거.
- **3 축 client-side 필터 추가** — `Status` / `Type` / `Trigger` dropdown. 적용 대상: LogViewer 의 Run history 탭 (`listByProject`) 과 SchedulerPage 의 Run history 섹션 (`listAll`). 옵션은 현 데이터에 존재하는 값만 derive (Step 필터와 동일 패턴).
- **i18n** — `logs.view.history`: `'Run history'` 를 ko/ja/en 모두 동일 영문 (label 정책).
- **sticky thead bleed 수정** — `historyScroll` 의 `padding:12` 제거 + `borderCollapse: collapse → separate + boxShadow inset border` 로 변경. `collapse` 일 때 sticky 가 죽는 기존 동작 회피.

## 다음 사람이 할 일

- BE log ingest 가 들어왔을 때 `LogViewerPage` 의 `USE_MOCK` 플래그 swap 시 새 history 탭은 영향 없음 — 별 fetch path (`runsApi.listByProject`) 임을 기억.
- 사용 안 하게 된 i18n 키 (`projectSettings.section.schedule.*`, `projectSettings.sidebar.schedule.*`, `projectSettings.head.schedule.*`) 는 이번에 미삭제. 별 PR 에서 grep 후 정리 권장.
- 필터 복수선택 / 시간범위 / chip UI 형태 등은 사용자 명시 의뢰 시 추가.

## 함정 / 결정 이력

- LogViewer 는 active project 스코프 → `listByProject`. Scheduler 는 운영 전체뷰 → `listAll`. 같은 필터 UI 를 양쪽에 mirror 했지만 fetch 함수는 다르다.
- 필터 옵션은 fixed enum 이 아닌 derive — `running (0)` 같은 빈 옵션이 dropdown 에 박혀 보이는 걸 피함. 데이터에서 사라진 값을 선택 중이면 useEffect 로 자동 reset.
- column 헤더 텍스트는 기존 `projectSettings.schedule.history.col.*` 키를 그대로 재사용. 키명과 위치는 어긋났지만 rename refactor 회피.

## 안 한 것 (의도적으로)

- UI 클릭 검증 — tsc / IDE diagnostics 만 통과. `npm run dev` 에서 직접 클릭 확인은 사용자 측에 의뢰함 (메모리 `feedback-refactor-must-verify` 에 정직히 보고).
- CLAUDE.md 추가 — UI 표층 변경이라 갱신 불필요로 판단. ONBOARDING.md 에만 §19 짧게 추기.
