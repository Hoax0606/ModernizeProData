# 2026-05-24 — scheduler (Hiroyuki Onda)

Branch: `feature/schedule`. 전체 미 commit 상태 (working tree + untracked) — PR 직전.

## 한 일

Coordinator 측 Scheduler 기능 full 구현 (BE / FE / Flyway migrations / CLI module / i18n).

### BE 신규
- `coordinator/run/` — `RunService` (공통 실행 입구, `SELECT FOR UPDATE` lock, run_history insert, WS dispatch), `RunHistory`, `RunType` / `TriggerSource` / `RunStartStatus` enum.
- `coordinator/schedule/` — `SchedulerInitializer` (Quartz trigger 起動時 + 설정 변경시 재구축, common / individual mode 분기), `NightlyRehearsalJob`.
- `coordinator/auth/` — `ApiCredential` + `ApiTokenAuthFilter` + `WorkerTokenAuthFilter` + `CredentialService` (외부 token paste 등록, `mig_` 接頭辞 制約 撤去, `WK-` / JWT 형식 skip 로직).
- `coordinator/api/` — `RunController` (`/runs`, `/runs/all`), `CredentialController`, `InternalRunController` (Worker callback), `ScheduleController`, `SolutionSettingsController`.
- `coordinator/dispatch/WorkerDispatcher` — STOMP `/topic/worker/{workerId}/tasks` 로 RUN_START envelope publish.
- `common/util/HashUtil` — SHA-256 hex 공통 (TokenGenerator 삭제하고 `DdlImportService` 의 private 도 통합).
- `coordinator/common/InternalMode` — enum (common / individual). String 비교 撤去, `@Enumerated(EnumType.STRING)` 으로 persist.

### FE 신규
- `pages/SchedulerPage.tsx` — Internal/External card + mode 선택 + 平文 token register + Trigger examples docs (URL/token/project ID 임베드).
- `api/{credentials,runs,schedule,solutionSettings}.ts`.
- `lib/formatters.ts` — `toHHmm` / `toHHmmss` / `formatTimestamp` / `formatDuration` (SchedulerPage + SettingsPage 의 중복 helper 통합).
- 3 언어 i18n keys 추가 (`scheduler.internal.*` / `scheduler.external.*` / `scheduler.external.docs.*` 등).

### Migration (5 개로 consolidate 완료)
- `V20260522210000__add_project_schedule_columns.sql`
- `V20260522210001__drop_project_cutover.sql`
- `V20260522210002__run_history.sql`
- `V20260522210003__api_credentials.sql` (⚠ `token_plain` 평문 컬럼 포함 — PoC 요건, security 妥協)
- `V20260522210004__solution_settings.sql` (`internal_mode` / `internal_common_time` / mutex CHECK)

### simplify pass 완료
- 미사용 i18n keys 24 개 + styles 13 개 + Phase X 작업 이력 코멘트 일소.
- B1 (formatters) / B2 (HashUtil) / B3 (InternalMode enum) / C5 (`RunController.startRun` 의 double project lookup 제거) 적용.

## 다음 사람이 할 일

1. **PR 前 동작 확인**:
   - `psql` 로 reset SQL 실행 (`DROP SCHEMA public CASCADE; ...` — handoff 외부에 별도 메모) → BE 재기동 → Flyway 5 migration apply 확인.
   - Master 로그인 → site/project 작성 → External integrations ON → External URL 입력 → token paste & Register → Trigger examples docs 의 curl 그대로 복사하여 동작 확인.
   - mode=common (전 project 一斉 발화) / mode=individual (project 별 시각 설정) 양쪽 Save 통과 확인.
   - phase semantics: `test` / `rehearsal` / `ready` 에서만 run 起動 가능, `cutover` 는 실행중 phase 로 reject.
2. **commit 전략** — 14 modified + 다수 untracked, 의미별로 분할 추천 (migration / BE entity / BE controller / FE page / i18n / simplify). 또는 한 PR 1 commit 도 가능 (PoC 단계).
3. **trigger source rename 의 hybrid CHECK 정리** — `run_history.trigger_source` 의 CHECK 가 新 4 값 + 旧 3 값 (`nightly`/`rest`/`manual_ui`) 모두 받게 되어 있다. 旧 row 가 사실상 없으면 旧 3 값을 떨어뜨려도 됨 (별 migration 로).
4. **CLI module 의 token 길이 검증** — `cli/RunCommand.java` 측에서는 token 길이 16 자 미만 reject 안 됨 (BE 만 체크). 일관성 위해 CLI 측에도 검증 추가 검토.

## 함정 / 결정 이력

- **Token 평문 DB 보관** — Phase 6 에서 hash 만 보관 설계였으나, 「register 한 token 을 별 session / 다른 master 가 평문으로 보고 싶다」「Trigger examples docs 에 임베드해 그대로 copy-paste 하고 싶다」 요건이 나와서 **`api_credentials.token_plain` 列 추가 + DB 평문 보관** 으로 굴복. 각 코드에 「⚠ PoC 요건, security 妥協」주석 명시. production deploy 전에 客 security policy 와 정합성 재확인 필수.
- **/runs/all 의 대상은 全 project** — 旧 설계는 `findByScheduleStartTimeIsNotNull()` 였지만, mode=common 에서 `schedule_start_time` 가 NULL 이라 0건 되는 버그 노출 → `findAll()` 로 변경. phase eligibility check (`resolveRunTypeFromPhase`) 가 reject 처리하므로 二重 safe.
- **Phase semantics 변경**: `cutover` phase 는 **실행중** 상태로 격상 (run 起動 不可). `ready` 가 cutover 起動 phase. `RunService.resolveRunTypeFromPhase` 참조.
- **External URL 입력 復活** — 한 번 「customer 가 자기 URL 알고 있으니 필요 없다」로 削除했다가, 「コピペで実行可能」 요건으로 復活. `solution_settings.external_api_endpoint` 列 + UI 입력 + Trigger examples docs 에 substitute.
- **외부 scheduler 종류 dropdown 撤去** — Control-M / JP1 / Senju ... 8 종 dropdown 을 Phase 6 에서 추가했으나 「token 인증에 어차피 사용 안 됨」 으로 撤去. `api_credentials.scheduler_type` 列도 삭제.
- **Trigger source 이름** — DB 値 도 코드 도 `internal` / `external` / `cli` / `manual` 로 통일 (旧 `nightly` / `rest` / `manual_ui` 폐지). 既存 row 는 UPDATE 안 함, CHECK 만 양쪽 허용.

## 안 한 것 (의도적으로)

- **Control-M Workbench / Rundeck / Hinemos 連携 테스트** — Windows 작업 스케줄러 + 別 PC 의 curl 로 case A / case B 動作確認까지 완료. 본격 OSS scheduler 검증은 PoC 2 차.
- **N+1 transaction 해소 (RunController.startAll)** — project 100+ 환경에서 latency 문제 발생 예정, but PoC 단계 (10 미만) 에서는 영향 미미. 본격 운용 直前 에 bulk transaction 化.
- **SchedulerInitializer 의 incremental rebuild** — 起動마다 全 trigger 삭제 + 재등록. project 多時 startup 길어지지만 同上.
- **Token / SolutionSettings cache** — auth hot path 에 Spring Cache 도입 가능. 외부 scheduler 호출 빈도 작은 spec 이므로 생략.
- **TokenRevealModal 컴포넌트** — register flow 에서 token reveal 필요 없어졌으나 `components/TokenRevealModal.tsx` 파일은 untracked 로 남아있음 (dead file). 다음 PR 에서 삭제 OK.
- **Migration consolidate 後 의 旧 migration 잔재 정리** — V20260521163527 ~ V20260522190200 의 旧 migration 들은 이미 삭제했지만, 만약 someone 이 旧 buildup 으로 DB 적용했다면 schema 가 어긋날 가능성. 모두 reset SQL 로 DB 재구축 권장.
