# 2026-05-21 — mapping-iterations (Suhyun Jin)

## What was done

`MappingPage` UX 다회차 반복 — 사용자 피드백 기반으로 그리드/Inspector/Coverage bar/AS-IS 화면을 손봤다.
주요 변경 4개 영역:

1. **백엔드 실데이터 연결**: mock fixture(`ASIS_TABLES`/`TOBE_TABLES`/`ASIS_COLUMNS`/`MAPPING_BY_TOBE`) 전부 삭제하고,
   `useAsisDdlStore` / `useTobeDdlStore` 의 `DdlSchema` 응답으로 hydrate. `MappingPage` 마운트 시 `fetch(activeProjectId)` 자동 호출.
2. **편집 상태 영속화**: `useMappingEditsStore` 신규 생성 (localStorage persist). `tableBindingEdits`, `rowEdits` (per TO-BE table), `asisSkippedCols` 를 projectId 단위로 격리 저장.
   메뉴 이동·새로고침 후에도 작업 흔적이 유지된다.
3. **TEST 버튼 → projectApi.update**: `phase: 'test' + runStatus: 'running'` → 100% 완료 시 `runStatus: 'completed'`.
   `SettingsPage` 패턴 그대로 `projectApi.update` + `fetchProjects` 재호출.
4. **DDL 미임포트 화면 통일**: `DashboardPage` 의 `MappingOnboarding` 을 `export` 로 빼서 `MappingPage` 에서 재사용.
   `project.tableCount === 0 || tobeTableCount === 0` 이면 Dashboard 와 동일한 3-step welcome card 표시.

## 화면 구조

```
MappingPage
├── DualInventory               (sidebar)
│   ├── AsisInventory
│   └── TobeInventory
│       └── activeTab 이 selected.side 와 자동 sync
└── Workspace
    ├── TobeMappingDetail       (key={internalName})
    │   ├── context bar         (TO-BE pill / unmapped 배지 / CSV not imported 배지 / Test 버튼)
    │   ├── CollapsibleBinding  (AS-IS source binding)
    │   ├── toolbar             (search / Import YAML / Auto-map)
    │   └── grid + Inspector
    │       ├── gridScroll      (sticky thead at top:56)
    │       │   └── TobeCoverageBar (sticky top:0)
    │       ├── InspectorRail   (항상 보이는 22px toggle 막대)
    │       └── Inspector       (340px, 헤더 sticky + 본문 scroll)
    └── AsisTableDetail         (key={asisName})
        ├── context bar
        ├── routing panel       (effectiveTobe 기반)
        └── columns grid
            ├── CoverageBar     (sticky top:0)
            └── thead/tbody     (thead sticky top:56)
```

## State 모델 (영속/비영속 구분)

**localStorage 영속** (`useMappingEditsStore`):
```ts
tableBindingEdits: Record<projectId, Record<tobeInternalName, TableBindingEdit>>
rowEdits:          Record<projectId, Record<tobeInternalName, Record<targetCol, RowEdit>>>
asisSkippedCols:   Record<projectId, Record<asisTableName, Record<colName, boolean>>>
```

**컴포넌트 ephemeral**:
- 선택 상태(`selected`), 필터(`coverageFilter` / `colFilter`), 검색(`q`/`search`), Inspector open/close, edit 모드(`editingRule`, `editValue`, `editSrc`...)
- Test 진행률(`testStatus`, `testProgress`)

## DDL → 컴포넌트 변환 함수

`MappingPage.tsx` 모듈 상단에 4개:

- `ddlToAsisTables(schema)` → `AsisTable[]`. `imported: true` 로 표시 (TODO: 실제 CSV import 상태 API 연결 시 교체).
- `ddlToTobeTables(schema)` → `TobeTable[]`. `internalName = DdlTable.id` (UUID).
- `ddlToAsisColumns(schema)` → `Record<fullName, AsisColumn[]>`. `c.dataTypeRaw || c.dataType || '—'` fallback.
- `ddlToMappingByTobe(tobeSchema)` → 모든 컬럼이 `rule: 'unmapped', status: 'queued'` 인 초기 매핑.

module-level `ASIS_TABLES` / `TOBE_TABLES` / `ASIS_COLUMNS` / `MAPPING_BY_TOBE` 는 mutable `let` 로 두고,
schema 변경 시 useEffect 가 다시 채워서 `hydrationTick` 으로 children re-render 트리거.

## State 컬럼 색 체계

| 라벨 | 색 | 카테고리 |
|---|---|---|
| `skip` | 회색 | 무시 |
| `unmapped` | 빨강 | **TEST 차단** |
| (status err) | 빨강 | 변환 에러 |
| (status warn) | 노랑 | 변환 경고 |
| `pass` (auto) | 파랑 `#01589C` | 자동 매핑 |
| `rule` / `null` / `default` / `new` | 초록 계열 | 명시적 매핑 |

`TobeCoverageBar` 의 segment/dot 5색은 다른 의미 — **rule 종류별 구분** (Unmapped 빨강, 나머지는 Default 를 기준으로 점점 옅어지는 green 계열):

| 카테고리 | hex | 의미 |
|---|---|---|
| Unmapped | `var(--red)` | 결정 안 됨 |
| Passthrough | `#059669` (가장 진함) | 사용자 개입 거의 없음 |
| Transform | `#34d399` | 사용자 SQL |
| Null | `#6ee7b7` | NULL 명시 |
| Default | `#a7f3d0` (가장 옅음) | DDL DEFAULT |

## 매핑 작업 핵심 규칙

- **자동 CAST**: Inspector 의 source slot 변경 시 `updateEditSrcAt` 이 항상 `CAST(<col> AS <tgtType>)` 또는 같은 타입이면 컬럼명만 입력.
  source 비우면 `-- NOT MAPPED YET — PICK A STRATEGY` 자동 입력 후 validation 우회하고 저장 가능 (unmapped 로 회귀).
- **NOT NULL / Default 읽기전용**: DDL 에서 받은 `active.tgtNullable` / `active.ddlDefault` 만 표시. 편집 불가.
- **NULL strategy 잠금 조건**: (1) source 가 매핑돼 있거나, (2) `active.tgtNullable === false` 이면 NULL 선택 불가.
- **Default strategy preview**: 항상 `active.ddlDefault` (없으면 `NULL`) 를 typed literal 로 표시.
- **effectiveRule derive**: `allRows` useMemo 가 `rowEdits.savedStrategy/savedRule/savedSrc` 를 보고 `auto`/`rule`/`null`/`default`/`unmapped` 로 재계산.
  source 비우고 SQL 도 비우면 다시 `unmapped` 로 회귀.
- **AS-IS routing**: `effectiveAsis` 가 `effectiveTobe.sources` 를 역추적해 동적 계산. TO-BE 에서 binding 추가하면 AS-IS 사이드바 배지가 즉시 `→ N` 으로 바뀜.
- **AS-IS Mapped TO-BE**: `computeAsisMappings` 가 `MAPPING_BY_TOBE` × `rowEdits` 를 모두 반영. user 매핑한 col 이 즉시 mapped 로 보임.

## CSV not imported 배지 → Settings 이동

`MappingPage` 의 배지 클릭 → `navigate('/settings', { state: { highlightSide: 'asis-csv' } })`.
`SettingsPage` 가 `HighlightSide = 'asis' | 'asis-csv' | 'tobe'` 로 확장돼,
`asis-csv` 인 경우 AS-IS 섹션의 `CsvSourceCard` 자체에 1초 amber `box-shadow` pulse 를 표시.

## Inspector 구조

```
<aside .inspector>                 // overflow: hidden, flex column
  <div .inspectorHeader>            // sticky top:0
    <div .inspectorHeaderTopRow>    // [Mapping detail] [↺ icon] [✕ icon]
    <big>{active.tgt}</big>         // TO-BE column (먼저)
    <small>← {srcs.join(' + ')}</small>  // AS-IS columns (전부 표시)
  </div>
  <div .inspectorBody>              // flex:1, overflow: auto
    <inspectorMeta>...
    <Transform section>
    <inspectorActions>              // Save / Cancel / Edit rule
  </div>
</aside>
```

- 헤더의 ↺ 아이콘 (`Ic.refresh`) = Clear (해당 컬럼 rowEdits 초기화)
- 헤더의 ✕ 아이콘 = Inspector 닫기 (InspectorRail 의 toggle 과 동일)
- 본문만 스크롤, 헤더는 컬럼명/버튼 항상 보임

## 그리드 가로 스크롤

TO-BE 그리드의 컬럼 폭이 fixed 였을 때 source/target type 이 길면 잘렸음. `tableLayout: 'auto'` + col px 고정 + `table minWidth: 980` 로 변경 →
content 가 길어지면 컬럼이 자동 확장되고 `gridScroll` 의 `overflow: auto` 로 가로 스크롤바가 자동 생김.

## What the next person should do

1. **mapping snapshot 백엔드 API**: 현재 `rowEdits` 는 localStorage 에만 살아있다. V9 Flyway + snapshot save/load API 가 생기면 `mappingEditsStore.clearProject(projectId)` 를 snapshot save 직후 호출해서 in-progress 흔적을 비우는 패턴으로 동작.
2. **AS-IS CSV import 상태 API**: `ddlToAsisTables` 의 `imported: true` 하드코딩은 PoC 용. `projectMeta.csvImported[]` 같은 백엔드 필드가 생기면 그걸로 교체.
3. **TobeTable.sources 영속화**: 현재 binding 도 localStorage 에만 있다. snapshot save 시 함께 전송.
4. **mapping rule validation 강화**: 지금 `validateRule()` 은 토큰 카운트 / 괄호 balance / 빈 문자열만 검사. SQL parser 통합이 정공법이지만, 우선은 알려진 함수명 (`CAST`, `TO_DATE`, `TO_TIMESTAMP`, `iconv`, `unpack_comp3` 등) 화이트리스트 검사 정도면 도움이 된다.
5. **Distinct/rows 통계**: 현재 0으로 표시. CSV import 후 백엔드가 `ANALYZE` 결과를 `ddl_columns.nullPct/distinct` 같은 필드로 채우면 그대로 살아남.

## Pitfalls / 결정 사항

- **zustand selector 무한 렌더링**: `selector` 안에서 `... || {}` 처럼 매번 새 객체 리터럴을 반환하면 `Object.is` 비교가 매번 false 라 무한 재렌더링이 발생한다. 모듈 최상단에 `EMPTY_BINDING_EDITS`, `EMPTY_SKIP_COLS`, `EMPTY_ROW_EDITS`, `EMPTY_ROW_EDITS_BY_TOBE` 4 개 frozen 빈 객체 상수를 두고 fallback 으로 사용 — 같은 reference 보장.
- **CAST 자동 갱신**: 조건부 (`editValue === '' || === prevAutoCast`) 로 시작했으나 closure stale 문제로 동작이 불안정했다. **source slot 변경 시 무조건 덮어쓰기** 로 단순화. 사용자가 SQL 직접 수정한 후 source 를 다시 바꾸면 덮어쓰여진다 — 그게 더 직관적이라 결정.
- **`--navy` CSS 변수가 teal (`#0e7268`)**: 브랜드 컬러라 "파랑" 의도와 맞지 않아 Passthrough 색은 hex 직접 사용 (`#01589C`). StatusBadge 에 `blue` tone 신규 추가.
- **타이틀 순서**: 처음엔 AS-IS → TO-BE 였지만 사용자 피드백으로 TO-BE → AS-IS 로 반전. Inspector 본문에서 작업 대상은 TO-BE 쪽이라 큰 글자가 TO-BE 컬럼명, 작은 글자가 AS-IS 출처.
- **InspectorRail 항상 표시**: x 닫기 버튼만 있던 구조 → rail 항상 보이고 클릭 시 toggle. 닫혀있을 때도 rail 자체로 "여기에 detail 있다" 를 알려준다.

## Intentionally not done

- 그리드 가상화 (테이블이 수천 row 일 때 성능). 일단 raw render.
- 사용자 권한별 Edit 가능/불가 분기 (CSV not imported badge 클릭 권한 등).
- Mapping snapshot 직접 저장 UI (Snapshot 메뉴는 별도).
- `tableBindingEdits` / `rowEdits` 의 백엔드 API 동기화.
