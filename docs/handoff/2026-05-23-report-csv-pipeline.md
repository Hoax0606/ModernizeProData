# 2026-05-23 — report-csv-pipeline (Suhyun Jin)

이전 핸드오프 (`2026-05-22-report-dbeaver-ui.md`) 의 DBeaver 데이터 뷰어 UI 위에, **실데이터를 흘려 넣는 파이프라인**을 붙임. 더미 값 → DuckDB 가 파싱한 CSV row → 매핑 규칙대로 변환된 TO-BE 값.

## What was done

### 1) AS-IS CSV 프리뷰 엔드포인트 (DuckDB)
`backend/.../coordinator/api/SiteCsvPreviewController.java` 신규.

```
GET /api/v1/sites/{siteId}/csv-preview/{tableName}?limit=50
→ { table, resolvedPath, headers[], rows[][], rowCount, truncated }
```

흐름:
1. `Site.csvPath` 조회·검증 (`blank` / `notDirectory` / path traversal 차단)
2. `{csvPath}/{tableName}.csv` 해석 — 정확매칭 실패하면 디렉터리 스캔해서 case-insensitive fallback
3. **DuckDB `read_csv_auto`** 호출:
   ```sql
   SELECT * FROM read_csv_auto(
       '{absPath}', header=true, sample_size=-1, all_varchar=true
   ) LIMIT {n+1}
   ```
   - `all_varchar=true` — 프리뷰는 타입 캐스팅 불필요, 모든 컬럼 문자열로
   - `sample_size=-1` — 전체 스캔으로 dialect 추론 (작은 파일이라 비용 무시)
   - `n+1` 조회로 `truncated` 플래그 산출
4. `ResultSetMetaData.getColumnLabel()` → headers 추출, `getString()` 로 row 직렬화

직접 짠 Java CSV 파서 (~80줄, PushbackReader 기반) 는 삭제. DuckDB 일임.

에러 코드: `SITE_NOT_FOUND`, `CSV_PATH_NOT_SET`, `CSV_PATH_NOT_DIRECTORY`, `INVALID_TABLE_NAME`, `CSV_FILE_NOT_FOUND`, `PATH_TRAVERSAL_DENIED`, `CSV_READ_FAILED`.

### 2) 네이티브 폴더 다이얼로그 엔드포인트
`backend/.../coordinator/api/FileDialogController.java` 신규.

```
POST /api/v1/util/pick-directory  body: { startPath?, title? }
→ { path: string | null, cancelled: boolean }
```

- **macOS**: `java.awt.FileDialog` + `apple.awt.fileDialogForDirectories=true` → 진짜 Cocoa 폴더 픽커
- **Windows/Linux**: `JFileChooser` + system L&F, `JFrame` 앵커로 always-on-top
- `SwingUtilities.invokeAndWait` 로 EDT 보장
- `GraphicsEnvironment.isHeadless()` 면 `HEADLESS_BACKEND` 에러 (프론트가 prompt 폴백)

**`ModernizeProDataApplication.main()` 에서 `app.setHeadless(false)`** — Spring Boot 기본값이 headless 라 안 끄면 AWT/Swing 못 띄움.

배포 모델 (jpackage 로 사용자 PC 에 같이 깔리는 Coordinator) 라서 백엔드에서 다이얼로그 띄워도 사용자 시점에서 자연스러움. 서버 배포 시엔 자동으로 prompt 폴백.

### 3) `CsvPathField` Browse 버그 수정
**기존 문제**: `showDirectoryPicker` / `<input webkitdirectory>` 는 브라우저 보안상 폴더의 마지막 세그먼트 (`csv`) 만 반환. 그걸 그대로 `onChange(handle.name)` 로 input 에 덮어쓰니까 메타DB 에 `csv` 만 저장됨.

**수정**: Browse 버튼이 `fileDialogApi.pickDirectory()` 호출 → 위 #2 엔드포인트 → 절대경로 반환. 백엔드 다이얼로그 실패 시 `window.prompt` 폴백.

새 프론트 파일: `src/api/fileDialog.ts`.

### 4) `ReportView` 가 실데이터를 표시
`MappingPage.tsx` 의 ReportView:

- `useTableCsv(siteId, tableShortName)` hook 추가 — `csvPreviewApi.forTable()` 호출, `{siteId}::{tableName}` 단위 캐시
- 셀 렌더는 `computeReportCell(r, i, csv, csvColIdx)` 가 결정:
  - `rule === 'unmapped'` → `''`
  - `rule === 'null'` → `'NULL'`
  - `rule === 'default'` / `'added'` → `r.ddlDefault`
  - `rule === 'auto'` / `'rule'` → CSV row 의 source 컬럼 값에 `applyTransform` 적용
- `applyTransform()` — 미니멀 변환:
  - empty + nullable → `NULL`
  - `Y/N/T/F/1/0` → `true/false` (target 이 BOOLEAN/BIT 일 때)
  - 나머지는 raw passthrough
- **더미 생성기 (`previewValue`, `hashStr`) 함수 자체를 삭제.** Report 는 "Test 결과 미리보기" 라 가짜 값이 보이는 게 오해의 소지.

새 프론트 파일: `src/api/csvPreview.ts`.

### 5) `savedSrc` 의 alias prefix 처리
Row editor 의 source 픽커는 `<option value="{src.alias}.{c.name}">` (예: `c.CUST_ID`) 로 값을 저장. CSV 헤더에는 alias 가 없으므로 (`CUST_ID`) 매칭 실패 → null.

해결:
```ts
const colName = r.src.includes('.') ? r.src.split('.').pop()! : r.src;
const idx = csvColIdx.get(colName.trim().toLowerCase());
```

또한 `reportRows` overlay 추가 — `visibleRows` 의 `r.src`(='—') 위에 사용자 `savedSrc[0]` 를 덮어씌워서 ReportView 에 전달.

### 6) 테이블 표시에서 schema prefix 제거
`qualifiedName(t)` 는 내부 식별자로 그대로 두되 (동명 테이블 충돌 방지), **표시만** `t.short` (= physicalName) 사용:

| 위치 | 이전 | 이후 |
|---|---|---|
| TO-BE / AS-IS context bar tableChip | `BANKSYS.CUSTOMERS` | `CUSTOMERS` |
| Table binding 드롭다운 option 라벨 | `BANKSYS.CUSTOMERS` | `CUSTOMERS` |
| Routing 패널 TO-BE 화살표 우측 | `BANKSYS.CUSTOMERS` | `CUSTOMERS` |

검색은 `matchQ(t.name)` 그대로라 qualified 부분도 매칭됨 (`banksys` 검색 가능).

### 7) UX 디테일
- Report 화면 동안 **Test 버튼 비활성** (`disabled={... || reportOpen}`, tooltip: `Close the Report to run Test again`)
- 상태바: 좌·우 끝 숫자만 떴던 두 자리 제거, 중앙 문구에 컬럼 수 추가 → `N column(s), M row(s) fetched - …`
- CSV row 가 PREVIEW_ROWS(=20) 보다 적으면 실제 row 수만 렌더 (이전엔 항상 20행)

## Files touched

### 신규 (backend)
- `coordinator/api/SiteCsvPreviewController.java`
- `coordinator/api/FileDialogController.java`

### 신규 (frontend)
- `src/api/csvPreview.ts`
- `src/api/fileDialog.ts`

### 수정 (backend)
- `ModernizeProDataApplication.java` — `setHeadless(false)`
- `mvnw` — chmod +x (실수로 실행권한 빠져있던 거 복구)

### 수정 (frontend)
- `src/pages/MappingPage.tsx` — ReportView CSV 연동, computeReportCell/applyTransform, reportRows overlay, alias prefix strip, schema prefix 표시 정리, Test 버튼 disable, 상태바
- `src/components/CsvPathField.tsx` — Browse → 백엔드 다이얼로그

## Open items / known limits

- **`applyTransform` 의 변환 규칙이 미니멀**: empty→NULL, Y/N→bool 두 가지만. 코드 맵 (`M→MALE`), 단위 환산 (만원→원), 정규식 분할 등 풍부한 변환은 `RowEdit.savedRule` 의 SQL expression 으로 적되, 현재는 평가기가 없음. 다음 단계로 DuckDB SQL 에 위임하는 게 자연스러움 (이미 CSV 도 DuckDB 가 읽고 있으므로 `SELECT {expressions...} FROM read_csv_auto(...)` 한 방으로 가능).
- **CSV 인코딩 고정**: 현재 UTF-8 전제. Shift-JIS 같은 일본 금융권 케이스는 `site.asisEncoding` 보고 `read_csv(..., encoding='shift_jis')` 로 분기 필요.
- **`csv` 디렉터리 캐시 무효화 없음**: 같은 (siteId, tableName) 두 번째 호출은 모듈 캐시에서 바로 반환. CSV 파일 갱신 시 reload 트리거 필요.
- **`limit` 고정**: 프론트가 `50` 고정. 추후 페이징 UI 붙으면 동적으로.
- **alias parsing 단순함**: `r.src.split('.').pop()` 는 컬럼명에 점이 들어있는 변종 (백틱 quoted 등) 에서 깨질 수 있음. 현재 DDL 파서가 그런 케이스를 만들지 않으므로 OK.

## Verification

수동 검증 (Mac, Chrome):
1. `/Users/{me}/Sample/csv/customers.csv` 같은 경로에 샘플 CSV 둠
2. Site Settings → Browse → Cocoa 폴더 픽커 떠서 절대경로 자동 입력 확인
3. AS-IS Oracle DDL · TO-BE PG DDL 임포트
4. Mapping 화면에서 컬럼별 source 픽 (`c.CUST_ID` 등 저장)
5. Report 클릭 → DBeaver UI 위에 실제 CSV 데이터가 매핑 규칙대로 표시됨 확인
6. Test 버튼 회색·비활성 (`Close the Report to run Test again` 툴팁) 확인

Network 탭에서 호출 확인:
- `POST /api/v1/util/pick-directory` 200, `{ path: "/Users/...", cancelled: false }`
- `GET /api/v1/sites/{id}/csv-preview/customers?limit=50` 200, `data.headers = ["CUST_ID", ...]`
