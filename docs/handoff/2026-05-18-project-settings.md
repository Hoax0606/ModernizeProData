# 2026-05-18 — project-settings (오현호)

## 한 일
- `ModernizeProData/frontend/src/pages/SettingsPage.tsx` 를 프로토타입 `Prototype/src/projectsettings.jsx` 의 6-section 구조로 재작성. 좌측 sub-nav (220px) + 우측 컨텐츠. 섹션: General · AS-IS · TO-BE · Schedule · Notifications · Danger zone.
- **General + Danger zone** 만 백엔드 연결 — `PATCH /api/v1/projects/{id}` 로 이름·phase 변경, `DELETE` 로 삭제, duplicate 는 `createProject` + DDL 복사.
- AS-IS / TO-BE 의 **DDL 카드** 는 기존 `addDdlFiles` / `removeDdlFile` store action 그대로 사용해 동작.
- 나머지 카드 (AS-IS CSV·Staging, TO-BE Connection·Credentials, Schedule 전체, Notifications 전체) 는 **mock state 로 UI 만**. 각각에 amber `UI only` 배지를 붙여 표시했다.

## 다음 사람이 할 일

가장 큰 다음 단계는 백엔드 모델 확장이다. UI 가 mock 인 이유는 `Project` 엔티티에 해당 jsonb 필드가 없기 때문.

1. `ModernizeProData/backend/src/main/java/com/ksinfo/modernize_pro_data/coordinator/site/Project.java` 에 jsonb 필드 추가:
   - `connection` (TO-BE host/db/schema/encoding/collation/ssl)
   - `credentials` (username/authMethod/passwordSet/lastRotated — 비밀번호 **값은 저장 X**, 별도 vault 흐름은 추후)
   - `schedule` (nightlyRehearsal · startTime · maxDuration · cutoverWindow)
   - `notifications` (event subscriptions · scope · retention)
   - `csvSource` (filename · arrivedAt · encoding · delimiter · parseStatus 등)
   - `staging` (store path · sizeBytes · tables · loadedAt · schemaMatch)
2. Flyway 마이그레이션 — 다음 번호는 **V7**. 예: `V7__project_extra_fields.sql`. 기존 V4/V5/V6 패턴 따르기.
3. `ProjectController.UpdateProjectRequest` 에 위 필드들 추가, `Project.set*` 메서드 호출 추가.
4. SettingsPage.tsx 의 mock state 를 store/api 호출로 교체. amber `UI only` 배지 떼기.

## 함정 / 결정 이력

- **workspace store 의 10초 polling 이 SettingsPage 에서는 pause 안 됨**. `AppShell.tsx` 의 `isEditing` 변수는 **모달만** 감지 (createSite / createProject / siteSettings). SettingsPage 는 모달이 아닌 라우트라 polling 이 사용자 입력을 덮어쓸 위험. 현재 회피책: General 의 이름 저장 후 명시적으로 `fetchProjects` 를 호출해 동기화. 본격적으로 잡으려면 `isEditing` 에 라우트 기반 조건도 넣어야 함.
- **DDL 카드는 AS-IS / TO-BE 가 같은 `project.ddlFiles` 컬렉션을 공유**한다. 백엔드 모델이 단일 `ddl_files` jsonb 라서. 사이드 구분이 필요해지면 `{ side: 'asis' | 'tobe', ... }` 같은 필드를 객체에 추가해야 함.
- **i18n ja/en 분기는 의도적으로 안 했음** — desc/hint 가 한국어 inline 으로 들어가 있다. 새 키 수십 개를 한 번에 만들면 ko.ts/ja.ts/en.ts 모두 비대해져 리뷰가 어려워서. 후속 PR 에서 일괄 마이그레이션 권장.
- **Phase 변경 select** 는 General 섹션에 그대로 두었다 — "dev/test only" 라벨로. PoC 검증 끝나면 제거.

## 안 한 것 (의도적으로)
- 백엔드 모델 확장 (위 1-3 항목). 이번 PR 범위 밖.
- i18n ko/ja/en 분기 (위 함정 참고).
- SiteOverview row 클릭 흐름 변경. 현재 `/` (ProjectDashboard) 로 가는데, "Workspace → Settings 바로 진입" 으로 바꾸는 옵션도 있었으나 보수적으로 유지. Settings 진입은 탭바의 "Project Settings" 클릭으로.
