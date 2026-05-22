# 2026-05-22 — mapping-test-and-report (Suhyun Jin)

## What was done

전날 wiring (DDL → 실데이터) 한 위에 PoC 핵심 흐름인 **Test → Report → Mapping Detail 왕복**을 완성하고, dialect-aware UX 와 deep-link gating 을 채워 넣었다. 작은 정정 다수 포함.

### 1) Test 흐름 재정의 — DB 저장 X, 결과만 미리보기
- Test 버튼은 더 이상 TO-BE DB 에 쓰지 않고, **변환 룰을 거친 결과 데이터를 프론트에서만 보여주는 dry-run** 으로 정의됨.
- `phase: 'test', runStatus: 'running' → 'completed'` 백엔드 업데이트는 그대로 유지 (workflow 추적).
- Test 완료 후 Test 버튼 옆에 **Report chip** 자동 노출. 클릭 → 전체 화면 Report 뷰.
- Test 버튼 라벨은 항상 `Test` (러닝 중에만 `Testing N%`). `Re-test` 라벨은 제거.

### 2) Report 화면 — Excel UI 흉내
`samples/excel-ui-prototype.html` 에 standalone 디자인 prototype 을 만들어 검토한 뒤, 그대로 React `ReportView` 컴포넌트로 옮김.

구조 (위 → 아래):
```
타이틀바 (#217346)  ─  {tableName} (읽기 전용) - Report
리본 메뉴바       ─  ファイル / ホーム / 挿入 / ... (디자인만)
수식 입력줄       ─  A1 ▾ · ✕ ✓ fx · "이 데이터는 DB에 저장되지 않습니다"
스프레드시트     ─  A B C 알파벳 헤더 + 1행=컬럼명·2행=타입(셀 병합) + 데이터
시트 탭          ─  Sheet1 (active, 단일)
상태바           ─  준비 완료 · 열 N · 행 N
```

- 1·2행 컬럼명/타입은 같은 회색 배경 + 1행 borderBottom 제거로 **셀 병합 효과**.
- 1·2·3행 모두 `position: sticky` 로 **고정 (freeze panes)**.
- 1·2행의 행번호 셀도 `left: 0` sticky → 가로 스크롤 시에도 좌측 고정.
- 컬럼이 많아지면 가로 스크롤 (`minWidth: 0` flex item 처리 + sheet `width: max-content`).
- 둥근 테두리 (`borderRadius: 8` + `overflow: hidden`) + 옅은 box-shadow.
- **컬럼명/타입 셀 클릭 → Mapping Detail (Inspector) 로 이동** + Report 닫힘 + 해당 컬럼 active.
- 타이틀바 ✕ 클릭 → Mapping 화면 복귀.

`previewValue(row, rowIdx)` 헬퍼가 결정적 해시 기반 더미 데이터 생성 (type 별 형식, nullable 컬럼은 약 6% 확률 NULL).

### 3) Site type 기반 dialect 흐름
**Backend (`DdlImportService`)**:
- `OracleDdlParser` 가 hardcoded `"oracle"` 로 저장하던 dialect 를 `Site` 정보로 실제 결정.
- `resolveDialect(project, side)` 가 `side=asis → site.asisDbType`, `side=tobe → site.tobeDbByEnv[site.environment].type` 을 normalize ("PostgreSQL 15" → `postgresql`, "SQL Server" → `mssql` 등).
- 알 수 없으면 `"oracle"` 폴백.

**Frontend (`MappingPage`)**:
- module-level `ASIS_DIALECT` / `TOBE_DIALECT` 추가. hydrate effect 가 **Site 의 type 을 1차 source 로** 사용 (DDL 임포트 시점이 아니라 매 store 갱신에 반영).
- `translateTypeToTobe(asisType, tobeDialect)` 변환표: `VARCHAR2 → VARCHAR`, `NUMBER → NUMERIC`, `CLOB → TEXT`, `BLOB → BYTEA`, `DATE (Oracle) → TIMESTAMP` 등.
- Inspector `computeAutoCast` 가 변환표 거친 결과로 src/tgt 비교 → 동일 타입이면 passthrough, 다르면 `CAST(col AS tgtType)` 생성.
- `handleEdit` 의 `initialAutoCast` 도 `computeAutoCast` 로 일원화 (이전엔 별도 로직이라 변환표 미적용).

### 4) Dialect chip — Topbar project sub 줄
- AppShell 사이드바의 site row 가 아니라 **topbar 의 project 이름 아래** (table count 왼쪽) 에 표시.
- `siteDialects(site) → {asis, tobe}` 헬퍼.
- 글자 작게 (9.5px), 옅은 회색 (`var(--text-4)`), 배경/border 없는 plain text.
- 형식: `Oracle → PostgreSQL · N tables`

### 5) Test 활성화 조건 단일 우선순위 표시
4 가지 조건 모두 만족해야 Test 활성:
1. `site.tobeDbByEnv[env]` 의 type/host/database/username 4 필드 모두 채워짐 (= site stage chip 녹색)
2. `bindingSources.length > 0`
3. `missingImports.length === 0` (Site.csvPath 가 채워져 있으면 PoC 한정 모두 imported 로 간주)
4. `counts.unmapped === 0`

**비활성 사유 칩은 한 번에 하나씩만 보임** (사용자가 단계별로 해결할 수 있도록):
- TO-BE DB not configured → AS-IS source not bound → CSV not imported → unmapped

각 칩을 클릭하면 해결 surface 로 점프:
- TO-BE DB → `useUiStore.requestOpenSiteSettings({focus: 'tobe-db'})` → Site Settings 모달 + TO-BE DB 카드 초록 pulse + auto scroll.
- AS-IS source → Table binding 패널 inset green pulse (1.5초).
- CSV → `requestOpenSiteSettings({focus: 'asis-csv'})` → Site Settings 모달 + csvPath 필드 초록 pulse.
- Unmapped → 클릭 동작 없음 (사용자가 그리드에서 작업).

### 6) Mapping Definition / Import YAML 모달
- `Auto-map unmapped` 버튼 → CSV 임포트 모달 (`Mapping Definition`).
- `Import YAML` 버튼 → YAML 임포트 모달.
- 둘 다 같은 `ImportFileModal` 컴포넌트 재사용 (props 로 title / accept / templateHref / hint 분리).
- Mapping Definition 만 **Download template** 버튼 (CSV) 있음. YAML 은 다운로드 없음.
- 모달은 file drop zone + import 버튼 (현재 console.log 만 — TODO: 백엔드 mapping-spec import API).

### 7) 템플릿 + 더미 샘플 데이터
**Templates** (frontend 다운로드용):
- `frontend/public/templates/mapping_definition_template.csv` (37 행)
- `frontend/public/templates/mapping_definition_template.yaml`
- 옛 `.xlsx` 템플릿은 자동 삭제됨.

**사용자 데스크탑 샘플**:
- `C:/Users/.../Desktop/JIN/ModernizeProData/samples/mapping_definition_sample.csv` / `.yaml`

**프로젝트 내 더미 DDL/CSV** (`samples/`):
- `ddl/asis_oracle.sql` (3 tables: M_EMPLOYEE / M_DEPARTMENT / T_CONTACT_LOG)
- `ddl/tobe_postgres.sql` (4 tables: employees / departments / contact_log + contact_attachment 1→2 split)
- `csv/HR.M_EMPLOYEE.csv` (10 rows), `HR.M_DEPARTMENT.csv` (10), `CRM.T_CONTACT_LOG.csv` (15)
- 19 종 변환 케이스 (passthrough / type cast / LOOKUP / split / skip / default / 신규 컬럼) 커버.

**스크립트**: `scripts/gen_mapping_template.py` 한 번 실행으로 4 곳 동기화 생성.

### 8) 잡 버그 / UX 정정
- 다른 프로젝트로 이동 후 Mapping 진입 시 selection lock 해제 → 첫 TOBE 자동 선택 (`activeProjectId` 변경 시 `didInitialSelectRef` reset).
- AS-IS schema 가 TO-BE 보다 먼저 도착하는 새로고침에서 초기 화면이 AS-IS 로 잡히던 버그 — **TOBE_TABLES 가 채워질 때까지 대기** 후 첫 TOBE 강제 set.
- Inspector 클릭 toggle: 같은 행 다시 클릭하면 Inspector 닫힘.
- Inspector 편집 자동 종료 버그 fix: `useEffect dep [active] → [active?.tgt]`. `active` 가 effective rule 재계산으로 매번 새 객체로 인식되어 편집 중 reset 되던 문제.
- `displaySrcName` 에 alias 포함 (`tr.TX_ID + em.EMP_NM` 형태).
- AS-IS source not bound 칩 클릭 → Table binding 패널 자동 open + 1.5초 inset green pulse (`boxShadow: inset 0 0 0 3px var(--green)` — outset 으로 하면 부모 overflow 에 잘림).
- `csvPath` 가 채워져 있으면 PoC 한정 모든 AS-IS 테이블 `imported: true` 로 간주 (실제 CSV import 상태 API 가 생기면 교체).
- `imported: true` 테스트 하드코딩은 제거됨 — `csvPath` 의 존재로만 판단.

## What the next person should do

1. **Mapping spec import 백엔드 wiring** — `ImportFileModal` 의 `Import` 버튼이 현재 `console.log` 만 함. CSV/YAML 파일 업로드 + 파싱 + `mappingEditsStore.setRowEdit` 일괄 호출 흐름 구현 필요.
2. **Test 결과 더미 데이터를 실제 변환 결과로** — 현재 `previewValue` 가 결정적 해시 기반. 백엔드에서 `mappingEditsStore` 의 룰 + AS-IS CSV row 를 받아 진짜 변환 결과를 반환하는 API 필요 (TO-BE DB 에는 쓰지 않음 — 흐름 §1 참고).
3. **AS-IS CSV import 상태 API** — 현재 `Site.csvPath` 존재 여부로 단순 판정. 실제 파일 존재 / 행 수 검증 / 테이블별 매핑 추적 필요.
4. **PostgreSQL DDL 파서** — 백엔드는 dialect 정보를 정확히 저장하지만 실제 파싱은 여전히 `OracleDdlParser` 하나만. PG/MSSQL/MySQL DDL 임포트하면 깨짐 (PoC 2 차 트랙).
5. **Site Settings 모달 enhancement** — 현재 TO-BE DB / AS-IS CSV 만 deep-link. 다른 영역 (encoding, environment 등) 도 비슷한 패턴으로 확장 가능.

## Pitfalls / decision history

- **zustand selector 가 매번 새 객체 반환하면 무한 재렌더링** — fallback 으로 `Object.freeze({})` 모듈 상수 (`EMPTY_BINDING_EDITS`, `EMPTY_SKIP_COLS`, `EMPTY_ROW_EDITS`, `EMPTY_ROW_EDITS_BY_TOBE`) 사용. selector 안에서 `... || {}` 절대 금지.
- **CAST 자동 갱신 — 조건부 덮어쓰기에서 무조건 덮어쓰기로** — closure stale / dataTypeRaw 비어있음 등 디버깅 비용이 너무 커서 `updateEditSrcAt` 안에서 source slot 변경 시 무조건 새 CAST 적용. 사용자가 SQL 직접 수정한 후 source 다시 바꾸면 덮어쓰여지지만, 이게 더 직관적이라 결정.
- **`--navy` CSS 변수가 teal (#0e7268)** — 브랜드 컬러라 "파랑" 의도와 안 맞음. dialect chip / passthrough state 의 파랑은 hex 직접 사용 (`#01589C`). StatusBadge 에 `blue` tone 신규 추가.
- **Inspector useEffect dep [active] → [active?.tgt]** — `active` 객체 reference 가 effective rule 재계산으로 매번 새로 만들어진다. 같은 컬럼인지 판별하려면 안정적 key (`tgt`) 만 dep 로.
- **box-shadow vs inset shadow** — Table binding pulse 가 양옆/아래 잘리던 문제. outer box-shadow 는 부모 overflow 에 잘리므로 컨테이너 내부 4면 균등하게 보이려면 `inset` 사용.
- **CSV path = imported** — PoC 단계 임시 판정. CSV import 상태 API 가 백엔드에 없어서 site 의 csvPath 한 줄로 모든 AS-IS 테이블 imported 처리. 실제 파일 단위 추적이 필요해지면 위 §3.
- **dialect chip 위치** — site row → topbar project sub 줄로 옮김. 작업 중 사이드바를 접고 있어도 보이도록.
- **Excel UI 재현은 prototype 우선** — `samples/excel-ui-prototype.html` 에 standalone HTML 로 디자인 확정 후 React 컴포넌트로 포팅. spec 검토 / 사용자 피드백 / iteration 비용이 React 직행보다 훨씬 낮음.

## Intentionally not done

- Report 화면의 **세로 스크롤 시 컬럼명/타입 영역이 가려지는 케이스** — sticky top 위치는 명확하지만 sheet 영역 자체의 height 가 작은 경우 동작 확인 안 함. 일반 케이스는 OK.
- `previewValue` 의 **NULL/DEFAULT 처리 일관성** — 컬럼이 `rule: 'default'` 인 경우 active.ddlDefault 값 그대로 표시. CASE 식 등 복잡한 변환은 표시 못 함 (백엔드 실행 결과가 필요).
- 옛 `report*` 스타일 객체는 코드 정리 시 제거 가능. 현재는 `xl*` prefix 와 공존.
- AppShell 의 site row 안 dialect chip 제거는 했지만 `siteDialects` 헬퍼는 그대로 — topbar 에서 재사용 중.
- Mapping spec import 의 실제 동작 (백엔드 wiring) — UI 만 완성, console.log 만.
