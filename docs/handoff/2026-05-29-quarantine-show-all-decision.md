# 2026-05-29 — quarantine sample 전수 표시 결정 (팀장 지시)

이 문서는 LogViewer / SiteQuarantine 카드에 위반 row 를 "5 sample → 전체" 표시로 바꾼 결정의 배경과 위험을 정리한다. 추후 운영 환경에서 문제가 생기거나 정책 재검토 시 참조.

## 결정 (TL;DR)

- **변경**: `AuditStage.SAMPLE_LIMIT = 5` → 사실상 전수 (`Integer.MAX_VALUE`).
- **표시**: LogViewer 의 quarantine 카드 표가 위반 row **전부** 표시.
- **사유**: 팀장 지시 — "전부 화면에 보여줘".
- **적용 시점**: 2026-05-29.

## 배경 — 왜 원래 5 였나

도구 설계 단계에서 quarantine 데이터를 **두 layer 로 분리**:

| Layer | 무엇 | 용도 |
|---|---|---|
| 메타 DB `quarantine_entries.sample_data` JSONB | sample 5 행 + 그룹 요약 | UI 빠른 표시 |
| 디스크 `{output}/quarantine/{table}.parquet` | 위반 row 전수 | 외부 분석 / 다운로드 |

"카드 = thumbnail, parquet = 원본" 패턴. UI 빠르게, 분석은 외부 도구.

## 전수 표시로 바꿨을 때 생기는 위험

### 1) 메타 DB JSONB 폭주
- 위반 1만 행 × 20 컬럼 ≈ 10 MB / 그룹.
- run 한 번에 그룹 100 개 → 1 GB / `quarantine_entries` row.
- 매일 run × 30일 → 30 GB 메타 DB 증가.
- PostgreSQL JSONB hard limit 1 GB / value 도 위협.

### 2) Network transfer
- `GET /api/v1/runs/{runId}/quarantine` 응답 크기:
  - 5 sample: ~50 KB
  - 1,000 row: ~10 MB
  - 100,000 row: ~1 GB
- 폐쇄망 / 모바일 / 느린 회선에서 페이지 새로고침마다 수십 초 ~ 분.

### 3) Browser freeze
- React 가 표에 100만 row 렌더링 → DOM 폭주, 메인 thread 수십 초 freeze.
- 가상 스크롤 (`@tanstack/react-virtual`) 안 쓰면 사실상 사용 불가.

### 4) 메타 DB 책임 분리 깨짐
- 메타 DB = 운영 메타데이터용 (사이트 / 프로젝트 / 실행 이력 요약).
- 위반 데이터 전체 = 데이터 layer (DuckDB / parquet 의 영역).
- 메타 DB 가 데이터 layer 잠식 → 다른 query 도 느려짐.

### 5) 백업 / 복구 부담
- pg_dump 가 30 GB 메타 DB → 매일 백업 시간 폭발.
- PostgreSQL TOAST table 의 큰 JSONB → VACUUM 비용 증가.

### 6) UI 인사이트 손실 (역설)
- 100만 행 표에서 패턴 발견 어려움 — 필터 / 정렬 / aggregation 없음.
- 사용자가 "전체" 본다고 더 잘 분석하는 게 아님.

## PoC1 시점의 평가

| 환경 | 위험도 | 비고 |
|---|---|---|
| **PoC1 BANKSYS 데모 (7 row)** | 🟢 무관 | 데이터 작아서 모든 위험 nominal |
| **PoC1 1차 review** | 🟢 OK | 시연 데이터만 사용, 운영 데이터 없음 |
| **본운영 (위반 1만 ~ 100만 행)** | 🔴 위험 | 6 가지 영역 모두 영향 |

→ **PoC1 데모엔 문제 없음**. 본운영 진입 전에 재검토 필요.

## 구현

### BE — `AuditStage.SAMPLE_LIMIT`

```java
// AuditStage.java
private static final int SAMPLE_LIMIT = Integer.MAX_VALUE;
// 이전: 5 (UI thumbnail 용).
// 2026-05-29: 팀장 지시로 전수 표시.
// 위험은 docs/handoff/2026-05-29-quarantine-show-all-decision.md 참조.
```

`fetchSamples` 의 `LIMIT` 절이 `LIMIT Integer.MAX_VALUE` 가 됨 — 사실상 전수.

### FE — 변경 불필요

LogViewerPage / SiteQuarantinePage 의 `g.sampleRows.map(...)` 가 BE 가 보낸 만큼 그대로 렌더. SAMPLE_LIMIT 만 늘리면 자동으로 전부 표시.

## 본운영 진입 전 권장 조치 (PoC2)

### 옵션 A — Sample DB + parquet streaming UI (가장 안전)
- DB 에는 5 sample 유지 (현재 상태).
- "전체 보기" 버튼 → BE 가 parquet 파일을 stream 으로 응답 → FE 가 가상 스크롤 + 페이지네이션 으로 렌더.
- 작업량 ~2-3일.
- 메타 DB 부담 0, browser freeze 0.

### 옵션 B — Sample DB + 별도 분석 화면
- DB 5 sample 유지, "분석" 버튼 → parquet 다운로드 (이미 구현됨, `/api/v1/runs/{runId}/quarantine/{bindingId}/download`).
- 사용자가 외부 도구 (DuckDB / pandas / Excel Power Query) 로 분석.
- 작업량 0 (이미 구현 완료).
- UI 안에서 보는 행 수에 제한.

### 옵션 C — 현재 결정 유지 + cap 추가
- DB 에 전수 저장하되 cap (예: 10,000) 으로 메타 DB 폭주 방어.
- 10,000 초과는 다운로드 안내.
- 작업량 ~10분.
- 절충안.

## 변경 영향 받는 파일

- `backend/.../coordinator/worker/stages/AuditStage.java` — SAMPLE_LIMIT 상수.
- `docs/handoff/2026-05-29-quarantine-show-all-decision.md` — 이 문서.

## Q&A 요약 (배경 대화)

### Q: 위반 row 가 PG 에 안 들어가는 게 메타 DB 도 따로 저장하고 있는 거 아닌가?
**A**: 양쪽이 다른 걸 저장. 메타 DB = 5 sample 요약 + 그룹 메타 (UI 표시용). 디스크 parquet = 위반 row 전수 + 전 컬럼 (분석용). "thumbnail + 원본" 패턴.

### Q: 왜 parquet 포맷인가?
**A**: 1) 압축률 (CSV 의 5-10 배 작음), 2) 컬럼 타입 정보 자동 보존, 3) 분석 도구 (DuckDB / pandas / PySpark / Excel Power Query) native, 4) 도구 내부의 다른 sub-dir (parquet1, parquet2) 와 포맷 통일.

### Q: LogViewer 도 5 sample 만 보여주나?
**A**: 네. 카드의 row_count 배지는 전체 수 (예: "7 ROWS"), 표는 5 행만. 전체 = parquet 다운로드.

### Q: 전부 보여주면 어떤 문제?
**A**: 위 "전수 표시로 바꿨을 때 생기는 위험" 6 가지 (DB 폭주 / Network / Browser freeze / 책임 분리 / 백업 부담 / UI 인사이트 손실).

### 결정
팀장 지시로 PoC1 데모 환경엔 위험 nominal 이므로 전부 표시 적용. 본운영 진입 전 옵션 A/B/C 중 재검토.

## 안 한 것 (의도적으로)
- DB JSONB cap 추가 — 팀장 지시가 "전부" 라 cap 도입은 별도 결정.
- FE 가상 스크롤 도입 — 데모 데이터 작아서 불필요. 본운영 시 같이 검토.
- parquet streaming endpoint — 옵션 A 의 본격 구현. PoC2.

## How to apply
- BANKSYS 시연: 위험 없음, 정상 작동.
- 다른 사이트 / 운영 환경 전환 시 이 문서 다시 확인 + 옵션 A/B/C 결정.
