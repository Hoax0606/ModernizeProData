# Modernize Pro Data — Team Onboarding (Pipeline & Rule Engine)

데이터 이행 파이프라인 및 룰 엔진 설계의 누적 결정 사항을 정리한 팀 공유본. 새 팀원이 진입할 때 또는 새 AI 세션을 시작할 때 `CLAUDE.md` 와 함께 읽어두면 설계 의도와 함정을 빠르게 따라잡을 수 있다.

**전제** — 프로젝트 한 줄 소개·기술 스택·디렉터리 맵·도메인 용어는 repo 루트 `CLAUDE.md` 참조. 본 문서는 거기 안 적힌 (또는 한 줄로만 적힌) 설계 디테일을 다룬다.

업데이트: 2026-05-19

---

## 1. Phase / Stage 모델 (확정 2026-05-15)

### 1.1 9단계 Phase
```
planning → analysis → test → sign-off → rehearsal → ready → cutover → hypercare → done
```

### 1.2 4단계 Stage (환경 라벨)
```
dev → test → staging → production
```
- dev 가 첫번째 (순서 고정).
- **cutover Phase 는 Stage=production 에서만 실행 가능**. 코드에 prod 가드 필수.

### 1.3 Snapshot 두 종류 + 승인 흐름
| Snapshot | 승인 시 전환되는 Phase |
|---|---|
| mapping snapshot | → sign-off |
| cutover snapshot | → ready |

- **Phase 전환은 approve 시점만** 일어남. request 시점에는 Phase 안 바뀜.

### 1.4 runStatus sub-status (test / rehearsal / cutover 한정)
| 값 | 의미 | UI |
|---|---|---|
| `idle` | 시작 전 | 기본 |
| `running` | 진행 중 | 진행 표시 |
| `completed` | 완료 | **뱃지 회색** (UI 약속) |

---

## 2. 파이프라인 4단계 (확정 2026-05-18)

```
Source Reader SPI → DuckDB Appender → Rule Engine (SQL + UDF) → Loader Adapter SPI
                       ↓ writes              ↓ writes
                     CP1 Raw Parquet        CP2 Transformed Parquet
                     (체크포인트 ①)         (체크포인트 ② — rehearsal 만)
```

각 단계는 SPI 로 추상화돼 입력 형식·TO-BE DB 종류에 따라 어댑터가 교체된다. **단일 writer 정책** — DuckDB 인스턴스는 워커별 독립.

### 2.1 두 체크포인트
- **CP1** = 소스 파일 1개당 별도 Parquet (`cp1_emp.parquet`, `cp1_dept.parquet` ...). 모든 컬럼 VARCHAR. **JOIN/타입변환 절대 금지** — 원본 보존.
- **CP2** = JOIN/UNION + 변환룰 적용 후 Parquet. rehearsal 만 생성. cutover 는 생략 (속도 우선).

### 2.2 4 케이스
| 케이스 | 입력 | Phase | CP2 | 비고 |
|---|---|---|---|---|
| 1 | CSV | rehearsal | O | 기본 |
| 2 | CSV | cutover | X | Rule Engine 결과 → Loader 직행 |
| 3 | 비CSV (EBCDIC 등) | rehearsal | O | Source Reader 가 언패킹 |
| 4 | 비CSV | cutover | X | JOIN 없으면 DuckDB 우회 (Java 직접). JOIN 필요하면 케이스 2 로 강등 |

### 2.3 재시작 매트릭스
| 실패 지점 | 재시작 위치 |
|---|---|
| Source / CP1 생성 | 처음부터 |
| Rule Engine | CP1 부터 |
| Rehearsal 적재 | CP2 부터 |
| Cutover 적재 | CP1 부터 (CP2 없음) |

### 2.4 디렉터리
```
data/
├── incoming/             ← AS-IS 파일 도착
├── staging/cp1/          ← Raw Parquet
├── staging/cp2/          ← Transformed Parquet
├── staging/quarantine/   ← UDF NULL 행
├── drivers/              ← TO-BE JDBC JAR (사이트별 배치)
└── runs/                 ← Run 산출물
```

---

## 3. Rule Engine — DuckDB SQL + Java UDF

CP1 → CP2 단계 변환 엔진. **DuckDB 위에 얹는 얇은 룰 엔진**.

### 3.1 처리 순서 (한 SQL 안에서, 반드시 이 순서)
1. **JOIN / UNION** — CP1 Parquet 끼리. 원본 키 (예: `dept_code`) 기준.
2. **변환 룰 적용** — SQL (`CAST`, `CASE WHEN`) + Java UDF.
3. **Quarantine 분리** — UDF NULL 행을 별도 COPY 로.

**JOIN 을 변환보다 먼저 하는 이유**: 변환 전 원본 키로 JOIN 해야 키 불일치 방지.

### 3.2 SQL 패턴
```sql
-- 정상 행 → CP2
COPY (
    SELECT
        apply_scale(e.salary_raw, 2)    AS salary,
        convert_era(e.hire_date_raw)    AS hire_date,
        assign_seq(e.dept_code)         AS emp_seq,
        d.dept_name
    FROM read_parquet('cp1_emp.parquet') e
    JOIN read_parquet('cp1_dept.parquet') d ON e.dept_code = d.dept_code
    WHERE apply_scale(e.salary_raw, 2) IS NOT NULL
      AND convert_era(e.hire_date_raw) IS NOT NULL
) TO 'cp2_001.parquet' (FORMAT PARQUET);

-- 실패 행 → Quarantine (동일 JOIN 구조, WHERE 반전)
COPY (
    SELECT e.*, d.dept_name, 'UDF 변환 실패' AS reason
    FROM read_parquet('cp1_emp.parquet') e
    JOIN read_parquet('cp1_dept.parquet') d ON e.dept_code = d.dept_code
    WHERE apply_scale(e.salary_raw, 2) IS NULL
       OR convert_era(e.hire_date_raw) IS NULL
) TO 'quarantine.parquet' (FORMAT PARQUET);
```

### 3.3 등록 UDF (초기 3개)
| 이름 | 입력 | 출력 | 종류 | 비고 |
|---|---|---|---|---|
| `apply_scale` | VARCHAR, int | BigDecimal | scalar | COMP-3 추출 후 소수점 적용. 실패 → null |
| `convert_era` | VARCHAR | LocalDate | vectorized (2048행) | 일본 연호 ("令和8年5月16日"). 실패 → null |
| `assign_seq` | VARCHAR | long | scalar + **withVolatile() 필수** | 채번. 누락 시 DuckDB 캐싱 |

### 3.4 UDF 4 함정 (가장 잘 까먹는 것)
1. **null 입력 = null 반환** 으로 반드시 설계. 미처리 시 NPE → Job 전체 실패.
2. **withVolatile()** — 호출마다 다른 값 반환하는 UDF 필수.
3. **Connection 종속** — 새 Connection 마다 `registerAllUdfs()`.
4. **벡터화 UDF 의 DuckDBDataChunkReader 는 콜백 실행 중에만 유효** — 콜백 밖 저장 금지.

### 3.5 청크 분할 (대용량)
- LIMIT/OFFSET 으로 CP1 청크 단위 처리
- 임시 테이블 TRUNCATE 재사용 (CREATE 는 1회만)
- 청크마다: Appender 삽입 → `COPY TO cp2_NNN.parquet` → TRUNCATE
- 최종 적재: `read_parquet(['cp2_*.parquet'])` 통합 읽기
- JOIN 대용량: 작은 테이블 전체 유지 + 큰 테이블 청크 JOIN

---

## 4. 룰 입력 모델 — 3층 구조 (확정 2026-05-19)

사용자가 컬럼별 변환 룰을 입력하는 방식. **자동 → 위저드 → 자유 SQL** 의 3층 사다리.

### 4.1 1층 — 타입 기반 자동 매핑
AS-IS DDL + TO-BE DDL 보고 엔진이 기본값 자동 결정.

| AS-IS | TO-BE | 자동 결과 |
|---|---|---|
| Oracle `CHAR(10)` | PG `VARCHAR(10)` | `strategy=copy` |
| Oracle `CHAR(10)` | PG `VARCHAR(8)` | `strategy=cast` + 위험 플래그 (길이 줄어듦) |
| Oracle `NUMBER(10,2)` | PG `NUMERIC(10,2)` | `strategy=copy` |
| Oracle `DATE` | PG `TIMESTAMP` | `strategy=copy` |
| Oracle `NUMBER` | PG `INTEGER` | `strategy=cast` + 오버플로 위험 플래그 |
| Oracle `BLOB` | PG `BYTEA` | `strategy=copy` |

### 4.2 2층 — 구조화된 룰 (strategy + params)
자동이 안 되거나 사용자가 거부하면 드롭다운으로 선택.

| strategy | 컴파일 결과 (예) |
|---|---|
| `copy` | `src.col AS tgt_col` |
| `constant` | `'X' AS tgt_col` |
| `cast` | `CAST(src.col AS T) AS tgt_col` |
| `case_when` | `CASE src.col WHEN ... END AS tgt_col` |
| `comp3_decimal` | `apply_scale(src.col_raw, 2) AS tgt_col` |
| `era_to_date` | `convert_era(src.col_raw) AS tgt_col` |
| `seq` | `assign_seq(src.key) AS tgt_col` |
| `lookup` | `lkp.v AS tgt_col` + auto LEFT JOIN |
| `unmapped` | (컴파일 안 됨 — preflight 차단) |
| `custom_expr` | 사용자 입력 그대로 |

### 4.3 3층 — 자유 SQL (`custom_expr`)
1·2 층으로 표현 못 하는 1~5% 케이스. DuckDB SQL fragment 직접 입력.

### 4.4 핵심 규칙 — UDF 는 strategy 경로 only
**`custom_expr` 에서 UDF (`apply_scale` 등) 직접 호출 금지.** 모든 UDF 는 strategy 로 감싼다.

이유:
1. UDF 시그니처 변경 시 일괄 마이그레이션 지옥 회피
2. Sign-off 감사 시 strategy 컬럼만 SELECT 하면 변환 종류 파악 가능
3. 신규 변환 = 코드리뷰·테스트 통과한 strategy 만 사용 (감사·통제)

신규 UDF 도입 = 백엔드 코드 변경 (compiler 분기 추가). PoC 범위에서 변환 종류는 한정적이라 비용 작음.

### 4.5 `column_override` 스키마 (예정)
```
strategy        enum
params          jsonb
compiled_expr   text   -- 엔진이 채움 (custom_expr 일 때만 사용자 입력)
source          enum   -- auto | manual (1층 vs 2·3층 구분)
```

---

## 5. DuckDB 로 못 푸는 케이스 — Escape 사다리

### 5.1 사다리 1 — 새 UDF 추가 (90%+)
"DuckDB 가 못 한다" 의 실제 의미는 대개 "DuckDB 표준 함수에 그게 없다". → 새 Java UDF 추가. 같은 패턴.

실제 후보:
- 사내 AES 암호화 (key wheel 정책)
- 인증된 Java 라이브러리 호출 (예: `KsBankCheckDigit.validate()`)
- MeCab 형태소 분석 후 변환
- 회사 표준 정규화 알고리즘

### 5.2 사다리 2 — Java 전용 테이블 모드 (1~2%)
UDF 로도 안 되는 케이스 (상태 필요·다중 패스·인증된 row-by-row 라이브러리). **그 테이블만 DuckDB 우회**:

```
[일반]  Source Reader → DuckDB Appender → Rule Engine → Loader
[전용]  Source Reader → Java 처리기 → Loader
```

테이블 단위 플래그 `engine: duckdb | java`. snapshot 에 Java 클래스명 + 버전 동결 → deterministic replay 보장.

**비용**: DuckDB 의 벡터화 병렬 처리 포기. 정말 막힐 때만 사용.

---

## 6. 매핑 스냅샷 — 감사·재현성

승인된 매핑은 **`compiled_expr` 를 동결** 한다 (params 만 동결 X).

이유: 엔진/UDF 를 업그레이드해도 이미 sign-off 받은 snapshot 의 *의미* 가 변하면 안 됨 — 일본 금융권 감사 위반.

흐름:
```
사용자 룰 편집
  → 엔진이 compiled_expr 다시 채움 (column_override)
  → 승인 버튼 누름
  → compiled_expr 들을 mapping_snapshot.payload_json 에 복사 = 얼림
  → 이후 실행은 snapshot 의 얼린 SQL 만 사용 (column_override 안 봄)
```

전문용어: **deterministic replay**, **immutable snapshot**.

---

## 7. Source Reader SPI

| 어댑터 | 처리 |
|---|---|
| `CsvReaderAdapter` | DuckDB `read_csv()` 위임. Shift-JIS 는 `encoding='shift_jis'` (encodings 확장) |
| `EbcdicReaderAdapter` | FileInputStream 바이너리 모드 + COMP-3 비트 연산 언패킹 (상위/하위 니블, 마지막 니블 부호 `0xC`=양, `0xD`=음) + EBCDIC→UTF-8 |
| `FixedWidthReaderAdapter` | 레코드 길이 + 컬럼 offset·length 기반 |

폐쇄망: DuckDB encodings 확장 파일 인스톨러 번들 필수.

---

## 8. Loader Adapter SPI

| 어댑터 | TO-BE | 방식 |
|---|---|---|
| `PostgresLoaderAdapter` | PostgreSQL | `COPY FROM STDIN` (`CopyManager`) |
| `OracleLoaderAdapter` | Oracle | OCI Direct Path |
| `MySqlLoaderAdapter` | MySQL | JDBC + `reWriteBatchedInserts=true` |
| `SqlServerLoaderAdapter` | SQL Server | BulkCopy (TDS) |
| `JdbcFallbackAdapter` | 기타 | 일반 JDBC 배치 INSERT |

선택: `driverId` 기반 `AdapterFactory` 자동 선택.

TO-BE JDBC 드라이버 JAR: `data/drivers/` 디렉터리에 사이트별 배치. 동적 ClassLoader 로딩.

---

## 9. 메타DB 추가 테이블 (Flyway V7~ 예정)

기존 `site`·`project` (V4~V6) 위에:

| 테이블 | 역할 |
|---|---|
| `connection` | TO-BE DB JDBC 자격증명 (AES-GCM 암호화) |
| `parsing_source` | AS-IS 파일 메타 (인코딩·구분자·어댑터 종류) |
| `asis_db` | DuckDB store 메타 (워커별 식별) |
| `schema_diff` | TO-BE 테이블별 매핑 정의 (컬럼 차이 + 룰 헤더) |
| `column_override` | 컬럼 단위 변환 룰 (strategy, params, compiled_expr) |
| `binding_source` | JOIN/UNION 소스 바인딩 (PRIMARY / JOIN / UNION) |
| `mapping_snapshot` | 승인된 매핑 동결본 (`payload_json`) |
| `migration_run` | 실행 이력 |
| `run_quarantine` | 격리 행 로그 (run_id, stage, severity, reason, ...) |
| `audit_log` | 변경 이력 |

**원칙**: 엔티티만 만들고 Hibernate auto-DDL 금지. 반드시 Flyway `V{N}__*.sql`.

---

## 10. Coordinator / Worker 운영 모델

- **Worker → Coordinator** 연결: REST + WebSocket 만. **PG JDBC 접속 절대 없음.**
- **메타 PG bind**: `127.0.0.1` only — 외부 노출 금지. Coordinator 프로세스만 접속.

### 10.1 Worker 등록 흐름
1. Coordinator 설치 완료 시 화면에 표시:
   - Coordinator URL (예: `http://10.20.30.40:8080`)
   - Worker 등록 토큰 (예: `WK-7HQ3-2X5L-8MNP`)
2. Worker 설치 시 두 값 입력 → Coordinator API 등록 요청 → 토큰 검증 후 노드 추가
3. 토큰 형식: UUID 기반 + 사람이 옮겨치기 가능한 짧은 4-4-4 hex

### 10.2 통신 비대칭
| 방향 | 채널 | 용도 |
|---|---|---|
| Coordinator → Worker | WebSocket push | 작업 지시 |
| Worker → Coordinator | REST | 결과 보고, 상태 업데이트 |

### 10.3 Heartbeat
- Worker 가 Coordinator 에 30 초 간격 ping
- 일정 시간 미응답 시 노드 비활성 표시

---

## 11. 인스톨러 정책

- **동봉 PG 버전**: PostgreSQL (※ 미결 항목 6번 참조 — 문서 간 16/18 불일치 정리 중)
- **기존 PG 처리**: 사용자에게 "기존 사용 / 별도 인스턴스 새로 설치" 선택지 제공

### 11.1 인스톨러 책임 (순서)
1. PG 설치 여부 감지
2. 없으면 동봉 PG 자동 설치 (Windows Service 등록, 별도 포트·데이터 디렉터리·OS 계정)
3. 있으면 선택지 표시
4. 초기 DB·계정 생성 → Flyway 자동 마이그레이션 적용
5. Coordinator 시작 후 **URL + Worker 등록 토큰** 화면 표시

### 11.2 격리 원칙
- **TO-BE PG 와 격리 필수**: 같은 서버라도 다른 포트·다른 데이터 디렉터리·다른 OS 계정
- 인스톨러 자체는 jpackage 또는 WiX/NSIS (추후 결정)

---

## 12. 테스트 전략 (BE 필수)

### 12.1 H2 완전 폐기
- 의존성에서 제거. test scope 도 X.
- 이유: H2 PG-mode 가 진짜 PG 와 미묘하게 다름 (JSONB, ARRAY, 함수 등). "테스트는 통과했는데 prod 에서 깨짐" 사고는 일본 금융권 절대 금지.

### 12.2 Testcontainers + @ServiceConnection (Spring Boot 3.1+)
- `TestcontainersConfiguration` 빈에서 `PostgreSQLContainer<>("postgres:16-alpine")` 반환
- 표준 통합 테스트 패턴: `@SpringBootTest` + `@Import(TestcontainersConfiguration.class)`
- **개발자 PC 에 Docker 필수** (팀 정책 2026-05-14). Docker 없으면 자동 테스트 못 돌림.

### 12.3 Flyway 가 스키마 단일 책임
- Spring Batch 스크립트도 `V1__spring_batch_schema.sql` 로 직접 포함
- `spring.batch.jdbc.initialize-schema: never`
- Hibernate auto-DDL 절대 금지. 엔티티 추가 시 반드시 Flyway `V{N}__*.sql`

### 12.4 테스트 비중 가이드
| 분류 | 비중 | 예시 |
|---|---|---|
| PG 필요 (Testcontainers) | 20-30% | JPA Repository, 통합 테스트, 마이그레이션 검증, audit log |
| PG 불필요 | 70-80% | 변환 엔진 (DuckDB 임베디드), 매핑 로직, 인증 로직, DTO 변환 |

### 12.5 사내 공유 PG 는 자동 테스트 부적합
- 테스트 격리·동시성·CI 접근 문제
- 단 `mvn spring-boot:run` 으로 도구 직접 켜서 클릭하는 dev 용도엔 OK

---

## 13. 12-factor 배포 원칙

**현재 배포 모델** = jpackage 스탠드얼론 + 인스톨러 동봉 PG. K8s/Helm 은 현 단계 비용 과대 (일본 금융권 도입 결재 + 폐쇄망 운반 부담).

단, 미래 이전 가능성을 위해 12-factor 코드 습관 유지:

### 13.1 외부 주입 항목
| 항목 | 방식 |
|---|---|
| 설정 | 환경 변수 / 외부 파일 (하드코딩 X) |
| 메타 DB 접속 | host/port/user/pass 환경 변수 |
| 라이센스 (.lic) 경로 | path 외부 주입 |
| Coordinator URL (Worker 용) | 외부 주입 |
| 데이터 디렉터리 | 외부 주입 |

### 13.2 로그
- **stdout** 전용. 파일 X.

### 13.3 배포 형태 종속 코드 금지
- jpackage → docker → K8s 어디로 가도 코드 변경 0 이 목표
- docker-compose 는 **dev/test 한정** (운영 배포 아님)

### 13.4 K8s 는 세컨드 패스
- 고객 인터뷰에서 "K8s 클러스터 있어요, 거기 올리고 싶어요" 같은 명확한 요구가 나오면 추가 채널로 붙임

---

## 14. 미결 항목 (회의 필요)

1. **strategy enum 최종 목록 확정** — 4.2 표가 후보. 추가·통폐합 여부.
2. **`custom_expr` 에서 UDF 호출 금지 정책 공식화** — 4.4 결정 합의 필요.
3. **`unmapped` 를 정식 strategy 로 둘지 vs row 부재로 처리할지** — 진행률 계산 단순성 vs 테이블 사이즈 트레이드오프.
4. **compile-preview 엔드포인트 (DuckDB `EXPLAIN` 으로 design-time 검증)** PoC 범위 포함 여부.
5. **drop/ignore strategy** 를 `unmapped` 와 구분할지.
6. **PG 버전 문서 간 불일치** — `CLAUDE.md` 는 "PG 18 동봉", memory 와 `compose.yaml` 은 PG 16. 추정: dev local PG 18 / 인스톨러 동봉 PG 16 (안정성). 문서 정리 필요.

---

## 15. 더 읽을 곳

- `CLAUDE.md` — 스택·컨벤션·도메인 용어·로컬 실행
- `docs/handoff/` — 시점별 작업 인계 노트 (최근 파일 먼저 권장)
- `docs/DESIGN.md` — 초기 설계 (일부 outdated — 본 문서가 우선)
- `docs/USER_MANUAL.md` / `DEVELOPER_MANUAL.md` — UI·운영 매뉴얼
