# 2026-05-24 — artifacts-rework (Bae Seongmin)

## 한 일

- **MAPPING Diff 단순화** — `ASIS / TOBE / Rules` 시트 제거하고 `Diff + Summary` 만 유지. `Diff` 에 `Table` 컬럼 추가 (Status ↔ ASIS column 사이). 상단 `+1 added / -1 removed` 칩 배너 삭제.
- **DDL Scripts UI 를 VS Code 스타일로 교체** — 다크 타이틀바(File/Edit/...) + 탭 바에 파일 탭 + `Copy / Download` 버튼 같은 줄, 파란 status bar. Copy 직후 우상단 `✓ 복사되었습니다` 토스트 (1.6 s 자동 사라짐).
- **DDL Scripts 를 프로젝트 단위 단일 산출물로 통합** — 사이드바에 테이블 7 개 늘어놓던 걸 `{projectslug}.ddl.sql` 하나로. AS-IS / TO-BE 탭은 모든 테이블 DDL 을 `-- ─────` 구분자로 이어붙여 보여줌. `CHILD_TABLES` 상수를 `childTablesFor(projectName)` 으로 동적화하고 `ArtifactTree` prop 으로 전달.
- **진짜 xlsx 다운로드** (이전 CSV-mock 대체) — `downloadWorkbookAsXlsx()` 가 ExcelJS 로 in-app preview 와 동일한 두 줄 헤더(컬럼명 짙은 녹색 굵게 / 타입 회색), Status·Verdict·Diff 배지 색, 행 tint, `→ renamed` 라벨 prefix, frozen header pane, Calibri 폰트 강제 적용.

## 다음 사람이 할 일

- `MOCK_TABLES` / `DDL_SCRIPTS` / `MOCK_ROWS_BY_TABLE` / `MOCK_FORMULA_CTX` 를 백엔드 응답 wiring 으로 교체. 자리만 갈아끼우면 chrome 은 그대로 동작.
- DDL 카테고리 fx 수식바 `{table}` placeholder 가 이제 `projectSlug` 로 채워져 어색하면 `SUMMARY_PLACEHOLDER.ddl` 템플릿 수정.
- `Diff` 시트 fx 수식바의 `{ASIS} / {TOBE}` 카운트는 아직 `SCHEMA_DIFF_META` 의 per-table 값 사용 — 백엔드 wiring 시 같이 갈음.

## 함정 / 결정 이력

- **ExcelJS 3.10 browser 번들의 `writeBuffer()` 가 Node-Buffer 폴리필을 돌려준다.** 그대로 `new Blob([buf])` 하면 환경에 따라 `Buffer.toString()` 으로 직렬화돼 ZIP 헤더가 깨지고 Excel 이 "파일 형식이 올바르지 않음" 으로 거부함. 해결: `ArrayBuffer.isView(buf) ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf` 로 raw ArrayBuffer 잘라낸 뒤 Blob 에 전달.
- **Calibri 의 600 weight 는 Semibold 변형이라 다른 셀과 글자가 다르게 보인다.** 배지 스타일에 `fontWeight` 를 두면 안 됨. xlsx 쪽은 마지막에 `ws.eachCell` 로 `font.name='Calibri'` 만 강제 적용 (다른 속성은 보존).
- **VS Code chrome 의 가운데 파일명이 좌측 메뉴와 겹친다** (absolute position 충돌). 파일명은 탭에 이미 나오므로 가운데 텍스트 자체를 제거하는 게 가장 단순한 답이었음.
- **Confidence 컬럼을 한 번 넣었다가 뺐다.** 의미 있는 데이터가 아직 없어 노이즈로 판단 — 관련 코드/데이터 모두 정리됨.

## 안 한 것 (의도적으로)

- 백엔드 wiring — Artifacts 전체가 client-side mock. 백엔드 export job 미구현 상태 유지.
- ExcelJS 업그레이드 — `siteExportManifest.ts` 도 동일 버전 사용 중이라 함께 손대야 해서 보류.
- DDL Scripts 다국어 — 토스트 `복사되었습니다` 는 ko 하드코딩. 현장 운영팀 화면이 아니라 본사 개발자용이라 i18n 필요성 낮음.
