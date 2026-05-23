# 2026-05-23 — mapping-import (Suhyun Jin)

같은 날 작성한 `2026-05-23-report-csv-pipeline.md` 이후 작업. **맵핑정의서 (column / code CSV) 임포트 파이프라인 + 메타 DB 영속화** 추가. 임포트한 파일은 다른 PC / 세션에서도 동일한 상태로 보임.

## What was done

### 1) 메타 DB 스키마 — mapping 3 테이블

**`V20260523174402__mapping_rules.sql`** — 3 계층:
- `mapping_imports` — 파일 임포트 1회 단위 메타 (filename, size, hash, status, imported_by/at)
- `mapping_rules` — TO-BE 컬럼 단위 룰. `(project_id, tobe_schema, tobe_table, tobe_column)` unique
- `mapping_code_maps` — 코드값 변환 마스터 (`domain` + `source_value` → `target_value`)

식별자 정책:
- TO-BE 식별은 **name 기반** (`tobe_schema`/`tobe_table`/`tobe_column`) — DDL 재임포트로 `ddl_columns.id` 가 사라져도 이름 일치하면 자동 재연결
- `mapping_imports.id` 참조는 `ON DELETE SET NULL` — 임포트 row 지워도 룰은 살아있음
- `mapping_rules.strategy` ENUM: `expression` / `null` / `default` / `skip`
- `mapping_rules.rule_origin`: `imported` / `manual`

**`V20260523194952__mapping_imports_code_filename.sql`** — 부분 임포트 지원 위해:
- `mapping_imports.code_filename` 컬럼 추가 (code mapping 파일명 따로 보관)
- `mapping_imports.filename` 을 nullable 로 변경 (code 만 단독 임포트 가능)

### 2) DuckDB 로 CSV 파싱

`MappingImportService` — `read_csv` SQL 호출:

```sql
SELECT * FROM read_csv('{path}',
    header = true,
    delim  = ',',
    all_varchar  = true,
    null_padding = true
)
```

처음엔 `read_csv_auto` 썼다가 두 가지 함정 만남:
1. **자동 dialect 추론 실패** — small file + 특정 옵션 조합에서 sniffer 가 한 줄 전체를 단일 컬럼으로 잡음. 디버그 로그로 `headers.keySet()` 출력했더니 `["asis_table,asis_column,...,notes"]` 같이 한 덩어리. `delim=','` 명시로 해결.
2. **column count mismatch** — 우리가 만든 sample CSV 에 `NULLIF(c.X,'')` 같은 쉼표 포함 SQL 식을 쌍따옴표로 안 감싸서 일부 row 가 11 fields. CSV 자체 수정 + `null_padding=true` 옵션으로 안전망.

부수적으로 `cleanHeader()` 헬퍼 추가 — BOM, ZWSP, NBSP 등 보이지 않는 문자 명시 제거 (`String.trim()` 은 ≤ U+0020 만 처리하므로).

### 3) 임포트 서비스 — 트랜잭션 안에서 부분 덮어쓰기

협의 (2026-05-23):
- 임포트할 때마다 해당 프로젝트의 매핑 룰 / 코드맵 **전부 덮어쓰기** — `origin='manual'` 룰도 같이 날아감
- **부분 임포트 지원** — column 만 / code 만 업로드 가능. 업로드된 슬롯만 wipe + insert. 다른 슬롯은 그대로

```java
if (hasColumn) {
    ruleRepo.deleteAllByProjectId(projectId);
    ruleRepo.flush();
    ruleRepo.saveAll(...);
}
if (hasCode) {
    codeRepo.deleteAllByProjectId(projectId);
    codeRepo.flush();
    codeRepo.saveAll(...);
}
```

전체 `@Transactional` — 도중 실패 시 롤백.

`applyStrategy()` 헬퍼:
- CSV 에 `strategy` 컬럼 있으면 그대로 사용
- 없으면 `rule_sql` 셀 내용으로 추론 — `NULL`/`DEFAULT`/`SKIP` 상수면 해당 strategy
- 기본은 `expression`

`tobe_table` / `asis_table` 값이 `'.'` 포함하면 `schema.table` 으로 split.

### 4) REST API

```
POST   /api/v1/projects/{id}/mapping/import      multipart, column·code 둘 다 옵셔널 (적어도 하나 필수)
GET    /api/v1/projects/{id}/mapping/rules       활성 룰 전체
GET    /api/v1/projects/{id}/mapping/code-maps   코드값 변환 전체
GET    /api/v1/projects/{id}/mapping/imports     임포트 이력 (importedAt desc)
GET    /api/v1/projects/{id}/mapping/status      ★ 현재 활성 상태 (count 0 이면 filename null)
DELETE /api/v1/projects/{id}/mapping/rules       해당 슬롯 데이터 wipe
DELETE /api/v1/projects/{id}/mapping/code-maps   해당 슬롯 데이터 wipe
```

`status` 엔드포인트가 중요 — 단순히 mapping_imports 최신 row 를 반환하면 안 되고, **`mapping_rules.countByProjectId() > 0` 일 때만** `columnFilename` 반환. 삭제 후 즉시 빈 상태로 보이게 함.

`@Transactional` 주의 — `@Modifying @Query("DELETE ...")` 호출하는 컨트롤러 메서드에 `@Transactional` 없으면 `TransactionRequiredException` 으로 터짐. 두 DELETE 엔드포인트에 명시.

### 5) 프론트 — `MappingDefinitionImportModal` (stage + save)

기존 stub 모달 (`ImportFileModal`) 을 새 컴포넌트로 교체.

UI:
```
┌─ Mapping Definition ─────────── [column template] [code template] ┐
│                                                                    │
│ Column mapping  ┌─[흰박스] customers_column.csv         🗑 📁 ─┐    │
│                 └────────────────────────────────────────────┘    │
│ Code mapping    ┌─[흰박스] code_mapping.csv              🗑 📁 ─┐    │
│                 └────────────────────────────────────────────┘    │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                                          [ Save ]   [ Close ]      │
└────────────────────────────────────────────────────────────────────┘
```

각 슬롯:
- 라벨 + 흰 박스 (`var(--panel)` 배경)
- 박스 안: 파일명 + 🗑 휴지통 (활성 파일 있을 때만) + 📁 폴더 (FA `f07c` = `fa-folder-open`)
- 📁 클릭 → 파일 picker → 슬롯에 `{kind:'upload', file}` stage (DB 안 건드림)
- 🗑 클릭 → 슬롯에 `{kind:'delete'}` stage → 파일명 즉시 `—` 로 빈 칸 표시 + 휴지통 숨김
- Save → staged 처리: 삭제 (DELETE) → 업로드 (POST) 순서로 일괄 commit
- Close → staged 폐기

Save 버튼은 pending 변경 있을 때만 활성. 결과는 부모의 `mappingStatus` refresh.

부모 페이지 (`MappingPage`):
- 마운트 시 `mappingImportApi.status(projectId)` 호출 → `mappingStatus` 초기화
- "Auto-map unmapped" / "Auto-mapping" 버튼 라벨은 `mappingStatus.columnFilename || codeFilename` 기준
- 임포트/삭제 성공 → 콜백으로 status refresh

스타일 디테일:
- 템플릿 다운로드 버튼 색상 `#1A9E7A` (DBeaver Report breadcrumb 와 같은 그린 톤)
- 흰 박스 (파일명 + 아이콘 묶음) 하나로 통합 — 이전엔 row 가 회색 패널이고 안에 흰 버튼이 따로
- 휴지통/폴더 아이콘은 흰 박스 안에서 transparent 배경 (튀지 않음)
- pending upload 시 파일명 이탤릭 (저장 전임을 표시)

### 6) Sample CSV / 템플릿

- `/Users/Jinjinzara/Sample/mapping/column_mapping.csv` 새 컨벤션 (asis_*/tobe_*/strategy/rule_sql) 로 다시 작성 + 쉼표 포함 SQL 식 모두 쌍따옴표 escape
- `/Users/Jinjinzara/Sample/mapping/code_mapping.csv` 그대로
- 신규 템플릿 `frontend/public/templates/code_mapping_template.csv`
- 기존 `mapping_definition_template.csv` 는 column 템플릿 다운로드 대상으로 재사용

## Files touched

### 신규 (backend)
- `db/migration/V20260523174402__mapping_rules.sql`
- `db/migration/V20260523194952__mapping_imports_code_filename.sql`
- `coordinator/mapping/MappingImport.java`
- `coordinator/mapping/MappingImportRepository.java`
- `coordinator/mapping/MappingRule.java`
- `coordinator/mapping/MappingRuleRepository.java`
- `coordinator/mapping/MappingCodeMap.java`
- `coordinator/mapping/MappingCodeMapRepository.java`
- `coordinator/mapping/MappingImportService.java`
- `coordinator/api/MappingImportController.java`

### 신규 (frontend)
- `src/api/mappingImport.ts`
- `public/templates/code_mapping_template.csv`

### 수정 (frontend)
- `src/pages/MappingPage.tsx` — `MappingDefinitionImportModal` + `MappingFileRow`, `mappingStatus` state, `mappingImportApi` 호출, 버튼 라벨 토글, 모달 호출부

## Open items / known limits

- **`activeMappingFiles` derive 로직이 status 엔드포인트에 의존** — `mapping_rules.count > 0` 일 때만 column 파일명 보여줌. 룰을 수동 수정/추가했는데 임포트 이력은 없는 경우엔 파일명 빈 상태로 보일 수 있음. 정상 동작이지만 사용자 혼란 가능.
- **임포트 결과를 그리드에 반영하는 부분 미구현** — 임포트해도 zustand 의 `rowEdits` 는 아직 DB 의 `mapping_rules` 와 sync 안 됨. step 5 (DB → zustand 동기화) 가 다음 작업.
- **부분 임포트의 시멘틱 미세 위험** — column 만 업로드 시 rules 만 wipe + reinsert. `mapping_rules.import_id` 가 새 row 를 가리킴. 기존 code_maps 의 import_id 는 이전 row 를 그대로 유지 (`ON DELETE SET NULL` 이라 안전).
- **CSV row 중복 정책** — 같은 (tobe_schema, tobe_table, tobe_column) 두 번 나오면 **첫 row 만 사용**, 나머지는 WARN 로그 후 무시. 사용자가 의도적으로 override 하고 싶을 땐 모름.
- **인코딩** — UTF-8 전제. Shift-JIS 같은 일본 금융 CSV 는 미지원 (`read_csv` 의 `encoding` 옵션으로 분기 필요).
- **파일 크기** — 50MB cap. 큰 매핑정의서는 스트리밍 임포트 필요.

## Verification

1. 백엔드 재기동 → Flyway 가 두 migration 적용 (`mapping_imports` / `mapping_rules` / `mapping_code_maps` 생성 + `code_filename` 컬럼 추가, `filename` nullable 변경)
2. Mapping 페이지 → **Auto-map unmapped** 클릭 → 모달 열림
3. column / code template 다운로드 가능 확인 (그린 톤)
4. 📁 클릭 → 두 CSV 픽 → 파일명 이탤릭 stage
5. **Save** → 모달 닫힘, 버튼 라벨이 **Auto-mapping** 으로 바뀜
6. `SELECT * FROM mapping_imports WHERE project_id=...;` → 1 row
7. `SELECT COUNT(*) FROM mapping_rules WHERE project_id=...;` → 35
8. 모달 다시 열면 두 파일명 보임
9. 🗑 클릭 → 파일명 `—` 로 즉시 변경, 휴지통 사라짐
10. **Save** → DB 의 해당 슬롯 비워짐, 모달 다시 열면 그 슬롯 `—`
11. **Close** (Save 안 함) → 아무것도 변하지 않음
