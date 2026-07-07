# Execution 페이지 1차 리뷰 가이드 (PoC1)

본 문서는 Execution 페이지가 실제 백엔드와 실제 데이터로 현장에서처럼 동작하는지 검증하기 위한 **종합 리뷰 가이드**다.
대상 독자: PoC1 시연에 참여하는 팀원 전원.

구성:
1. 라이브 리뷰 체크리스트 (화면에서 확인)
2. 테스트 데이터 커버리지 + 보강 제안
3. Execution 이벤트가 건드리는 DB 테이블 전수
4. 디렉터리 구조 + Coordinator/Worker 하이브리드 모델
5. 그 외 팀원에게 설명해야 할 포인트
6. 알려진 한계 (이번 리뷰 뒤 이어 작업할 P0/P1/P2)

---

## 0. 사전 준비 (리뷰 시작 전)

| 항목 | 확인 방법 |
|---|---|
| 메타 DB 기동 | Flyway 마이그레이션이 정상 적용됐는지 (`flyway_schema_history` 마지막 버전 확인). 본 PoC 기준 `V20260526161635__snapshot_changes.sql` 까지 적용돼 있어야 함. |
| Backend 기동 | `./mvnw spring-boot:run` (profile=`local`) — 콘솔에 `Started ... in N seconds` 출력. |
| Frontend 기동 | `npm run dev` — `http://localhost:5173` 접속. |
| 사용자 로그인 | 운영자(coordinator) 권한 계정. |
| Site 설정 | TO-BE Target DB(현재 active stage = `dev` 등)에 **로컬 PostgreSQL 접속정보 입력**, Test connection 성공, csv_path = `C:\KSINFO\TestData\samples\csv`. |
| Project 준비 | DDL 임포트 (AS-IS + TO-BE), Mapping 임포트(`column_mapping.csv` + `code_mapping.csv`), Snapshot 핀 고정 (mapping). |
| TO-BE DDL 적용 | 로컬 TO-BE PG 에 TO-BE schema (예: `banksys.customers`, `public.employees` 등) 실제로 `CREATE TABLE` 되어 있어야 Load 가 들어감. |

> `0` 단계에서 막히면 그 자체로 PoC 미완성 의미이므로 절대 건너뛰지 말 것.

---

## 1. 라이브 리뷰 체크리스트

화면을 키고 위→아래로 따라가며 **각 항목이 기대대로 동작하는지** 확인한다.
각 항목은 **무엇을 보면 됨** + **OK 기준** + **NG 신호** 를 표기.

### 1-1. 페이지 진입

- [ ] **무엇**: 사이드바에서 해당 project 선택 → Execution 탭 클릭.
- **OK**: 화면이 로드되고, 상단에 phase chip (예: `test`), runStatus chip (`idle`), Pre-flight 패널 + 테이블 선택 카드 표시.
- **NG**: 빈 화면, 콘솔 에러, 401(인증 만료), 500. → 백엔드 로그 확인.

### 1-2. 테이블 선택

- [ ] **무엇**: TO-BE 테이블 목록에서 체크박스로 적재할 테이블 선택.
- **OK**:
  - 체크 후 "Run" 영역의 `N tables selected` 카운터 변동 (선택 수 표시).
  - 전체 체크/해제 토글이 정상.
  - 선택 상태가 **새로고침 후에도 유지** (`zustand persist`).
- **NG**: 0으로 표시되거나, 선택해도 카운터 안 변함 → store/persist 버그.

### 1-3. Run mode 자동 결정

- [ ] **무엇**: 현재 project phase 에 따라 `runMode` 가 결정되는지.
- **OK**:
  - phase=`test` → runMode=`test`, phase=`rehearsal` → `rehearsal`, phase=`ready` → `cutover`.
  - 그 외 phase (planning, analysis, sign-off, hypercare, done) → Start 버튼 비활성 (`runMode=null`).
- **NG**: phase 와 runMode 불일치 → `deriveRunMode` 함수 의심.

### 1-4. Pre-flight 검사

- [ ] **무엇**: 테이블 선택 후 Pre-flight 자동 실행 (또는 trigger 버튼).
- **OK** (7개 체크 모두 표시):
  1. `csv-arrived` — 선택 테이블별 AS-IS CSV 파일 존재.
  2. `ddl-asis` — AS-IS DDL 임포트 됨.
  3. `ddl-tobe` — TO-BE DDL 임포트 됨.
  4. `conn-tobe` — TO-BE DB 접속 가능 (live test 결과 반영).
  5. `tobe-bindings` — 선택 TO-BE 테이블에 binding 존재.
  6. `unmapped-cols` — TO-BE 컬럼이 mapping_rule 로 다 채워짐.
  7. `asis-unmapped` — 사용된 AS-IS 컬럼이 mapping_rule 에 모두 등장.
- **OK**: 각 체크가 `pass / fail / skip` 으로 표시되고, per-table 으로 펼쳐서 어느 테이블이 왜 실패인지 보임.
- **NG**:
  - `csv-arrived` 가 schema 한정 파일을 못 찾는다면 (예: `RECRUIT.APPLICANTS.csv` 가 있는데 "missing" 으로 뜸) → 최근 fix(`{schema}.{table}.csv` 해석) 가 안 들어간 빌드.
  - `conn-tobe` 가 "untested" 로만 떠 있고 통과 안 됨 → SiteSettings 의 TO-BE DB 입력 누락 또는 잘못된 stage(`environment`).

### 1-5. Fix 버튼

- [ ] **무엇**: 실패한 체크에서 Fix 버튼 클릭.
- **OK**:
  - `conn-tobe` 실패 시 → SiteSettings 모달 자동 오픈 (`?siteSettings=tobe-db`).
  - `csv-arrived` 실패 시 → SiteSettings(`?siteSettings=csv`).
  - `ddl-*` 실패 시 → DDL 임포트 페이지로 이동.
  - `unmapped-cols` / `asis-unmapped` 실패 시 → Mapping 페이지 (해당 컬럼 jump).

### 1-6. Start 버튼

- [ ] **무엇**: Pre-flight 전부 pass + 테이블 1개 이상 선택 + snapshot 핀 + runMode 결정됨 → Start 활성.
- **OK**: 버튼 클릭 → `runHistory` 1행 생성 + `projects.run_status='running'` + `stage_instances` 7행(또는 cutover 면 6행) 즉시 등록 → 화면에 active run 카드 표시.
- **NG**:
  - 클릭이 무반응 → 가드(`preflightPassed && selectedTables.size>0 && runMode`) 중 하나 false. 콘솔/하단 alert 확인.
  - 응답에 `REJECTED` / `LOCKED` → 다른 run 이 이미 돌고 있음 (`projects.run_status` 가 running/paused 상태).

### 1-7. Pipeline 진행 표시

- [ ] **무엇**: 7개 stage chip(Check → Extract → Reconcile → Transform → Audit → Load → Verify) 가 순서대로 진행.
- **OK**:
  - chip tone: `idle`(회색) → `running`(파랑/주황) → `ok`(녹색) / `err`(빨강).
  - per-stage 진행률 `N/M tables` 가 BE 폴링(2초)에 맞춰 갱신.
  - elapsed 라벨이 **실시간 wall-clock 기반**(이번 수정), 35초 cap 없음, 가짜 ETA 미표시.
  - `N tables` 요약이 실제 선택 테이블 수 표시 (이번 수정).
- **NG**:
  - 모든 stage 가 0%에서 멈춤 → BE 폴링 실패 또는 stage 실제로 안 도는 중. `usePipelineProgress` 또는 BE 로그 확인.
  - elapsed 가 0:35 에서 멈춤 → 옛 mock 35초 cap 잔재. 이번 fix 누락된 빌드.

### 1-8. 중간 에러 발생 시 처리

- [ ] **무엇**: 의도적으로 깨진 데이터(미정의 코드값, NOT NULL 위반 등)를 포함한 시나리오로 돌려봄.
- **OK**:
  - Audit stage 에서 위반 검출 → `quarantine_entries` 에 그룹별 1행 INSERT (위반 종류별, 첫 5건 sample 포함).
  - 그 테이블 결과 = `failed` → Load 스테이지가 해당 테이블 **스킵** (다른 정상 테이블은 적재 진행).
  - run 전체 상태 = `failed` (일부 테이블 실패 + non-cutover 면 다른 테이블 진행).
  - 화면에 실패 배지 + 실패 사유 배너 표시 (`stage N (name) failed — reason`).
  - 만약 stage 식별 불가하면 일반 메시지 "실행 실패 — {reason}" (이번 수정 `errorBannerNoStage`).
- **NG**:
  - 위반 row 가 있는데 `quarantine_entries` 가 비어있음 → AuditStage 미작동.
  - 정상 테이블도 같이 적재 안 됨 → `LoadStage.upstreamFailed` 로직 의심.

### 1-9. Pause / Resume

- [ ] **무엇**: stage 진행 중 Pause 버튼 클릭 → 잠시 후 Resume.
- **OK**:
  - Pause 누름 → 현재 stage 끝나는 boundary 에서 정지 (in-process, stage 단위라 짧은 지연 있을 수 있음).
  - run 상태 = `paused`, `projects.run_status='paused'`, chip 색 변경.
  - Resume 누름 → 다음 stage 진행, 상태 `running` 복귀.
- **NG**:
  - Pause 직후 run 이 끝나면 `paused→success` 가 동기로 바뀌어 화면 헷갈릴 수 있음 (BE 가 2초 polling 캐시 사용) — 알려진 한계.
  - elapsed 라벨이 pause 중에도 wall-clock 으로 흐름 — 의도된 PoC 동작.

### 1-10. Abort

- [ ] **무엇**: 진행 중 Stop(중단) 버튼.
- **OK**:
  - run 상태 = `aborted`, finished_at + error_message 기록.
  - **다음 stage 경계에서** 중단 (지금 stage 는 끝까지 돔 — 알려진 한계).
  - lock 해제 → 새 run 시작 가능.
- **NG**:
  - Abort 후에도 `projects.run_status='running'` 으로 남음 → 동시성 문제. 콘솔/BE 로그 확인.

### 1-11. Retry

- [ ] **무엇**: 실패한 run 의 Retry 버튼.
- **OK**:
  - 기존 run 폐기 + 같은 테이블 선택으로 새 run 시작 (이번 수정 — `startRealRun` 헬퍼 분리).
  - 새 run history 행, 새 stage_instances 7행.
- **NG**:
  - Retry 가 무동작이면 → 이번 fix 안 들어간 빌드 (`handleRetry` 의 stale closure 버그).

### 1-12. Discard

- [ ] **무엇**: 종료된 run 의 Discard.
- **OK**: 화면에서 active run 카드 사라짐. `run_history` row 는 그대로 보존 (실행 이력).

### 1-13. 종료 후 검증 (가장 중요)

- [ ] **무엇**: TO-BE PostgreSQL 에 직접 접속해 적재 결과 확인.
- **OK**:
  - 각 TO-BE 테이블에 row 수 = AS-IS row 수 - quarantine 수.
  - **컬럼 값이 매핑 정의대로** 들어감 (예: `GENDER 1 → 'M'`, `STATUS_CD 'A' → 'ACTIVE'`).
  - **컬럼 어긋남 없음** (이번 수정 — COPY 명시 컬럼 리스트). 즉 `customer_id` 자리에 `customer_id` 값, `email` 자리에 `email` 값.
  - 날짜/숫자 변환 정상 (CHAR(8) YYYYMMDD → DATE, NUMBER → NUMERIC 등).
- **NG**: 다른 컬럼에 값이 들어가 있거나, 일부 컬럼이 빈값 → COPY column-list fix 누락 또는 mapping_rules 오류.

### 1-14. 운영 후 정리

- [ ] **무엇**: 같은 run 다시 돌리기 (재실행 안전성).
- **OK**: Load 가 `TRUNCATE + COPY` 라 멱등. 두 번째 실행해도 row 수 동일.

---

## 2. 테스트 데이터 커버리지 분석 + 보강 제안

대상: `C:\KSINFO\TestData\samples`.

### 2-1. 정합성 표 (매핑 9개 asis_table vs CSV 파일)

| asis_table | 기대 CSV | 실제 | 상태 |
|---|---|---|---|
| `BANKSYS.CUSTOMERS` | `customers.csv` | ✅ | OK (bare lower) |
| `BANKSYS.ACCOUNTS` | `accounts.csv` | ✅ | OK |
| `BANKSYS.TRANSACTIONS` | `transactions.csv` | ✅ | OK |
| `HR.M_EMPLOYEE` | `HR.M_EMPLOYEE.csv` | ✅ + `m_employee.csv` 중복 | ⚠️ 두 파일 컬럼 셋 다름 — 정본 명확화 필요 |
| `HR_PAYROLL.EMPLOYEES` | `HR_PAYROLL.EMPLOYEES.csv` | ✅ | OK (schema 한정) |
| `RECRUIT.APPLICANTS` | `RECRUIT.APPLICANTS.csv` | ✅ | OK (schema 한정) |
| `SHOP.SHOP_CUSTOMERS` | `shop_customers.csv` | ✅ | OK |
| `SHOP.SHOP_ORDERS` | `shop_orders.csv` | ✅ | OK |
| `SHOP.SHOP_ORDER_ITEMS` | `shop_order_items.csv` | ✅ | OK |

추가로 CSV·DDL 만 있고 **매핑 행이 없는** 테이블:
- `SHOP.SHOP_ORDERS_ARCH` (`shop_orders_arch.csv` 존재) — UNION 두번째 source 정의 누락.
- `HR.M_DEPARTMENT` (`HR.M_DEPARTMENT.csv` 존재) — 자기참조 LOOKUP 시연 불가.
- `CRM.T_CONTACT_LOG` (`CRM.T_CONTACT_LOG.csv` 존재) — Split 1→2 + WHERE + LOOKUP 케이스 미정의.

### 2-2. 19 케이스 커버리지

| # | 케이스 | 상태 | 비고 |
|---|---|---|---|
| 1 | AS-IS 테이블 ↔ CSV 매핑 | ⚠️ 9건 OK, 3건 매핑 누락 | DEPARTMENT/CONTACT_LOG/ORDERS_ARCH |
| 2 | Passthrough | ✅ | 광범위 |
| 3 | 타입 변환 (CHAR→DATE/TIMESTAMP/NUMERIC/BOOLEAN) | ✅ | 풀스택 커버 |
| 4 | 길이 확장 | ✅ | VARCHAR2(60)→VARCHAR(120) 등 |
| 4b | 길이 **축소(truncation)** | ❌ | 의도적 100자 초과 row 없음 |
| 5 | 코드 도메인 값 매핑 | ✅ | 10개 도메인, 30 entry |
| 5b | 코드맵 **미정의 값** (fallback) | ❌ | GENDER='X' 같은 row 0건 |
| 6 | NULL / 빈 문자열 | ⚠️ | nullable NULL 은 OK, **NOT NULL 위반 row 0건** |
| 7 | DEFAULT 값 신규 컬럼 | ✅ | tenant_id, is_deleted, version |
| 8 | Skip 컬럼 (deprecated) | ⚠️ | 명시적 skip 컨벤션 없음 (매핑 행 없으면 skip) |
| 9 | Split 1→N | ❌ | CONTACT_LOG split 매핑 행 0건 |
| 9b | Merge N→1 (JOIN) | ✅ | SHOP_ORDERS × SHOP_CUSTOMERS |
| 10 | UNION | ❌ | SHOP_ORDERS_ARCH 매핑 행 0건 |
| 11 | JOIN (FK lookup) | ✅ | SHOP scenario |
| 12 | PK 변환 (NUMBER→UUID 등) | ✅ | EMP_ID→employee_id UUID |
| 13 | 날짜 포맷 변형 | ✅ | YYYYMMDD, YYYY-MM-DD, YYYY/MM/DD, ISO, 윤년 |
| 14 | 숫자 precision/scale | ⚠️ | overflow 의도 불명 (SALARY NUMERIC(11,2)에 135M.00 row 존재) |
| 14b | 범위 위반 (CHECK) | ❌ | credit_score 0~999 위반 row 0건 |
| 15 | 인코딩 edge (SJIS/EBCDIC) | ⚠️ | 시뮬레이션만, 실제 SJIS 인코딩 파일 없음 |
| 16 | LOB/CLOB/BLOB | ⚠️ | CLOB(REMARKS) ✅, BLOB 은 placeholder 만 |
| 17 | WHERE 필터 | ⚠️ | notes 텍스트로만 — 정형 컬럼 부재 |
| **18** | **Audit 실패 의도** | ❌ | **결정적 누락. NOT NULL/타입/길이/PK중복/FK깨짐 row 0건** |
| **19** | **Verify mismatch** | ❌ | 위 18 과 같은 이유로 검증 불가 |

### 2-3. 결정적 결론

> **정상 path 다양성은 우수, 실패 path 자료가 전혀 없음.**
> 따라서 도구의 **Quarantine·Verify report** 가 잘 동작하는지 PoC 시연에서 보여줄 수 없는 상태.

### 2-4. 보강 제안 (체크리스트 1-8 을 실제로 보려면 아래 row 들 추가 필요)

**A. 매핑 행 추가 (`mapping/column_mapping.csv`)**
1. `HR.M_DEPARTMENT → public.departments` 6 행 (자기참조 LOOKUP 검증).
2. `CRM.T_CONTACT_LOG → public.contact_log + public.contact_attachment` 8 행 (Split + WHERE + BLOB).
3. `SHOP.SHOP_ORDERS_ARCH` UNION 두번째 source 6 행.

**B. 의도적 위반 CSV row 보강 (Audit/Verify 시연용)**
1. **코드맵 미정의값**: `customers.csv` 에 `GENDER='X'` row 1건.
2. **NOT NULL 위반**: `customers.csv` 에 `BIRTH_DT=` 공란 row 1건.
3. **길이 초과**: `CUST_NAME_KANJI` 101자 row 1건.
4. **숫자 범위 위반**: `CREDIT_SCORE=1500` row 1건 (CHECK 0~999).
5. **PK 중복**: `accounts.csv` 에 `ACCT_NO=A001-1001-01` 두번째 row.
6. **FK 깨짐**: `transactions.csv` 에 `ACCT_NO=A999-9999-99` row 1건.
7. **날짜 invalid**: `RECRUIT.APPLICANTS.csv` 에 `BIRTH_MONTH=13` row 1건.
8. **DEFAULT 검증**: `customers.csv` 에 `DEL_FLG=` 공란 row 1건.

**C. 자료 일관성 정리**
9. `ori_tobe_postgres.sql` 와 `codemaster_postgres.sql` 의 `public.employees` 중복 정의 충돌 해소.
10. `HR.M_EMPLOYEE.csv` 와 `m_employee.csv` 중 정본 명확화.
11. README 의 파일명 오타(`asis_oracle.sql` → 실제 `ori_asis_oracle.sql`) 정정.

**D. 정형 매핑 컬럼 도입 (`column_mapping.csv` 헤더)**
12. `where_clause` / `transform_sql` / `lookup_table` / `union_group` / `split_ordinal` — 현재는 notes 텍스트에 SQL 이 들어있음.

→ 위 12개 정도만 보강하면 19 케이스 전부 ✅ 로 끌어올릴 수 있음.

---

## 3. Execution 이벤트가 건드리는 DB 테이블 전수

### 3-1. 한 줄 요약

> 「Start run」 한 번 = 메타 DB **6 테이블 write** + **5~6 테이블 read** + 화면 polling 매 2초 **4 테이블 SELECT** + TO-BE 외부 PG **TRUNCATE/COPY/SELECT** + DuckDB 휘발성 schema 1개.

### 3-2. 메타 DB 테이블별 정리

| 테이블 | 목적 | READ | WRITE | 생성/삭제 | Migration |
|---|---|---|---|---|---|
| **`run_history`** | 실행 이력 1건=1row | 화면 polling, history 탭, 새 run 시작 시 lock 체크, sweeper | INSERT(startRun) / UPDATE(pause·resume·abort·complete·fail·timeout) | row=run 시작 시 1건. 삭제는 project CASCADE만. **영구 보존** | `V20260522210002` |
| **`projects`** | Project 마스터 | startRun(SELECT FOR UPDATE 락), polling | UPDATE(run_status: idle↔running↔paused) | row 자체는 변경/삭제 안 함. column 만 토글 | `V4`, `V5` |
| **`sites`** | TO-BE DB 접속·csv_path·encoding | startRun (env 가드), 매 stage | (Execution 관점) 없음 | read-only | `V4`, `V20260521182054` |
| **`snapshots`** | 매핑 승인본 | rehearsal/cutover startRun 에서 latest approved 검색 | (Execution 관점) 없음 | read-only | `V6`, `V8`, `V20260526101856`, `V20260526120910`, `V20260526161635` |
| **`mapping_table_bindings`** + sources | TO-BE↔AS-IS 바인딩 | startRun(count), 매 stage(binding 정의) | 없음 | read-only | `V20260523210002` |
| **`mapping_rules`** + `mapping_code_maps` | 컬럼별 변환 룰 | TransformStage 만 | 없음 | read-only | `V20260523174402` 외 |
| **`ddl_imports`** + `ddl_tables` + `ddl_columns` | DDL 스키마 메타 | CheckStage(임포트 검증), AuditStage(타입/NOT NULL/PK), VerifyStage(PK 추출) | 없음 | read-only | `V7` |
| **`stage_instances`** | stage 단위 진행 1 row | polling(`GET /stages`), 각 stage | INSERT(startRun 7행 한 번에 pending), UPDATE(start/finish/tables_*) | run 당 7(or 6)행, run_history CASCADE | `V20260526100000` |
| **`stage_table_results`** | (stage × binding) 단위 1 row | polling 의 batch SELECT, LoadStage 의 upstream-fail 검사 | INSERT(lazy), UPDATE(status·row_count·error_detail) | run 당 ~(stages × bindings)행 | `V20260526100000` |
| **`quarantine_entries`** | 격리 (validation 위반) 기록 | overview count, LogViewer | INSERT(AuditStage 위반 검출 시, VerifyStage mismatch 시) | 정상 run = 0건. 위반 있으면 위반 종류별 1행. CASCADE 만 삭제. **영구 보존** | `V20260526150000` |
| **`run_log_meta`** | 로그 메타 카운터 | LogViewer 카운터 표시 | UPSERT(openRun), UPDATE(bumpCounters, ended_at) | run 당 1행 | `V20260521150000` |
| **`run_log`** (LIST partition) | WARN+ERROR 전수, INFO 1% 샘플 | LogViewer keyset paging | DDL(파티션 생성, idempotent) + INSERT(batch) | run 당 1 파티션 테이블 생성 — **drop 정책 미구현 (PoC TODO)** | `V20260521150000` |

### 3-3. TO-BE 외부 PostgreSQL (Site 의 tobeDbByEnv[environment] 접속)

| Stage | 대상 | 작업 |
|---|---|---|
| **Check** | (TO-BE 전체) | `DriverManager.getConnection` ping (5초 timeout) |
| **Load** | `{tobeSchema}.{tobeTable}` | (1) FK 일시 비활성 시도 → (2) `TRUNCATE TABLE` → (3) `COPY {table} (col1,col2,...) FROM stdin (FORMAT csv)` (**이번 수정 — 명시 컬럼 리스트**) → (4) FK 복귀 |
| **Verify** | `{tobeSchema}.{tobeTable}` | `SELECT COUNT(*)` + PK 정렬 streaming `SELECT pk_cols FROM ... ORDER BY pk_cols` 양쪽 lockstep 비교 |

> **재실행 안전성**: Load = TRUNCATE + COPY → 멱등. 같은 run 두 번 돌려도 결과 동일.

### 3-4. DuckDB (in-memory, **메타 DB 아님 — 휘발성 작업영역**)

| 객체 | 작업 | 생성 | 정리 |
|---|---|---|---|
| schema `run_{runId}` | `CREATE SCHEMA` | Extract 시작 시 | 다음 run 시작 시 `sweepRunSchemas` 가 pending/running 외 모두 DROP |
| 테이블 `asis_{table}` | `CREATE OR REPLACE TABLE AS SELECT * FROM read_csv_auto(...)` | Extract | 위와 동일 |
| 테이블 `tobe_{table}` | `CREATE OR REPLACE TABLE AS <transform SQL>` | Transform | 위와 동일 |
| parquet 파일 `parquet1/`, `parquet2/`, 임시 `temp/*.csv` | `COPY ... TO ...` | Extract/Transform/Load | parquet2 는 stage-cache 용 보존, temp CSV 는 Load 후 즉시 삭제 |

> DuckDB 안 데이터는 메타 DB 어디에도 영속화되지 **않는다**. row_count 같은 메타 카운터만 `stage_table_results` 에 남음.

### 3-5. 이벤트별 매트릭스

| 이벤트 | 메타 DB WRITE | 메타 DB READ | 외부 |
|---|---|---|---|
| Pre-flight | 없음 (FE zustand only) | (BE 추가 호출 없음 — preflight 는 cached snapshot + tobeDb test-connection + csv-preview) | TO-BE DB ping + csv-preview API |
| 테이블 선택(persist) | 없음 (`localStorage`) | 없음 | 없음 |
| **Start run** | `run_history` INSERT, `projects` UPDATE(running), `stage_instances` 7행 INSERT, `run_log_meta` UPSERT, `run_log_p_<runId>` 파티션 CREATE | `projects` SELECT FOR UPDATE, `sites`, `snapshots`, bindings COUNT | DuckDB schema sweep |
| Check stage | `stage_instances` UPDATE, `stage_table_results` upsert, `run_log` INSERT | `ddl_imports` (asis/tobe) | TO-BE PG ping |
| Extract | 동일 | (ctx 통해서) | DuckDB CREATE/CSV→table, parquet1 dump |
| Reconcile | 동일 | 없음 | DuckDB COUNT |
| Transform | 동일 | `mapping_code_maps`, `mapping_rules` | DuckDB CREATE tobe_*, parquet2 dump |
| **Audit** | 동일 + **`quarantine_entries` INSERT** (위반당 1행) | `ddl_tables`, `ddl_columns` (TO-BE) | DuckDB SELECT |
| **Load** | 동일 | (upstream 결과는 `stage_table_results` 재조회) | DuckDB COPY→CSV, **TO-BE PG TRUNCATE + COPY** |
| **Verify** | 동일 + `quarantine_entries` INSERT(mismatch 시) | `ddl_columns` (PK 추출) | DuckDB+PG SELECT COUNT/ORDER |
| 완료 callback | `run_history` UPDATE(success), `projects`(idle), `run_log_meta`(ended_at) | 자기 행 재조회 | 없음 |
| 실패 | `run_history` UPDATE(failed, error_message), `projects`(idle), `run_log_meta`(ended_at) | 동일 | 동일 |
| Pause | `run_history` UPDATE(paused), `projects`(paused) | findById | (in-process: stage 경계에서 await) |
| Resume | `run_history` UPDATE(running), `projects`(running) | 동일 | thread 깨움 |
| Abort | `run_history` UPDATE(aborted), `projects`(idle), `run_log_meta`(ended_at) | 동일 | RunControlRegistry.cancel |
| Retry | (별도 endpoint 없음 — 그냥 새 Start run 1회) | — | — |
| Discard | (FE store activeRun 만 비움 — BE 무관) | — | — |
| **2초 polling** | 없음 | `run_history`, `stage_instances`, `stage_table_results`, `projects` | 없음 |
| Timeout sweep (60s) | 임계 초과 시 `run_history`(timed_out), `projects`(idle), `run_log_meta`(ended_at) | `findByStatusAndStartedAtBefore(running, NOW-180m)` | RunControlRegistry.cancel |

### 3-6. 한 문단 비기술 요약 (팀원·외부 설명용)

> 「Start run」을 누르면 시스템은 **projects** 표에서 그 project 줄을 잠그고 「running」으로 바꾼 다음, **run_history** 에 새 실행 1건을 적고 **stage_instances** 에 7 단계 빈 칸을 미리 만든다. 별도 thread 가 7 단계를 차례로 돌면서 단계마다 **stage_table_results** 의 (단계×테이블) 칸을 채우고, 각 단계의 로그는 **run_log_meta** 의 카운터를 늘리고 **run_log** 의 그 run 전용 파티션에 들어간다. 데이터가 의심스러우면 Audit·Verify 가 **quarantine_entries** 에 위반 그룹을 추가한다. 실제 고객 PostgreSQL 에는 Load 단계에서 **TRUNCATE 후 COPY** 로 일괄 적재, Verify 단계에서 **SELECT** 로 비교만 한다. AS-IS CSV·변환된 데이터는 DuckDB 안 휘발성 schema 에 잠시 머물다 다음 run 이 들어오면 자동 청소된다. Pause/Resume 은 상태 문자열만 토글, Abort 는 종료 시각을 박아 마무리. 화면 polling 은 매 2초 **run_history + stage_instances + stage_table_results** 세 곳만 SELECT 한다.

---

## 4. 디렉터리 구조 + Coordinator/Worker 하이브리드 모델

### 4-1. 디렉터리 트리 (요약)

```
ModernizeProDataBridge/
├── backend/                    # Spring Boot 3 + Java 21
│   ├── pom.xml + mvnw
│   └── src/main/
│       ├── java/com/ksinfo/modernize_pro_data/
│       │   ├── common/         # config, dto, exception, util, duckdb
│       │   ├── coordinator/    # 본사 관리 노드 패키지
│       │   │   ├── api/        # REST controllers
│       │   │   ├── auth/       # JWT auth
│       │   │   ├── site/       # Site/Project 엔티티·서비스
│       │   │   ├── ddl/        # DDL import (asis/tobe)
│       │   │   ├── mapping/    # MappingRule·CodeMap·TableBinding
│       │   │   ├── snapshot/   # 매핑 승인본
│       │   │   ├── run/        # RunService·RunControlRegistry·RunTimeoutSweeper·RunHistory·ExecutionOverview
│       │   │   ├── worker/     # ★ pipeline executor
│       │   │   │   ├── LocalWorkerExecutor.java   # 7-stage 순차 실행 + 하이브리드 게이트
│       │   │   │   ├── RunExecutionListener.java  # AFTER_COMMIT 으로 executor 호출
│       │   │   │   ├── SqlComposer.java           # transform SQL 생성 (single/join/union)
│       │   │   │   ├── StageContext.java + StageHelpers.java + RunOutputPathResolver.java
│       │   │   │   └── stages/
│       │   │   │       ├── CheckStage.java         # 1. DDL 검증 + CSV 존재 + TO-BE DB ping
│       │   │   │       ├── ExtractStage.java       # 2. CSV → DuckDB asis_* + parquet1
│       │   │   │       ├── ReconcileStage.java     # 3. row count sanity
│       │   │   │       ├── TransformStage.java     # 4. mapping → DuckDB tobe_* + parquet2
│       │   │   │       ├── AuditStage.java         # 5. NOT NULL/타입/길이/범위/PK 검증 + Quarantine
│       │   │   │       ├── LoadStage.java          # 6. tobe_ → CSV → PG TRUNCATE + COPY
│       │   │   │       └── VerifyStage.java        # 7. row count + PK 정렬 비교
│       │   │   ├── runlog/     # RunLogIngestService + partition table 관리
│       │   │   ├── quarantine/ # QuarantineService + Entry
│       │   │   ├── load/       # PgCopyManager (TO-BE PG COPY)
│       │   │   └── ...
│       │   └── launcher/       # jpackage 진입점
│       └── resources/
│           ├── application.yml + application-local.yml(gitignore)
│           └── db/migration/   # V*.sql — Flyway 마이그레이션
└── frontend/                   # React 18 + Vite + TypeScript
    └── src/
        ├── api/                # fetch wrapper + endpoint 모듈 (runs, tobeDb, csvPreview, ...)
        ├── components/         # 재사용 컴포넌트 (Modal, Checkbox, PreflightResultPanel, ...)
        ├── hooks/              # usePipelineProgress 등
        ├── i18n/               # ko/ja/en
        ├── layout/             # AppShell (사이드바·탑바·탭바)
        ├── lib/                # 공유 유틸 (pipelineStages, preflightValidation, useDemoMode*, ...)
        ├── pages/              # ExecutionPage, MappingPage, DashboardPage, ...
        ├── routes/             # ProtectedRoute
        └── store/              # zustand stores (workspace, snapshots, executionPreflight, ...)

* useDemoMode/demoFixtures 는 이번 mock 제거 라운드에서 삭제 예정 (5장 참조)
```

### 4-2. Coordinator / Worker 하이브리드 모델

```
┌─────────────────────────────────────┐
│  본사 (HQ) ─ Coordinator (Spring Boot)│
│  - Project/Site/Mapping/DDL/Snapshot  │
│  - PostgreSQL 메타 DB                 │
│  - REST + WebSocket endpoint          │
│  - 사용자 화면 (FE: React)            │
└──────────────┬──────────────────────┘
               │ REST + WS (https/wss)
               │ ※ 폐쇄망 사이트는 USB 로만
               ▼
┌─────────────────────────────────────┐
│ 현장 (Site) ─ Worker (격리망 설치)    │
│ - PoC 1차: in-process executor       │
│   (Coordinator 안에서 LocalWorker    │
│   직접 실행 — 7 stage 순차)          │
│ - PoC 2차: 별도 Worker JVM 분리 예정 │
└─────────────────────────────────────┘
```

**PoC 1차 현실 (지금)**:
- Worker 노드는 **별도 프로세스 분리되어 있지 않음**.
- `LocalWorkerExecutor` 가 Coordinator 의 같은 JVM 에서 `@Async` 로 동작.
- DuckDB 도 Coordinator JVM in-memory.
- TO-BE PostgreSQL 만 외부.

**PoC 2차 예정**:
- 격리망 사이트에 Worker JVM 설치.
- 사이트 ↔ 본사 통신: REST/WS for sync, USB for data movement.
- 메타 DB 직접 접속 금지 (Worker 는 Coordinator REST 만 본다).

### 4-3. 데이터 흐름 (한 run 안에서)

```
사용자 클릭 (FE)
   │ POST /api/v1/runs/start { projectId, runType, tables[] }
   ▼
RunService.startRun (Coordinator)
   │ - projects 락, run_history INSERT, stage_instances pre-create
   │ - @TransactionalEventListener AFTER_COMMIT
   ▼
RunExecutionListener.@Async (별도 thread)
   │ - LocalWorkerExecutor.execute(ctx)
   ▼
LocalWorkerExecutor (7 stage 순차)
   1. CheckStage      ─ DDL 존재 + CSV 존재 + TO-BE DB ping
   2. ExtractStage    ─ AS-IS CSV → DuckDB schema."asis_{table}"
   3. ReconcileStage  ─ AS-IS row count sanity check
   4. TransformStage  ─ mapping_rules + code_maps → DuckDB schema."tobe_{table}"
   5. AuditStage      ─ NOT NULL/타입/길이/범위/PK + Quarantine 기록
   6. LoadStage       ─ DuckDB tobe_ → temp CSV → TO-BE PG TRUNCATE + COPY
   7. VerifyStage     ─ AS-IS row count vs PG + PK 정렬 비교
   │ (하이브리드 게이트: 위 stage 가 throw → 이후 stage skip 으로 두고 run = failed)
   ▼
RunService.completeRun / failRun / abortRun (Coordinator)
   │ - run_history UPDATE, projects UPDATE, run_log_meta close
   ▼
화면 polling 이 다음 tick(2s) 에 변경 감지 → UI 갱신
```

---

## 5. 그 외 팀원에게 설명해야 할 포인트

### 5-1. **3개의 environment 필드** (이 프로젝트에서 가장 헷갈리는 부분)

| 필드 | 타입 | 값 | 용도 |
|---|---|---|---|
| `Site.asisEnv` | `SiteEnv` (`mainframe / midrange / cloud / on-prem / other`) | AS-IS 시스템 **인프라 종류** (라벨) | 표시·문서 |
| `Site.tobeEnv` | `SiteEnv` (위와 동일 vocabulary) | TO-BE 인프라 **종류** (라벨) | 표시·문서 |
| `Site.environment` | `ProjectEnvironment` (`dev / test / staging / production`) | **현재 활성 운영 단계** | **TO-BE DB 접속·cutover 게이트의 진짜 키** |

**핵심**: `tobeDbByEnv` 맵은 `environment` 키로 저장된다. `tobeEnv` 와 **별개**.
**이번 작업에서 수정**: 스테이지가 `tobeEnv`(인프라 종류)로 조회하던 버그 → `environment` 로 정렬.

### 5-2. **schema-qualified CSV 파일명**

문서화된 규칙은 `{schema}.{table}.csv` (예: `HR_PAYROLL.EMPLOYEES.csv`). bare 도 fallback 으로 처리.
**이번 작업에서 수정**: stage·preview resolver 가 `{schema}.{table}.csv` → `{table}.csv` 순으로 찾도록.

### 5-3. **COPY 명시 컬럼 리스트** (silent 컬럼 어긋남 방지)

전엔 `COPY {table} FROM stdin` (positional) — CSV 필드가 PG DDL ordinal 에 위치로 매핑 → rule 순서가 DDL 순서와 다르면 silent corruption.
**이번 수정**: `COPY {table} ("col1","col2",...) FROM stdin` — CSV 필드를 **이름**으로 매핑 → DDL ordinal 무관하게 정확.

### 5-4. **하이브리드 stage 게이트**

비-cutover (test/rehearsal): stage 가 throw → 이후 stage skip + run failed. stage 가 일부 실패 (failedCount>0) 만 → 다음 stage 진행 (continue-on-error).
cutover: stage 가 일부라도 실패 → 게이트 발동 (이후 stage skip + run failed) — 본운영 보호.

### 5-5. **Quarantine 분리 수준** (현재 한계)

- ✅ 메타 DB `quarantine_entries` 에 그룹 요약 + 첫 5 sample 기록.
- ❌ **위반 row 전체 raw data parquet 저장은 마이그레이션 주석에 명시돼 있지만 구현 안 됨.**
- ❌ **row-level 분리(좋은 row 적재 + 나쁜 row 격리)는 안 됨.** 위반 1건이라도 → 그 테이블 전체 Load 스킵 (all-or-nothing per table).
- → 이건 P0 잔여 작업 (6장 참조).

### 5-6. **DuckDB in-memory** (run 단위 sandbox)

DuckDB schema 는 `run_{runId}` 로 매 run 마다 새로 만들어지고, 다음 run 시작 시 자동 청소. 즉 **run 끼리 데이터 충돌 없음**.

### 5-7. **운영 후 정리 (재실행 안전성)**

- TO-BE PG: Load 가 `TRUNCATE + COPY` 라 멱등.
- 메타 DB: `DELETE FROM run_history WHERE project_id=?` 하면 CASCADE 로 `stage_instances`, `stage_table_results`, `quarantine_entries`, `run_log`, `run_log_meta` 다 같이 삭제. `projects.run_status` 는 별도 idle 로 UPDATE 필요.
- **단**: `run_log_p_<runId>` 파티션 테이블은 자동 drop 안 됨 — 수동 `DROP TABLE` 필요 (P0 잔여).

### 5-8. **알려진 i18n 정책**

- `menu.*` / `tab.*` / `*.title` / `*.status.*` → 3개 언어(ko/ja/en) 모두 영문 동일.
- `*.subtitle` / `*.desc` / `*.hint` / 에러 / 플레이스홀더 → 언어별 번역.
- 본 작업에서 추가/삭제된 키도 동일 규칙 적용.

---

## 6. 알려진 한계 (이번 리뷰 뒤 이어 작업)

PoC1 = 현장 배포 수준이라는 기준이라, 다음 항목들이 잔여로 남았다. 우선순위 순:

### P0 — silent data corruption (현장 가면 안 됨)

| # | 항목 | 비고 |
|---|---|---|
| 1 | ✅ Positional COPY 컬럼 어긋남 | **이번 작업 완료** (명시 컬럼 리스트) |
| 2 | 🔴 `SqlComposer` **union** `SELECT *` 위치 매핑 | UNION CSV 컬럼 순서/이름 다르면 wrong. shop 시나리오 영향 |
| 3 | 🔴 `SqlComposer` **join** `aliasFor` primary fallback | rule.asisTable 불일치 시 silent wrong-table |
| 4 | 🔴 COPY NULL/empty + bool/date 타입 계약 | 빈 문자열↔NULL 모호, `'Y'/'1'`→bool 실패, 날짜 포맷 |
| 5 | 🔴 **Row-level quarantine 분리** | 정상 row 적재 + 위반 row 격리 + parquet 전체 보존 |
| 6 | 🔴 `AuditStage` 가 cutover catalog 에서 빠짐 | cutover 가 NOT NULL/타입/PK 검증 없이 적재 |

### P1 — run 생명주기 (운영 안정성)

| # | 항목 |
|---|---|
| 7 | abort/timeout/gate 시 `StageInstance.status` 잔존 → FE 배지 불일치 |
| 8 | abort 가 lock 먼저 풀고 executor 는 계속 → 같은 TO-BE 테이블 동시 TRUNCATE/COPY 위험 |
| 9 | Paused run 을 timeout sweeper 가 안 잡음 → 영구 lock |
| 10 | Pre-register pause/abort race → 신호 사일런트 누락 |

### P2 — FE 잔여

| 항목 |
|---|
| ✅ Retry · elapsed · tables=0 · 실패 배너 (이번 완료) |
| 🔴 Preflight pin-switch 중 cache 어긋남 |
| 🔴 Pause/Stop stale-status race → spurious "failed" alert |
| 🟡 alert → toast |
| 🟡 401 mid-poll → silent logout (토큰 만료 핸들링) |

### P3 — 인프라

| 항목 |
|---|
| 🟡 `run_log` 파티션 retention (drop 정책) |
| 🟡 `quarantine_entries` 보관 정책 |
| 🟡 `run_history` 보관 정책 |

---

## 부록 A. 주요 파일 절대경로

### Backend (Spring Boot)
- `backend/src/main/java/.../coordinator/run/RunService.java` — start/abort/pause/resume/finish 핵심
- `backend/src/main/java/.../coordinator/worker/LocalWorkerExecutor.java` — 7-stage 순차 실행 + 하이브리드 게이트
- `backend/src/main/java/.../coordinator/worker/stages/` — 7 stage 구현
- `backend/src/main/java/.../coordinator/worker/SqlComposer.java` — transform SQL 생성
- `backend/src/main/java/.../coordinator/load/PgCopyManager.java` — TO-BE PG COPY
- `backend/src/main/java/.../coordinator/runlog/RunLogIngestService.java` — 로그 ingest
- `backend/src/main/java/.../coordinator/quarantine/QuarantineService.java` — 위반 격리
- `backend/src/main/resources/db/migration/` — Flyway

### Frontend (React)
- `frontend/src/pages/ExecutionPage.tsx` — 메인
- `frontend/src/hooks/usePipelineProgress.ts` — 2초 polling
- `frontend/src/lib/pipelineStages.ts` — stage 모델
- `frontend/src/lib/preflightValidation.ts` — 7개 preflight check
- `frontend/src/store/executionPreflight.ts` — preflight 캐시
- `frontend/src/api/runs.ts` — start/abort/pause/resume/stages/list

### Test Data
- `C:\KSINFO\TestData\samples\README.md` — 시나리오 정의
- `C:\KSINFO\TestData\samples\mapping\column_mapping.csv` — 매핑 정의
- `C:\KSINFO\TestData\samples\mapping\code_mapping.csv` — 코드 도메인
- `C:\KSINFO\TestData\samples\csv\` — AS-IS 데이터 13 파일
- `C:\KSINFO\TestData\samples\ddl\` — AS-IS Oracle + TO-BE PostgreSQL DDL

---

## 부록 B. 리뷰 진행 흐름 권장

1. 본 가이드의 **1장 체크리스트**를 화면 옆에 띄우고 따라가며 시연.
2. 1-13(종료 후 검증) 단계에서 TO-BE PG 에 직접 `psql` 또는 DBeaver 접속해 컬럼 정합·값 변환 확인.
3. **2장 보강 제안** 항목 12개 중 어느 것을 추가할지 합의 (특히 18·19 케이스 — Quarantine·Verify 시연용).
4. 3장 DB 테이블 표는 "데이터가 어디에 쌓이는지" 질문에 즉답용.
5. 4장 디렉터리·하이브리드 모델은 신규 합류 인원 온보딩용으로도 활용.
6. 6장 잔여 항목은 PoC1 마감 전까지의 작업 리스트.

---

*Document version: 1.0 — 2026-05-28*
