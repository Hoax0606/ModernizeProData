# 2026-05-27 — execution-arch6-and-wiring-plan (Jiyeong Im)

(worker-stage-runner 노트 이후 작업. 그 노트가 "join/union·CP2·encoding 등 = PoC 2차" 라 했던 항목들을 이번에 구현 완료했다.)

## 한 일 (전부 commit 됨)
architecture 다이어그램 대비 미구현 6항목 + 대용량 대비:
- **③ JOIN/UNION** — `SqlComposer` 신규, Extract/Transform/Reconcile/Check 를 AS-IS source 기준으로. CSV 파일명 컨벤션 `{tobe_table}.csv` → `{asis_table}.csv`.
- **⑦ 검증 깊이** — Audit: length/type/range (`TRY_CAST`/`LENGTH`/`DECIMAL(p,s)`), Verify: row count 일치 시 PK 정렬 비교. 값 비교는 의도적 제외(Load=단순 COPY, 포맷 오탐 방지).
- **⑤ CP2 분기** — `runType=cutover` 면 parquet2 생략.
- **⑥ Loader FK 비활성화** — `PgCopyManager.tryDisableConstraints` (`session_replication_role=replica`), superuser 권한 없으면 경고 후 skip (graceful fallback).
- **② encoding** — DuckDB `encodings` 확장 (`shift_jis`/`EUC_JP`), `DuckDbService` 에서 INSTALL/LOAD. EBCDIC 은 예외 처리(미지원).
- **② 대용량 spill** — prod 만 파일모드(`application-prod.yml`), `temp_directory` 공통, run 시작 시 `run_*` schema sweep(실행중 run 제외). `memory_limit` 은 기본(80% RAM) 위임.

## 다음 사람이 할 일
**다음 작업 = Execution Pipeline 버튼·진행률 실 backend 연결 + 부분실행. 상세 plan: `~/.claude/plans/streamed-jingling-candle.md`** (개인 plan 파일 — 내용은 아래 요약).
- **범위 결정**: Oracle CSV → Postgres PoC. **EBCDIC 빼고 deferred 항목 전부 이행.**
- **충돌 없는 8 스트림 분담** (파일 소유권 기준, 만나는 곳은 API 계약뿐):
  - **S1 실행화면** `ExecutionPage.tsx`/`pipelineStages.ts`/`executionPreflight.ts`/`api/runs.ts` — 진행률·버튼·run history·panels
  - **S2 Run 라이프사이클** `RunService`/`RunController`/`RunExecutionListener`/`LocalWorkerExecutor` — 부분실행/pause/abort/stage-gate/timeout (RunStatus enum 은 S2 만)
  - **S3** Reconcile PK중복 · **S4** Verify 전수 · **S5** Transform 컬럼 combine · **S6** Load(conn pool, multi-env) · **S7** multi-worker(`worker_nodes` 마이그레이션 1개) · **S8** Overview 페이지(별도 controller)

## 함정 / 결정
- ⚠️ **폐쇄망 encoding**: `INSTALL encodings` 는 인터넷 다운로드 → 현장 air-gapped 배포 시 확장 바이너리(`.duckdb_extension`, DuckDB 버전+win64 종속)를 **인스톨러 동봉 필요** (jpackage 패키징 후속, 미완).
- **버튼·진행률은 현재 mock 시뮬레이션**(`executionPreflight` store + `STAGE_MS` 타이머). 실 backend 는 준비됨: start=`POST /runs`, 진행률=`GET /runs/{id}/stages`(2s 폴링 의도), abort=`RunService.abortRun`(단 실행 thread 강제중단은 아직 X).
- **부분실행**: 현재 `startRun` 이 선택 무시하고 전체 binding 처리 → `StartRunRequest.tables` 추가해 필터 예정.
- **DuckDB sweep 정리 대상 = 임시 작업 schema 뿐.** 메타DB·TO-BE DB·Parquet 산출물 무관.

## 안 한 것 (의도적)
- 버튼 wiring 실제 코드 (plan 까지만). EBCDIC. Verify 전수(샘플 100행 유지). 진짜 pause / abort thread 중단 (PoC 2차).
