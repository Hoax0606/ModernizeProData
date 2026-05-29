# 2026-05-27 — execution-run-lifecycle-done (Jiyeong Im)

`execution-arch6-and-wiring-plan` 의 8 스트림 중 **S2(Run 라이프사이클) + 후속(S5/S8/병렬적재/stage-cache)** 완료. S1(표시·버튼)은 `2026-05-27-S1-execution-rewiring-done` 에서 별도 완료, 이번에 **pause 버튼만 실 BE 연결**.

## 한 일 (전부 commit 됨)
- **S2 Run 라이프사이클** (`44fa3eb`): `RunControlRegistry` + `RunStatus.paused` + `POST /runs/{id}/abort|pause|resume` + 부분실행(`StartRunRequest.tables`) + `AsyncConfig` threadpool + **하이브리드 stage 게이트**(`LocalWorkerExecutor`: critical stage throw/failed → downstream skip + run failed) + `RunTimeoutSweeper`(180분) + `finishRun` terminal guard.
- **S5** 컬럼 combine `CONCAT` (`3683864`) · **Audit PK 중복** (`843a7c6`) · **Load upstream-failed 테이블 skip** (`cb33cba`) · **Verify 전수 비교** (`aecedb5`) · **stage-cache opt-in** (`4558baf`) · **S8 overview 실데이터** (`18ced48`) · **병렬 적재 opt-in** (`c36f6c8`).
- **S1 pause 연결** (`3d7ed61`): `runsApi.pause/resume`, `mapBeRunStatus('paused')→running`+`pausedAt` 으로 isPaused 판정, RunHeader pause 버튼 demo 가드 제거.

## 다음 사람이 할 일
**현재 7 stage 가 end-to-end 로 green 이 안 나는 건 엔진이 아니라 설정/데이터 3건** (`S1-rewiring-done` 노트 참조):
1. `env=on-prem` TO-BE DB 접속 설정 미설정 → Check/Load/Verify 실패.
2. AS-IS CSV 부재(`EMPLOYEES.csv` 등) 또는 mapping AS-IS 테이블명 불일치.
3. `SqlComposer` alias 버그 — 생성 SQL 은 `a./c./...` 인데 FROM 은 `AS "asis"` 고정 → Binder Error (S5).

이 3건이 풀리면 게이트·부분실행·pause 가 실제로 검증됨.

## 함정 / 결정
- 하이브리드 게이트는 이제 **구현됨** — `S1-rewiring` 노트의 "gate 미구현" 은 해소. `buildStagesFromStageViews` 의 downstream `pending` 회색 path 가 추가 수정 없이 작동할 것.
- pause 는 **동기 실행 → stage 경계에서만** 멈춤(긴 stage 반응 지연). real elapsed 라벨은 정지 중 wall-clock 으로 흐름(표시상 차이).
- 병렬적재·stage-cache 는 **기본 OFF(opt-in)** — 정합성 우선. stage-cache 는 whole-run all-or-nothing + fingerprint 가드, cutover 제외.

## 안 한 것 (의도적)
- EBCDIC. Worker 실제 분산(in-process only — S7 미착수). batchId(Spring Batch job 미사용이라 moot). WS push(2s 폴링으로 충분 — 옵션). S6 multi-env Load. 폐쇄망 encoding 확장 번들링(인스톨러 패키징 후속).
