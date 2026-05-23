# 2026-05-22 — quarantine-pages-rework (ks-infosys)

## 한 일

- **SiteQuarantinePage 신규** (All projects Quarantine). `quarantineMock.ts`
  에 데이터 + helper 모음. LogViewer Quarantine 의 mock 과 **완전 분리**
  (`buildSiteQuarantineBase` 별도). per-project run 결과 ↔ 사이트 통합 run
  결과는 의미상 다른 이벤트라 mock 도 분리.
- **표 컬럼 재구성**: pk/violated/context 모두 제거.
  - LogViewer: `TABLE_NAME | AS-IS | TO-BE`
  - SiteQuarantine: `PROJECT_NAME | TABLE_NAME | AS-IS | TO-BE`
- **AS-IS / TO-BE 도입** — data-driven.
  - AS-IS: `quarantineRowAsIs(g, ri)` = violated 컬럼의 raw 값.
  - TO-BE: `quarantineRowToBe(g, ri)` = `g.toBeValues[ri]` (룰 엔진 transform
    시도 결과). 대부분 `null` (rejected), length 는 truncated 문자열,
    encoding fallback 은 `U+FFFD` 대체 문자열.
- **humanizeQuarantineDetail** — `g.stage` / `g.detail` / `g.columnRoles`
  에서 사람말 한 줄 자동 도출. 하드코딩된 group 별 문구 없음.
- **i18n 키 묶음 추가**: `logs.quarantine.col*`, `tobe.*`, `human.*`,
  `role.*` (ko/ja/en). CLAUDE.md 정책대로 컬럼 헤더는 영문 통일, 설명/제약
  문장만 언어별 번역.
- **UX 정리**: 카드 chevron 만 토글 (전체 클릭 비활성), violated 셀 severity
  색 + 굵기, NULL 배지의 의미 색 분리 (AS-IS NULL=빨강, TO-BE NULL=중립
  회색), "이 테이블만 다시 이행" 버튼 제거 + "매핑 열기" 를 primary 초록
  자리로 이동.

## 다음 사람이 할 일

- BE `/api/v1/runs/{runId}/quarantine` · `/api/v1/sites/{siteId}/quarantine`
  응답을 `QuarantineGroup` shape 으로. 특히 `toBeValues` 는 룰 엔진의 실제
  transform 출력으로 채워서 내려줘야 화면이 그대로 동작.
- 지원 stage: `validate.fk / notnull / unique / range / type / length /
  lookup`, `verify.checksum`, `encode`. 새 stage 가 추가되면
  `humanizeQuarantineDetail` switch 와 `logs.quarantine.human.*` /
  `tobe.*` 키 보완.
- "Re-run table" 정책 재검토. ONBOARDING §6 의 cross-table invariant /
  FK violation 류는 부모 테이블부터 다시 실행해야 의미가 있음. 버튼을 다시
  넣을 때는 group 별 `rerunScope` (table / parent_chain / full_run) 같은
  필드로 분기.

## 함정 / 결정 이력

- **TO-BE 의 의미** — 사용자와 합의: "값" 이 아니라 "transform 시도
  결과". rejected 가 대부분이라 NULL 셀이 많아 보이지만 그게 사실. EXPECTED
  같은 이름이 더 정확하지만 운영자 친숙성을 위해 TO-BE 유지.
- **두 화면 mock 분리** — 사용자가 명시 요구. "Log viewer 의 quarantine 과
  All projects 의 quarantine 이 연결되면 안 된다" → SiteQuarantine 은 자체
  base 데이터 (sg1–sg6, 다른 reason/table 세트), 프로젝트들에 round-robin
  배정.
- **하드코딩 금지** — 한 차례 humanDetail 을 group 마다 한국어 문구로 박았다가
  사용자가 "BE 데이터 들어오면 의미 없다" 로 reject → 모두 되돌리고
  data-driven helper 로 재작성.

## 안 한 것 (의도적으로)

- BE 연결 — 전부 mock. swap 포인트는 두 페이지 상단 주석에 명시.
- `quarantineToBeConstraint` (group-level 제약 문장 helper) — 더 이상 호출
  안 되지만 함수는 남겨둠. 다음 정리 때 제거 가능.
