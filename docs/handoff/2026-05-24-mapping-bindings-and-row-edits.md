# 2026-05-24 — mapping-bindings-and-row-edits (Suhyun Jin)

`2026-05-23-mapping-import.md` 이후 작업. 임포트 후 후속 흐름 (테이블 바인딩 자동 derive, row 편집 영속화, mismatch 경고, re-apply) 전반을 메타DB 와 끝까지 sync. 매핑 정의서 import 만으로 끝나던 게 이제 그리드의 Table binding · row 룰 둘 다 DB 영속화.

## What was done

### 1) 테이블 바인딩 — mapping_table_bindings / mapping_table_binding_sources

**`V20260523210002__mapping_table_bindings.sql`** — 2 테이블 (parent + sources):

```
mapping_table_bindings           (TO-BE 1개당 1 row: composition_kind, where_filter, binding_origin, import_id)
└─ mapping_table_binding_sources (AS-IS 소스 N: alias, role primary/join/union, join_type, join_on)
```

- `(project_id, tobe_schema, tobe_table)` unique. binding_id 는 매번 새로 (update 시 delete-then-insert)
- `import_id` SET NULL — 임포트 row 삭제해도 binding 생존
- `binding_origin`: `imported` (auto-derive) / `manual` (UI 편집)
- sources child 의 `(binding_id, alias)` unique

**자동 derive** (`MappingImportService.deriveBindings`):
- parsed rule rows 를 (tobe_schema, tobe_table) 로 그룹화
- distinct asis_table 개수로 composition: 0=none, 1=single, 2+=join
- alias 도출: `rule_sql` 의 `{alias}.{column}` 토큰 → column 이 그룹 내 row 의 asis_column 과 일치하면 그 row 의 asis_table 과 묶음. 없으면 첫글자 lowercase 폴백 (`c`, `c2`, `c3`...)
- join_type / join_on / where_filter / union 분기 모두 NULL → UI 에서 사용자가 채움

**UI manual edit upsert** (`POST /api/v1/projects/{id}/mapping/bindings`):
- `MappingImportService.upsertBinding` 가 기존 binding 을 **명시적으로 delete + flush 후 새로 INSERT**. orphanRemoval 의 flush 순서가 alias unique 제약을 위반하던 케이스 회피.
- `created_by`/`created_at` 만 이전 row 에서 보존, 그 외엔 새 id 로 재생성.
- `binding_origin='manual'` 로 마킹.

**프론트 hydrate** (`hydrateBindingsFromDb`):
- `GET /mapping/bindings` → `MappingTableBindingDto[]`
- TOBE_TABLES 에서 (tobe_schema, tobe_table) name 매칭으로 `internalName` 찾음
- 매칭 실패한 binding 목록을 unmatched 로 반환 — Apply 시 경고에 사용
- `useMappingEditsStore.replaceBindingEdits(projectId, edits)` 로 일괄 교체. DB 가 single source of truth (빈 list 면 zustand 도 빈 상태로 — 삭제 후에도 반영)

### 2) Row-level 룰 — DB 영속화 (mapping_rules upsert)

기존엔 row 편집기 저장이 zustand 만 갱신했음. 이제 백엔드도 같이.

**`POST /api/v1/projects/{id}/mapping/rules`** (`MappingImportService.upsertRule`):
- 키: `(project, tobe_schema, tobe_table, tobe_column)` natural key
- 없으면 신규 (`mr-` 접두 UUID), 있으면 갱신
- `rule_origin='manual'` 자동 마킹
- `transform_sql` 폴백: 명시 안 됐고 `strategy=expression` 이면 `transform_rule` 값 그대로 복사

**`hydrateRowEditsFromDb`** — 페이지 마운트 + Apply 직후 호출:
- `GET /mapping/rules` + `GET /mapping/bindings` 동시 fetch
- bindings 로부터 alias 룩업맵 구축 → `mapping_rules.asis_table` 에 대응되는 alias 찾음
- 각 rule 을 `RowEdit` 로 변환 (savedSrc 는 `{alias}.{column}` 형태)
- `useMappingEditsStore.replaceRowEdits(projectId, edits)` 로 일괄 교체

`handleSaveEdit` 가 zustand 갱신 + `mappingImportApi.upsertRule(...)` 동시 호출. `ruleOrigin: 'manual'` 자동 부여.

### 3) `transform_sql` 컬럼

**`V20260524002919__mapping_rules_transform_sql.sql`** — `mapping_rules.transform_sql TEXT`.

용도 구분:
- `transform_rule` — 짧은 SQL 식 (예: `c.CUST_ID`, `NULLIF(c.X, '')`)
- `transform_sql` — 멀티라인 / 서브쿼리 / CTE 포함한 풀 SQL 단편 (향후 복잡한 변환식)

임포트 시 CSV 에 `transform_sql` 헤더 있으면 그대로, 없으면 `rule_sql` 값을 폴백 복사 (현재는 두 컬럼 다 SQL 라서 동일). row 편집기 upsert 도 같은 정책.

### 4) passthrough vs transform — `rule_origin` 기반 UI 구분

`RowEdit` 에 `ruleOrigin?: 'imported' | 'manual'` 추가.

`allRows` eff rule 분기 변경:
- `expression` + `ruleOrigin='imported'` (CSV 그대로) → eff=`auto` (passthrough)
- `expression` + `ruleOrigin='manual'` (사용자 수정) → eff=`rule` (transform)
- `expression` + src 만 있고 rule 없음 → eff=`auto` (기존 그대로)

`hydrateRowEditsFromDb` 가 DB 의 `rule_origin` 그대로 ruleOrigin 으로 매핑. `handleSaveEdit` 가 user 저장 시 `manual` 로 자동 설정.

### 5) Re-apply — CSV 텍스트 저장 + 재적용 엔드포인트

**`V20260524023425__mapping_imports_csv_content.sql`** — `mapping_imports.column_csv_content TEXT, code_csv_content TEXT`.

임포트 시 업로드된 bytes 를 UTF-8 텍스트로 저장. 사용자가 파일을 다시 고르지 않고 Apply 만 눌러도 (`columnPending.kind === 'none'` + `activeFiles.column` 있음) `reapplyLatest` 가 호출되어 저장된 CSV 로 전체 wipe + insert. 결과:

- 수동 수정한 룰 → 모두 `imported` 상태로 복원
- 그리드의 'transform' 표시 → 다시 'auto' (passthrough)

**`POST /api/v1/projects/{id}/mapping/reapply`** — 백엔드 service 가 최근 column_csv_content + code_csv_content 가 있는 row 를 찾아 `importFromCsv` 다시 실행.

### 6) Apply 시 mismatch 경고

`hydrateBindingsFromDb` 가 `TOBE_TABLES` 에 매칭 못 한 binding 의 qualified name 목록을 반환. `handleApply` 가 받아서 unmatched.length > 0 이면 amber 경고 박스 표시 + 모달 닫지 않음. 사용자가 인지하고 직접 Close.

### 7) Apply / Save 버튼 — 항상 활성

기존 Save 버튼은 pending 변경 있을 때만 활성. 이제 **Apply** 로 라벨 변경 + **항상 활성**:
- pending delete → DELETE 호출
- pending upload → POST /import 호출
- 둘 다 없으면 → `reapplyLatest` (저장된 CSV 로 재적용)
- 마지막으로 `rebuildBindings` 호출 (멱등)

### 8) joinOn / whereFilter — cursor-aware autocomplete

**`AutocompleteInput`** 컴포넌트 신규 (`HighlightEditor` 의 자동완성 로직을 단일 행 input 으로 추출):
- 커서 위치의 단어 ([\w.]+) prefix 매칭으로 dropdown
- ↑↓ 이동, Tab/Enter 선택, Esc 닫기, 마우스 hover 강조
- active 항목 inline 스타일 `background: var(--navy-50)` + `color: var(--navy)` (expression 편집기와 동일)
- 흰 박스 native input 외관 (HighlightEditor 의 dark blue 박스와 달리)

JOIN ON / WHERE filter 두 곳 모두 사용. `aliasColumnOptions = sources.flatMap((s) => ASIS_COLUMNS[s.table].map((c) => \`${s.alias}.${c.name}\`))`.

WHERE filter 도 local state + onWhereChange 콜백으로 영속화. `TableBindingEdit.whereFilter` 추가 → upsertBinding 의 `whereFilter` payload 로 DB 저장.

### 9) UX 디테일

- **Test → Trial**, **Testing → Running** 라벨 변경 (테스트 액션 명명 정리)
- TobeMappingDetail 의 `bindingSources` / `bindingMode` / `bindingWhere` 가 prop 으로만 초기화되고 이후 업데이트 안 되던 버그 — `useEffect` 로 prop 변경 시 동기화. Apply 후 새로고침 없이 즉시 반영.
- 모달의 import slot UI 단순화 (이전에 한 작업) — 흰 박스에 파일명 + 휴지통 + 폴더 아이콘 통합.

## Files touched

### 신규 (backend)
- `db/migration/V20260523194952__mapping_imports_code_filename.sql` (이전 round)
- `db/migration/V20260523210002__mapping_table_bindings.sql`
- `db/migration/V20260524002919__mapping_rules_transform_sql.sql`
- `db/migration/V20260524023425__mapping_imports_csv_content.sql`
- `coordinator/mapping/MappingTableBinding.java`
- `coordinator/mapping/MappingTableBindingSource.java`
- `coordinator/mapping/MappingTableBindingRepository.java`

### 수정 (backend)
- `coordinator/mapping/MappingImport.java` — code_filename, column_csv_content, code_csv_content 필드
- `coordinator/mapping/MappingRule.java` — transform_sql 필드
- `coordinator/mapping/MappingRuleRepository.java` — findByProjectIdAndTobeSchemaAndTobeTableAndTobeColumn
- `coordinator/mapping/MappingImportService.java` — deriveBindings, upsertBinding (delete-then-insert), upsertRule, reapplyLatest, rebuildBindings, CSV 본문 저장
- `coordinator/api/MappingImportController.java` — bindings GET/POST/DELETE, rules POST, rebuild-bindings, reapply, status

### 신규 (frontend)
- (없음 — 모두 기존 파일에 추가)

### 수정 (frontend)
- `src/api/mappingImport.ts` — 거의 모든 API wrapper 추가 (listBindings, upsertBinding, deleteBindings, listRules, upsertRule, rebuildBindings, reapplyLatest)
- `src/store/mappingEdits.ts` — replaceBindingEdits, replaceRowEdits; TableBindingEdit.whereFilter; RowEdit.ruleOrigin
- `src/pages/MappingPage.tsx`:
  - hydrateBindingsFromDb, hydrateRowEditsFromDb
  - refreshMappingStatus 가 unmatched 반환
  - handleBindingChange → upsertBinding 호출 (whereFilter 포함)
  - handleSaveEdit → upsertRule 호출 + ruleOrigin='manual' 자동
  - allRows eff 로직에 ruleOrigin 반영 (passthrough vs transform)
  - effectiveTobe 에 whereFilter override
  - AutocompleteInput 컴포넌트
  - CollapsibleBinding 에 whereFilter / onWhereChange prop
  - TobeMappingDetail 의 bindingSources/bindingMode/bindingWhere useEffect 동기화
  - Test → Trial / Testing → Running 라벨
  - MappingDefinitionImportModal: handleApply 가 reapplyLatest 폴백, warning state, Apply 항상 활성

## Open items / known limits

- **alias 매칭은 rule_sql 토큰 기반** — `rule_sql` 가 비어있거나 `{alias}.{col}` 패턴 없는 row 만 있는 테이블은 첫글자 lowercase 폴백. 사용자가 의도와 다른 alias 받을 수 있음. 추후 CSV 에 `asis_alias` 컬럼 옵션 추가 고려.
- **CSV content 영구 저장** — `mapping_imports.column_csv_content TEXT`. 50MB cap 은 컨트롤러 검증. 매번 임포트마다 새 row + 본문 누적 → DB 크기 우려. 추후 retention (최근 N개만 보관) 정책 필요.
- **JOIN type/ON 절·UNION 분기는 import 로 자동 못 채움** — `rule_sql` 만 보고는 JOIN 의미 추론 불가. UI 에서 사용자가 채우면 manual binding 으로 갱신.
- **`transform_sql` 은 사실상 transform_rule 과 동일** — 향후 풀 SQL 폼 (서브쿼리 등) 이 필요해지면 row 편집기에 transform_sql 별도 입력란 추가.
- **Manual binding 보존 정책 없음** — column 임포트 시 bindings 도 wipe + 재생성. `binding_origin='manual'` 인 row 도 같이 날아감. 사용자의 수동 binding 보존하려면 origin 별 분기 추가 필요.
- **passthrough/transform 판별이 origin 으로만 결정** — 임포트된 룰이 복잡한 CASE 식이어도 ruleOrigin='imported' 면 'auto' 로 표시. 의미상 'transform' 같지만 UI 는 'passthrough'. 사용자가 그 룰을 한 번 수정·저장하면 'manual' 되면서 'transform' 표시.

## Verification

1. 백엔드 재기동 (Flyway 가 새 migration 3개 적용)
2. Mapping → Auto-mapping 모달 → column CSV 픽 → Apply
3. 그리드 좌측 인벤토리에서 banksys.customers 클릭 → Table binding 패널에 `[c] BANKSYS.CUSTOMERS primary` 표시
4. Field mapping 영역의 rule 컬럼: 모든 row 가 'auto' (passthrough)
5. customer_id 행 편집기 → expression `c.CUST_ID || '-X'` 로 변경 → Save → row 의 rule 이 'rule' (transform) 로 바뀜
6. DB 확인: `SELECT tobe_column, transform_rule, transform_sql, rule_origin FROM mapping_rules WHERE tobe_column='customer_id'` → manual, 둘 다 새 값
7. Auto-mapping 모달 다시 열기 → 파일 픽 없이 그대로 Apply → customer_id 행이 다시 'auto' (passthrough) 로 복원 + DB 의 rule_origin='imported'
8. Table binding 에서 JOIN source 추가, ON 절에 `c.` 타이핑 → 드롭다운에서 컬럼 후보 강조 (navy-50), ↑↓ 이동, Tab/Enter 선택
9. JOIN ON / WHERE 저장 후 DB 의 `mapping_table_binding_sources.join_on` / `mapping_table_bindings.where_filter` 갱신 확인
10. column_mapping.csv 의 tobe 테이블 이름이 TOBE DDL 에 없는 경우 Apply 시 amber 경고 박스 + 모달 안 닫힘
