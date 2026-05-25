# 2026-05-22 — report-dbeaver-ui (Suhyun Jin)

이전 핸드오프 (`2026-05-22-mapping-test-and-report.md`) 직후의 추가 변경. Report 화면 디자인을 **Excel** 흉내에서 **DBeaver 데이터 뷰어**로 전면 교체.

## What was done

### 1) DBeaver UI prototype HTML 생성
`samples/dbeaver-ui-prototype.html` — 사용자가 검토할 수 있는 standalone HTML.
구조:

```
① 타이틀바       /mpd.png 로고 + {tableName} - Report + ─ ▢ ✕
② 메뉴바         File / Edit / Navigate / Search / SQL Editor / Database / Window / Help
③ 툴바          아이콘 + Auto ▾ / {TOBE_DIALECT} ▾ / {schema}@{db} ▾
④ 탭바           프로젝트의 모든 TO-BE 테이블 (allTables) — active 탭만 흰배경+그린 underline+✕
⑤ 서브탭        Properties / Data(active) / Diagram
⑥ 필터바        Show SQL + "이 데이터는 DB에 저장되지 않습니다."
   데이터 그리드  행번호+컬럼헤더(type icon #2DBD96 + 이름 + ▾)+zebra(#F0FBF7)+NULL
   상태바       Refresh ▾ | Save | Cancel | ⏮◀▶⏭ | Export ▾ | row count | "N row(s) fetched - 0.0s, on … at …" | N
   브레드크럼   {DB icon} {dialect} - {site} ▸ {schema icon} {schema} ▸ {table icon} {tableName}
```

색상 톤 (사용자 명시 그대로):
| 부위 | 색 |
|---|---|
| 타이틀바 / 메뉴바 | `#FFFFFF` |
| 툴바 / 탭바 / 서브탭 / 상태바 / 브레드크럼 배경 | `#ECECEC` |
| 활성 탭 / 활성 Data 서브탭 | `#FFFFFF` + 하단 `#2DBD96` 2px |
| 필터바 | `#F5F5F5` |
| 컬럼 헤더 + 행번호 + corner | `#F0F0F0` (파란기 없음) |
| 컬럼 헤더 텍스트 | `#000000` |
| 컬럼 헤더 구분선 | `#CCCCCC` |
| 데이터 홀수 행 | `#FFFFFF` |
| 데이터 짝수 행 | `#F0FBF7` (연한 민트) |
| 컬럼 type 아이콘 / ▾ caret | `#2DBD96` (배경 없이 글자색만) |
| [NULL] | `#BBBBBB` italic |
| 숫자 우측 정렬 | `#000000` |
| 상태바 텍스트 | `#555555` |
| 브레드크럼 텍스트 | `#1A9E7A` (그린 진한 톤) |

### 2) Font Awesome 6.5 CDN
`frontend/index.html` 에 CDN `<link>` 추가:
```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
```
사용 아이콘:
- 탭바 / 브레드크럼 테이블 아이콘 → `fa-table` (`f0ce`)
- 브레드크럼 DB 아이콘 → `fa-database` (`f1c0`)
- 브레드크럼 schema 아이콘 → unicode `&#xf46d;` (folder-tree, FA6)
- mpd 로고는 `/mpd.png` (Vite public 기본 경로)

### 3) ReportView React 컴포넌트 교체
`MappingPage.tsx` 의 `ReportView` 를 Excel(`xl*` 스타일) → DBeaver(`dbv*` 스타일) 로 전면 교체.

데이터 wiring:
- `table.short` 또는 `table.name.split('.').pop()` → 활성 테이블명
- `dialectLabel(TOBE_DIALECT)` → 툴바 + 브레드크럼의 DB 종류 라벨
- `useWorkspaceStore.getState().getActiveSite()?.name` → 툴바 + 브레드크럼의 DB/site 이름 (없으면 `'modernize'` 폴백)
- `table.name.split('.')[0]` → schema 이름 (없으면 `'public'`)
- `TOBE_TABLES` 전체 → 탭바 모든 탭 렌더링, `internalName` 일치하는 것만 active
- `previewValue(row, rowIdx)` → 기존 결정적 해시 더미 데이터 그대로

상호작용:
- **컬럼 헤더 클릭** → `onPickColumn(r.tgt)` → Inspector 열고 그 컬럼 active, Report 닫힘
- **타이틀바 ✕** → `onClose()` → Mapping 그리드로 복귀
- 다른 탭 클릭은 비활성 (디자인 only)
- 메뉴/툴바/서브탭/상태바 모두 디자인 only

새 헬퍼 함수:
- `typeIconLabel(t)` → type → 짧은 라벨 (UUID/ABC/123/1.2/TS/DT/T·F/BIN/{} 등)
- `isNumericType(t)` → 우측 정렬 판정
- `fmtDate(d)` / `fmtTime(d)` → 상태바 메시지

### 4) `mpd.png` samples 폴더에 복사
`samples/mpd.png` (74KB) — prototype HTML이 standalone 으로 동작하도록.

## What the next person should do

1. **DBeaver UI 의 디자인-only 영역 점진적 wiring** — 현재 메뉴/툴바/서브탭/탭바(다른 탭)/상태바 모두 클릭 동작 없음. 향후 다음 우선순위로:
   - 다른 탭 클릭 → 그 테이블의 Report 화면 (또는 Mapping Detail 복귀 후 그 테이블 자동 선택)
   - Export data → CSV/Excel 다운로드 (백엔드 API 필요)
   - Refresh → Test 재실행
2. **`xl*` / `report*` 스타일 정리** — `MappingPage.tsx` 의 옛 Excel 스타일 객체들이 그대로 남아있음. 다음 정리 commit 에서 제거 가능.
3. **`samples/excel-ui-prototype.html` 처리** — Report 디자인이 DBeaver 로 바뀌었으니 참조용으로만 남거나 삭제.

## Pitfalls / decision history

- **prototype HTML 먼저, React 포팅은 나중에** — Excel/DBeaver 모두 사용자가 명확히 정의된 외부 UI 였고, 색상/구조 검토 비용이 React 직행보다 훨씬 낮다. prototype 에서 사용자 피드백 받고 색만 다듬은 뒤 React 로 1:1 옮김.
- **Font Awesome CDN vs SVG** — CDN 1 회 로드면 모든 페이지에서 사용 가능, SVG 인라인은 코드량 폭증. PoC 단계라 CDN 채택. 폐쇄망 배포 시 폰트 파일을 self-host 로 교체.
- **`xl*` 스타일 유지** — 옛 Excel ReportView 가 컴파일 OK 상태로 남아 있어 한꺼번에 지우지 않음. 나중 정리.
- **schema 아이콘은 unicode 직접 (`&#xf46d;`)** — FA free 에 `fa-folder-tree` 클래스가 없을 수 있어 unicode escape 로 강제. FA 폰트만 로드되면 glyph 렌더.

## Intentionally not done

- **Mapping Detail 우회 직접 컬럼 편집** — 컬럼 헤더 클릭 → Mapping Detail 이동만. Report 안에서 직접 매핑 룰 편집은 PoC 2 차.
- **실제 변환 결과 데이터** — 여전히 `previewValue` 결정적 해시. 백엔드 mapping execution API 가 생기면 그 결과로 교체.
- **Excel 흉내 prototype (`samples/excel-ui-prototype.html`) 삭제** — Report 가 DBeaver 로 바뀐 후 무용지물이지만 history 참조용으로 남김.
