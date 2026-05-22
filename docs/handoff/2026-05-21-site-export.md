# 2026-05-21 — site-export (Im Jiyeong)

## What was done

오늘 작업은 **All projects 페이지의 "Site export" 탭** 을 placeholder 에서
실제 다운로드 가능한 형태로 구현한 것이 핵심. 회의용 시연 데이터 / mockup 페이지
같은 과정을 거쳤다가 모두 제거하고 최종적으로 **정직한 PoC 산출물 형태**로
수렴함.

### 새로 만든 파일

- `frontend/src/components/SiteExportPicker.tsx` — 좌측 300px picker (artifact
  format 체크박스 4 개 + Download bundle CTA).
- `frontend/src/components/SiteExportPreview.tsx` — 우측 preview pane (Site
  summary / Manifest 2 탭). Excel-style chrome 은 ArtifactsPage 와 1:1 동일 톤.
- `frontend/src/lib/siteExportManifest.ts` — manifest 빌드 + JSZip + ExcelJS
  로 client-side zip 생성. Site summary 워크북 빌더, Mapping/Validation 빈
  워크북 빌더.

### 기존 파일 수정

- `frontend/src/pages/SiteExportPage.tsx` — placeholder → picker + preview
  grid 레이아웃. 사이트 selected 시 `/site/export` 라우트 진입점.
- `frontend/src/pages/ArtifactsPage.tsx` — 우측 상단 "Export all" 작은 버튼
  제거. 사이드바 좌측 하단에 disabled "Download bundle" CTA 추가 (site export 와
  동일 톤). 라벨에서 size 표시는 제외.
- `frontend/src/i18n/{ko,ja,en}.ts` — `siteExport.*` 키 다수 추가/정리, 죽은
  키 (`exportAll`, `notImpl`, `placeholderNotice`, `tarGzNotice`, `bundle`,
  `templates.*`, `ddl.*`, `pipeline.*`, `dataDict.*`) 정리.

### 새 의존성

- `jszip ^3.10.1` — client-side zip 조립.
- `exceljs ^4.4.0` — `.xlsx` 워크북 생성. `xlsx` (SheetJS) 는 CVE 두 개 있어서
  exceljs 로 선택.

### 최종 picker 구조 (4 카테고리)

- **Artifact formats**: Migration (.sql) / Mapping (.xlsx) / Validation (.xlsx)
- **Documents**: Site summary (.xlsx)

원래 DDL · Pipeline 도 있었으나 회의 결정으로 제거 — DDL 은 고객사가 이미
제공한 입력과 중복, Pipeline 은 내부 runtime 설정이라 deliverable 부적합.

### zip 구조

```
site-export-<site>-YYYY-MM-DD-HHmm.zip
└── site-export-<site>-YYYY-MM-DD-HHmm/        (zip 파일명 stem 과 일치)
    ├── <project>/
    │   ├── migration/tbl_NNN.up.sql           (4-line stub, "TODO" 명시)
    │   ├── mapping/tbl_NNN.map.xlsx           (1-sheet 빈 Cover + "Not yet populated" 안내)
    │   └── validation/tbl_NNN.report.xlsx     (동일)
    └── site-summary.xlsx                       (진짜 워크북 — 워크스페이스 실데이터)
```

- 파일명·폴더명 모두 한글/일본어 보존 (`pathSafeName` 헬퍼).
- zip 파일명 stem 과 내부 최상위 폴더명 일치 (여러 zip 동시 풀어도 충돌 0).

### Site summary 워크북 (현재 유일하게 진짜 데이터로 동작)

- 시트: **Cover / Phase mix / All tables / 각 프로젝트**.
- Cover 의 KV: Document ID (`SS-...`) / Issued / Author 3 줄 + Scope 문장 + KPI
  한 줄 (project / table / column / done 카운트).
- 데이터원: `useWorkspaceStore` + `tobeDdlApi.get(projectId)` 의 `DdlSchema`
  (SiteOverview 와 동일 패턴).

## What the next person should do

내일부터 **백엔드 wiring 시작 예정**. 다음 순서로 진행 권장:

### 1. 백엔드 / 프론트 JSON shape 합의 (30 분, 백엔드 작업 시작 전)

```ts
// Mapping
{ tableName: string;
  rules: Array<{ sourceCol; sourceType; targetCol; targetType; ruleExpr; status: 'auto'|'lookup'|'custom'; note }>;
}

// Validation
{ tableName: string;
  checks: Array<{ check; scope; expected; actual; delta; verdict: 'PASS'|'WARN'|'FAIL'; note }>;
}

// Migration
{ tableName: string;
  blocks: Array<{ kind: 'CREATE_TABLE'|'INDEX'|'FK'|'SEQUENCE'|'GRANT'; sql }>;
}
```

위 shape 가 합의되어야 프론트 빌더를 정확히 짤 수 있음.

### 2. 빌더 3 개 신규 작성 (4–6 시간)

`lib/siteExportManifest.ts` 안에 — 현재의 `buildEmptyArtifactWorkbook`
패턴을 참고:

- `buildMigrationSql(args, data)` → 풀 SQL 묶음 (CREATE/INDEX/FK/SEQUENCE/GRANT).
- `buildMappingWorkbook(args, data)` → Cover + Rules 2 시트.
- `buildValidationWorkbook(args, data)` → Cover + Checks 2 시트 (verdict 컬럼
  색상 강조).

`generateZipBundle` 의 분기에서 데이터가 있으면 위 빌더 호출, 없으면 현재
`buildEmptyArtifactWorkbook` 폴백 — 백엔드 부분 wiring 상태에서도 깨지지 않게.

### 3. SiteExportPage 의 데이터 로딩 추가

- 프로젝트별 mapping rules / validation checks / migration blocks 를 API 또는
  zustand store 에서 가져오는 useEffect 추가.
- `generateZipBundle({ ..., perProjectData })` 형태로 전달.

### 4. Artifacts 페이지 download wiring (1–2 일)

- 사이드바 하단 disabled "Download bundle" 활성화.
- 프로젝트 scope 의 zip 생성 — site export 의 `generateZipBundle` 호출하되
  단일 프로젝트 only 로 manifest 필터.
- 우측 워크북 뷰어 본문 채우기 (현재는 chrome 만 있음, EmptyExcelWorkbook).
  카테고리별 (Dashboard / Diff / DDL / SQL / Mapping / Validation) 데이터
  렌더링.

## Pitfalls / decision history

### "가짜 데이터" 정책

오늘 여러 차례 fake-data 빌더를 만들었다 → 회의용 시연 → 삭제 했다. **현재
코드에는 어떤 fake/sample row 도 없음** (Site summary 의 Author/KS Info System
같은 회사명만 정직한 하드코딩으로 남음). 이후 작업에서 "보여주기용" 데이터를
박지 말 것. 만약 시연이 필요하면 백엔드 실데이터 또는 별도 demo 분기로.

### Cover 메타에서 Version / Classification 제거

`v1.0.0`, `Internal · Migration program` 등은 실제 출처 없는 하드코딩이라
삭제. Cover 의 KV 는 **실제 데이터원이 있는 항목만** (Document ID / Issued /
Author). 백엔드 wiring 시 Version 을 mapping_snapshot.version 으로 채우는 등
실제 값으로 추가 가능.

### Manifest 의 size 표시 삭제

이전에 `rand()` 로 만들던 가짜 size 값이 picker / Manifest 탭에 나왔는데 실제
zip 안 파일 크기와 무관했음. 사용자가 "5.2 MB" 보고 받았는데 실제 80 KB 식의
mismatch 가 있어 size 표시 자체를 제거. 진짜 byte 단위가 필요하면 `blob.size`
로 download 후 OS 파일 탐색기에서 확인.

### 폴더명 / 한글 이슈

`slugify` (ASCII-only) 와 `pathSafeName` (Unicode preserve, FS-forbidden chars
만 `_`) 두 헬퍼를 구분해서 export. 폴더명·zip 파일명에는 **`pathSafeName`** 사용
(한글 프로젝트명 보존). Document ID 같은 ASCII slug 용도엔 `slugify`.

### Excel chrome 일관성

ArtifactsPage 와 SiteExportPreview 의 Excel-style 워크북 chrome (title bar /
ribbon / formula bar / sheet tabs) 은 시각적으로 동일. 색·폰트·spacing 모두
한 톤. 추후 수정 시 둘을 같이 맞춰야 함.

### `/mockup` 라우트 / Templates catalogue / artifactSamples

회의 시연을 위해 standalone `/mockup` 라우트와 `lib/artifactSamples.ts` (샘플
mapping/validation 데이터) 와 `buildArtifactTemplatesWorkbook` 빌더를 만들었
다가 사용자 요청으로 **전부 삭제**. 다시 만들지 말 것. 시연이 필요하면 백엔드
실데이터 흐름으로 진입.

## Intentionally not done

- **Mapping / Validation / Migration 빌더의 실데이터 채움** — 백엔드 mapping
  snapshot · validation results · migration SQL 데이터원이 와야 함. 현재는 빈
  Cover 워크북 + "Not yet populated" 안내문만.
- **Artifacts 페이지의 다운로드 동작** — 좌측 하단 "Download bundle" 은
  disabled (`title={t('artifacts.empty.hint')}`). 산출물 데이터가 들어오면
  enable.
- **Backend Apache POI export job** — `/api/v1/sites/{id}/export` 엔드포인트
  미구현. 현재는 100% client-side (JSZip + ExcelJS) 로 zip 조립.
- **서명 / sha256 / audit log 기록** — picker footer 의 "signed · sha256 + pgp"
  표기는 이미 제거. 백엔드 export job 시점에 함께 도입.
- **tar.gz 번들 옵션** — 토글 자체 제거. 항상 zip.
- **Site summary 외 카테고리의 in-app preview** — Manifest 탭은 파일 목록만
  보여주고 본문 inline preview 는 없음. 필요 시 후속 차수.
