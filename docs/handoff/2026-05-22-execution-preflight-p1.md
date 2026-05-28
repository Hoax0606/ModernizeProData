# 2026-05-22 — execution-preflight-p1 (Jiyeong Im)

## 한 일
- `ExecutionPage` 신규 구현 (프로토타입 기반, Quarantine·Worker pool 제외)
- Pre-flight 메시지 다듬기 — 운영자 표현으로 (`DuckDB` → `AS-IS DB`, `import` → `등록`, `라우팅` → `매핑` 등)
- `RunHistory` 패널 삭제 — `AuditLogPage` 와 의미 중복
- **Pre-flight P1 재설계 완료**: `CheckStatus = pass | fail | skip`, 새 8개 체크 (`csv-arrived` / `ddl-asis` / `ddl-tobe` / `conn-tobe` / `tobe-bindings` / `asis-unmapped` / `unmapped-cols` / `approved-snapshot`), `TableSelector` 컴포넌트, "Pre-flight 검사" 버튼 + 600 ms 간격 시뮬레이션, `approved-snapshot` 은 ALL 선택 시만 검사·부분 선택 시 skip
- `RunHeader` 의 `canStart` 에 `preflightPassed` 게이팅 추가

## 다음 사람이 할 일
- **P2**: 백엔드 `POST /api/v1/projects/{id}/preflight/run` API + 각 체크 검증 로직
- **P3**: Fix 버튼 wiring + `MappingPage` 컬럼 pulse highlight (새 `fixTarget` store 필요)
- `ExecutionPage.tsx:578` `StartRunDialog` Confirm 버튼 백엔드 연동 (`/* backend wiring TBD */`)
- Abort 버튼 onClick wiring (`ExecutionPage.tsx:202`)

## 함정 / 결정 이력
- `snapshotApproved` 배열에 처음엔 `'sign-off'` 누락 → snapshot 체크가 sign-off 단계에서 warn 으로 잘못 분기됨. `ApprovalsPage.tsx:77-86` 주석 "Approve시 phase전환: mapping → sign-off" 가 진실. 수정 후 sign-off → pass 가 자연스러움
- `CheckStatus` 가 4상태 → 2상태 → 3상태로 변천. "snapshot 만 ALL 일 때 체크" 요구로 최종 3상태 안착
- `?demo=preflight` 는 테이블 선택·검사 트리거 없이 즉시 결과 표시 — 디자인 점검용 (4 pass + 3 fail + 1 skip)

## 안 한 것 (의도적으로)
- 백엔드 API 미연동 — `setTimeout` 으로 mock 시뮬레이션
- Fix 버튼 onClick 없음 — P3 에서 처리
- Quarantine / Worker pool 패널 — 초기 요구로 제외
