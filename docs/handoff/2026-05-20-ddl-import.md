# 2026-05-20 — ddl-import (onda)

## 한 일
- 이번 세션의 핵심 산출은 문서 정비. 코드 본체 (AS-IS / TO-BE DDL 인포트) 는 이전 커밋 `7c37d30` 에 이미 포함됨.
- `docs/ONBOARDING.ja.md` 삭제. 한·일 두 벌 동기화 비용을 끊고 다국적 팀 공통어로 영어 채택.
- `docs/ONBOARDING.md` 를 영문 완전판으로 재작성. 기존 한국어판은 §2.4 / §3 / §4.1-4.2 / §7 후반 / §8 / §9 표 일부가 TODO 로 누락 → `ja.md` (완전판) 를 base 로 영역.
- §15 신설: 이번 PR 의 DDL 인포트 상세 — V7 / V9, `OracleDdlParser`, `DdlImportService`, `DdlImportButton` / `DdlSchemaPanel`, AppShell 램프, i18n 키.
- `CLAUDE.md` 갱신: ONBOARDING.md 위치 명시, `coordinator/ddl/` 패키지 언급, Flyway 번호 충돌 주의 한 줄 추가, 세션 시작 동작에 ONBOARDING.md 읽기를 끼움.

## 다음 사람이 할 일
- 본 handoff 와 함께 `CLAUDE.md` + `docs/ONBOARDING.md` (그리고 이 노트 자체) 를 한 커밋으로 묶어 PR 마무리.
- ONBOARDING.md §15.8 의 "Out of scope" 가운데 ProjectDashboard 의 TO-BE 테이블 일람은 별 브랜치에서 진행하기로 합의됨.
- §14 미결 항목 중 **PG 버전 (16 vs 18) 불일치** 정리.

## 함정 / 결정 이력
- DDL 인포트 본체 커밋 `7c37d30` 이후 `dev` 머지 (`953c5ed`) 가 들어와 `docs/ONBOARDING.md` 가 다시 untracked 로 돌아왔음. 이번에 영문판으로 다시 채움.
- Flyway V8 은 다른 멤버 브랜치에서 선점 → 이번 PR 은 V7 + V9 로 점프. 동일 사고 방지 위해 `CLAUDE.md` 의 마이그레이션 절에도 명시.
- `AsisSchemaModal.tsx` 는 미배선 dead code 라 삭제 (실제 viewer 가 필요해진 시점에 다시 작성).

## 안 한 것 (의도적으로)
- ProjectDashboard 의 TO-BE 테이블 일람 표시 (사용자 요청으로 별 브랜치 예정).
- `docs/DESIGN.md` 및 `docs/handoff/README.md` 의 outdated 내용 정정 — ONBOARDING.md 가 우선이라는 명시만 추가.
