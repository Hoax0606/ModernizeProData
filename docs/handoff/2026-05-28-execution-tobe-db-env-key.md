# 2026-05-28 — execution-tobe-db-env-key (Jiyeong Im)

`execution-run-lifecycle-done` 의 1번 blocker(`config not set for env=on-prem`) 해소.

## 한 일
- merge `origin/dev`→`feature/execution` 충돌 2건 union 해결: `DdlImportService`(주입 필드 4개), `ExecutionPage.tsx`(import). 양쪽 추가분 전부 사용 확인.
- **env 키 정렬**: `CheckStage`/`LoadStage`/`VerifyStage` 가 `tobeDbByEnv` 를 `site.getTobeEnv()`(인프라 종류 `SiteEnv`: `on-prem`/`mainframe`…)로 조회하던 것을 `site.getEnvironment()`(운영 단계 `ProjectEnvironment`)로 수정. `Site.getActiveTobeDbConfig()` 헬퍼로 단일화.

## 다음 사람이 할 일 (특히 스테이지 작성자 `73cd53c`)
- **검토 근거**: `tobeDbByEnv` 는 타입부터 `Record<ProjectEnvironment,_>`(`workspace.ts:34`), FE 저장(`SiteSettingsModal.tsx:152`)·`preflightValidation.ts:256`·`DdlImportService`·`RunService` 전부 `environment` 키. 스테이지만 `tobeEnv` 쓰던 outlier → 의도 정렬이지 설계 변경 아님. 이견 있으면 핑.
- **검증(Step 2)**: 5433 컨테이너에 `CREATE DATABASE tobe` → SiteSettings 현재 stage 에 접속정보 입력 → run 起動해 `conn-tobe` pass 확인.

## 함정 / 결정 이력
- `Site` 에 env 필드 3개(`asisEnv`/`tobeEnv`=인프라 종류, `environment`=운영 단계) 혼동 주의.
- **별도 버그(미수정)**: `RunService.PROD_ENV="prod"` vs FE `"production"` → prod 사이트에서 `isProd=false`, cutover 게이트 오작동 가능.

## 안 한 것 (의도적으로)
- blocker #2(AS-IS CSV 부재) / #3(`SqlComposer` alias) — Load 실적재까지 green 은 별도 작업.
- `DdlImportService.resolveDialect` 헬퍼 통일은 merge 커밋 순수성 위해 보류(원래도 `environment` 사용).
