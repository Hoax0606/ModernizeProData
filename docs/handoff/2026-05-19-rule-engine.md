# 2026-05-19 — rule-engine (오현호)

## 한 일

- 룰엔진 설계 토론을 한 단계 더 진행. **3층 입력 모델** + **UDF 호출 정책** + **DuckDB 한계 시 escape 경로** 합의안 정리.
- 팀 공유본 `ONBOARDING.md` 신규 작성 — 15개 섹션으로 Phase·Pipeline·Rule Engine·SPI·메타DB·테스트·배포 원칙까지 통합 정리. 팀 공유 URL: **https://claude.ai/claude-code/onboard/Ivi36S3KLJGC** (팀원 Claude Code 에서 그대로 열림).
- 본 handoff 는 그 중 룰엔진 부분의 결정·근거·미결 항목만 집중 발췌.

## 합의된 설계 (요지)

### 1. 룰 입력은 3층 구조
1. **자동** — `schema_diff` 의 AS-IS/TO-BE 타입 보고 엔진이 `strategy=copy|cast` 기본값 자동 채움 (예: Oracle `CHAR(10)` → PG `VARCHAR(10)` = copy)
2. **위저드** — 드롭다운으로 strategy 선택 + `params` (jsonb) 입력. `comp3_decimal`, `era_to_date`, `seq`, `lookup`, `case_when` 등
3. **자유 SQL** — `custom_expr` 에 DuckDB SQL fragment 직접 입력 (escape hatch)

### 2. UDF 는 strategy 경로 only
- `custom_expr` 에서 `apply_scale(...)` 같은 UDF **직접 호출 금지**
- 모든 UDF 는 strategy 가 감싸서 호출. 신규 UDF = 백엔드 코드에 strategy 추가
- 이유: UDF 시그니처 변경 시 일괄 마이그레이션 지옥 회피 + 감사 시 strategy 컬럼만 보면 변환 종류 파악

### 3. DuckDB 한계 시 escape 사다리
- **사다리 1 (90%+)** — 새 Java UDF 추가. 기존 패턴 그대로
- **사다리 2 (1~2%)** — 그 테이블만 DuckDB 우회 = `engine: java` 플래그. Source Reader → Java 처리기 → Loader 직행. 벡터화 병렬처리 포기하지만 사고는 면함

### 4. 매핑 스냅샷은 `compiled_expr` 를 얼린다
- `params` 만 얼리면 컴파일러·UDF 업그레이드 시 같은 params 가 다른 SQL 을 생성 → 의미 변경 사고
- 따라서 `mapping_snapshot.payload_json` 에 **컴파일 결과 SQL fragment** 자체를 저장 (= deterministic replay)

## 다음 사람이 할 일

룰엔진 본격 구현 들어가려면 아래 미결 항목 중 최소 1·2·3 이 결정돼야 한다. 다음 BE 작업자 (임지영 / 배성민) 가 회의 잡고 결정 → Flyway V7 작성 시작.

1. **strategy enum 최종 확정** — 현 후보: `copy / constant / cast / case_when / comp3_decimal / era_to_date / seq / lookup / unmapped / custom_expr`. 추가·통폐합 검토.
2. **`custom_expr` 에서 UDF 호출 금지 정책 공식화** — 위 설계 합의 결재.
3. **`unmapped` 처리 방식** — 정식 strategy 로 두기 (모든 컬럼이 `column_override` row 가짐) vs row 부재로 처리. 진행률 계산 단순성 vs 테이블 사이즈 트레이드오프.
4. **compile-preview 엔드포인트** — sign-off 전 DuckDB `EXPLAIN` 으로 SQL 정합성 미리 검증. PoC 범위 (2026-05-31) 포함 여부.
5. **drop/ignore strategy** — "의도적으로 안 매핑" 을 `unmapped` 와 구분할지 (UI 가시성 차이만 있음).

위 결정 직후 시작할 구현:
- Flyway `V7__column_override.sql`, `V8__binding_source.sql`, `V9__mapping_snapshot_extended.sql` 등
- `com.ksinfo.modernize_pro_data.coordinator.rule.RuleCompiler` — strategy + params → compiled_expr 생성
- `com.ksinfo.modernize_pro_data.coordinator.rule.SnapshotFreezer` — 승인 시 column_override → mapping_snapshot.payload_json 복사
- DuckDB UDF 등록: `apply_scale`, `convert_era`, `assign_seq` (Connection-scope `registerAllUdfs()`)

## 함정 / 결정 이력

- **JOIN 은 반드시 변환보다 먼저** (한 SQL 안에서 JOIN → 변환 → Quarantine 순서). 변환 후 join 하면 키가 깨질 수 있어 매칭 실패 — 이건 절대 흔들면 안 됨.
- **UDF 가 NULL 을 반환 = Quarantine 시그널** 이라는 약속. 그래서 모든 UDF 는 실패 시 throw 가 아니라 `null` 반환으로 설계. 미준수 시 NPE → Job 전체 실패. 새 UDF 작성하는 사람 주의.
- **`assign_seq` 에 `withVolatile()` 누락 = 채번이 같은 값으로 캐싱됨**. DuckDB 가 deterministic 으로 가정해 식별 캐시. 호출마다 다른 값 내는 UDF 는 무조건 volatile 표시.
- **자동 매핑은 위험 플래그도 동반해야 함** — `CHAR(10)` → `VARCHAR(8)` 같은 길이 축소나 `NUMBER` → `INTEGER` 같은 오버플로 위험은 자동으로 cast 걸어주되 UI 에 노란불.
- **DESIGN.md 의 "단순 1:1 도 SQL, 복잡 N:N 도 SQL — 한 가지 형식" 은 UI 운영 관점에서 outdated.** 컬럼 단위 strategy 가 1급이 됐고, SQL fragment 는 그 하위 표현 수단이 됨. DESIGN.md 자체는 본 합의 반영 안 됨 (정정은 별도 PR 에서).

## 안 한 것 (의도적으로)

- 코드 작성 안 함. 설계 토론·문서화만.
- **위저드 UI 디자인** 은 FE 측 (恩田·진수현) 협의 필요. strategy 별 위젯 모양·자동 결과 표시 방식 미정.
- **compile-preview API 스펙** 은 PoC 범위 결정 후 작성.
- **`column_override` 의 정확한 컬럼 (위 4번 결정 후)·인덱스·제약** 은 V7 마이그레이션 작성 시점에 결정.
- `docs/DESIGN.md` 의 stale 부분 (section 7 "매핑 정의 형식") 정정은 별도 PR. 본 handoff 는 ONBOARDING.md + memory 가 우선이라는 명시만 둠.

---

## 함께 들어간 변경 — snapshot versioning (배성민, 2026-05-19~20, branch `feature/versions`)

룰엔진 설계와 병행으로 진행된 별도 작업. 룰엔진 본구현과 직접 의존 없음.

### 한 일
- `Snapshot` 엔티티에 `version VARCHAR(16)` 컬럼 추가 + Flyway 마이그레이션 (`(project_id, version)` 인덱스 포함). 기존 데이터는 `v1.0` 으로 backfill.
- 자동 채번 정책 `Snapshot.generateNextVersion(latestVersion, latestStatus)`:
  - 직전 snapshot **approved** → major bump (`v1.x → v2.0`)
  - 그 외 (`draft / pending / rejected`) → minor bump (`v1.0 → v1.1`)
  - 첫 생성·파싱 실패 → `v1.0` fallback
- `SnapshotController.create` 가 `findLatestByProjectId` (`ORDER BY created_at DESC LIMIT 1`) 결과로 다음 버전 결정 후 저장.
- `VersionsPage.tsx` 재작성 — version 표시, `Cutover Snapshot` 태그, `UI only` 마커 정리. cutover 생성 버튼은 **rehearsal 이후 phase** 에서만 활성, 빨간 strong 확인 다이얼로그 1회.
- 새 snapshot 생성 직후 자동 선택을 "마지막 row" 가 아닌 **방금 만든 id** 로 변경 (race 회피).
- `store/auditLog.ts` 신규 — zustand `persist` 로 클라이언트 localStorage 영속. 프로젝트 단위 누적·count·collapse. delete-all 시 audit log 도 같이 비움.
- `ApprovalsPage` — 요청 버튼 일원화 + 확인 다이얼로그 위치 조정.

### 다음 사람이 할 일
1. **서버 `audit_log` 테이블 마이그레이션 들어오면** `store/auditLog.ts` 의 영속 구현만 API 로 교체. 인터페이스(`add / getByProject / clearByProject`)는 그대로 두기.
2. **승인 후 rollback 시 버전 회수 정책** 결정 — approved snapshot 을 삭제하면 현재 코드는 "그 다음 row 기준으로 다시 채번" 이라 사실상 회수됨. 일본 금융권 감사 관점에서 회수 허용 여부 확인 필요.
3. version 기준 정렬 UI 추가 시 lexicographic 정렬 함정 주의 (`v10.0 < v2.0`). 현재 UI 는 `created_at` 기준이라 무관.

### 함정 / 결정 이력
- **version 채번을 DB 시퀀스가 아닌 코드에서 계산** — major/minor 의미가 "직전 status 분기" 라 DB 제약/시퀀스로 표현 불가. 트랜잭션 안에서 `findLatestByProjectId → 계산 → save`. 동시성은 폐쇄망 단일 사용자 시나리오에 의존.
- **`Snapshot.create` 오버로드 2개 유지** — 신규 시그니처 (`nextVersion` 인자 추가) 와 기존 시그니처 (`v1.0` 고정) 둘 다 남김. 시드·테스트 코드 호환용. **운영 코드는 무조건 신규 시그니처**.
- **AUDIT LOG 가 localStorage 인 이유** — 서버 `audit_log` 테이블이 아직 없는 상태에서 PoC 데모용 임시. PC 간 동기화 안 됨을 의도적으로 수용.
- **cutover snapshot 확인 다이얼로그는 production 가드와 별개** — 백엔드에 prod 가드는 그대로 있고, UI 에서 사용자 실수 방지용으로 한 번 더 막는다.

### 안 한 것 (의도적으로)
- 서버 사이드 audit log (위 1번). 다음 BE 작업자 몫.
- version 수동 편집·강제 major bump 버튼. 자동 채번만으로 충분하다 판단.
- snapshot 간 diff UI. mapping 화면 작업과 함께 진행 예정.
- i18n 키 추가 — version·`Cutover Snapshot` 태그는 영문 고정 정책이라 ko/ja/en 동일.
