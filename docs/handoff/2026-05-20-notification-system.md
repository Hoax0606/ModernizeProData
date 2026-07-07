# 2026-05-20 — notification-system (Bae Seongmin)

Branch: `feature/notification-system`.

## What was done

전체 인앱 알림 시스템 구축 + 다수의 UI 리파인. `master` 와 다른 사용자 계정 (예: worker `aaaa`) 이 같은 브라우저에서 번갈아 쓰는 케이스, 그리고 Solution Settings ↔ Project Settings 간 cascade 동작이 핵심 동선.

### 새 파일
- `ModernizeProDataBridge/frontend/src/store/notifications.ts` — 알림 read/dismissed 상태. **username 별로 키 분리** (Record\<username, string[]\>) — 한 브라우저에서 다른 계정으로 로그인해도 read 상태가 섞이지 않음.
- `ModernizeProDataBridge/frontend/src/store/notificationPreferences.ts` — 프로젝트별 Event subscription 영속 저장. `actionToEventKey()` 로 audit log action 문자열 → event key 매핑.
- `ModernizeProDataBridge/frontend/src/components/NotificationToast.tsx` — 우측 하단 toast. 마운트 시점에 기존 audit log entries 를 'seen' 으로 잡고 그 이후 새 entry 에만 4초 짜리 토스트 발사. **`globalNotifEnabled=false` 동안 새로 쌓인 entries 도 'seen' 으로 마킹** — 다시 켰을 때 한꺼번에 토스트로 쏟아지지 않도록.

### 핵심 변경

- **알림 소스**: `AppShell.tsx` 의 `notifItems` 가 audit log 한 군데만 source. 과거 snapshot 의 pending 상태를 별도 항목으로 추가하던 부분 제거 (audit log 의 'Approval Requested' 와 중복).
- **알림 type 라벨/색**: `approval-req` → **`pending`** (`--amber` 황토), `new-snapshot` → **`snapshot`** (`--phase-analysis` 파랑), `approved` → `--green` (상세 페이지 배지와 동일), `rejected` → `--red`.
- **Cutover 배지**: action 에 'cutover' 포함되거나 audit log 의 `snapshotType==='cutover'` 면 알림 패널 + toast 에 빨간색 'Cutover snapshot' 배지.
- **알림 클릭 라우팅 (race 해결)**: notification 핸들러는 `setActiveProject` 직접 호출 안 하고 `navigate(url, { state: { activateProjectId } })` 로 위임. AppShell 의 `useLayoutEffect` 가 location.state 를 읽어 setActiveProject. 사이트-레벨 페이지 (`ApprovalsPage`, `AuditLogPage`, `ExecutionOverviewPage`, `SiteExportPage`) 의 redirect `useEffect` 는 제거. 대신 사이드바 프로젝트 클릭 핸들러에서 `/site/*` 경로일 때만 `/` 로 navigate.
- **알림 글로벌 활성/비활성**: Solution Settings → Enable notifications 토글. OFF 면 `notifItems = []`, toast 발사 안 함, PSNotify 의 Event subscription 토글 disabled.
- **Scope / Retention 글로벌 화**: 원래 per-project 였던 두 설정을 `useSettingsStore` 글로벌 필드 (`notificationScope`, `notificationRetention`) 로 이전. PSNotify 의 Recipient options 카드 삭제. SolutionSettingsModal 의 Notifications 카드 안에 두 행 추가.
  - Scope: 두 옵션 (mine-only / all-project) 의 `<select>` 드롭다운, hint 는 라벨 바로 밑에 `whiteSpace: 'nowrap'`.
  - Retention: 4개 옵션 (7일/30일/90일/OFF) 드롭다운, **master 만 수정 가능**.
- **Toast UX**: 우측 상단 X 닫기 버튼 — 클릭 시 그 토스트만 즉시 제거.
- **PSNotify draft/save 패턴**: 토글 변경이 즉시 store 에 반영되던 걸 로컬 draft state 로 바꾸고, **Save Changes 버튼이 실제로 작동** (isDirty 일 때만 enable, 클릭 시 store 에 commit + `projectSettings.action.savedToast` Toast).
- **PSNotify 정리**: UI ONLY 배지 (PSHead `mock` prop) 제거, 'In-app notification inbox' 안내 박스 제거, Recipient options 카드 제거. 이제 Event subscriptions 단일 카드만 남음.
- **VersionsPage snapshot 생성 폼 레이아웃**: Description 을 Name 밑으로 세로 스택, Submit/Cancel 버튼을 폼 헤더 우측으로. Description 은 `maxHeight: 160px + overflow: auto` — 길어지면 내부 스크롤.
- **Cutover snapshot 배지 줄바꿈 fix**: `VersionsPage.tsx` 의 `cutoverTag` 에 `whiteSpace: 'nowrap'` + `flexShrink: 0`. 왼쪽 좁은 컬럼에서 두 단어가 줄바꿈 되던 거 한 줄로.
- **i18n**: `notifications.empty.unread` (ko/en/ja), `projectSettings.action.savedToast` (3개) 키 추가. `notifications.empty.title` (ko) 만 'No notifications' → '알림이 없습니다.' 로. Solution settings desc 의 `(🔔)` 이모지 제거 (ko/ja).

### Audit log entry 확장

`AuditLogEntry` 에 `snapshotId?: string` + `snapshotType?: 'mapping'|'cutover'` 필드 추가. `ApprovalsPage` (handleApprove/Reject) 와 `VersionsPage` (handleCreate/Request) 의 모든 `addAuditLog` 호출에서 이 필드들 전달. 덕분에 알림 클릭 시 `navigate('/versions', { state: { selectSnapshotId } })` 로 정확한 snapshot 자동 선택.

## What the next person should do

1. **PR 올리기 전에 `npm run dev` 로 한 번 풀 테스트** — 특히 다음 시나리오:
   - master 와 비-master 계정 번갈아 로그인 → 알림 read 상태가 섞이지 않는지
   - Solution Settings 에서 Enable notifications OFF → 저장 → 알림 패널 / toast 둘 다 비는지
   - OFF 상태에서 새 audit log 발생 → 다시 ON 해도 그것들이 toast 로 안 뜨는지
   - PSNotify 에서 토글 변경 + Save → 저장 toast 뜨고 store 에 반영되는지
   - master 가 Approve → 알림 click → 해당 프로젝트의 Versions 탭 + 그 snapshot 자동 선택
   - 일반 사용자가 Request review → master 알림에서 click → `/site/approvals` 로 이동
2. **i18n 정리** — 다음 키들은 코드에서 더 이상 안 쓰임:
   - `projectSettings.notify.recipients.title`
   - `projectSettings.notify.recipients.desc`
   - `projectSettings.notify.inbox.title`
   - `projectSettings.notify.inbox.body`
   3개 언어 파일에서 안전하게 제거 가능.
3. **Retention 의 드롭다운 라벨 (`7일 / 30일 / 90일 / OFF`)** 이 현재 inline 으로 한국어 하드코딩. i18n 키로 빼주는 게 깔끔.
4. **이전 localStorage 데이터 호환**:
   - `modernize-notifications` 키는 구조가 바뀜 (`string[]` → `Record<username, string[]>`). 첫 로드 시 zustand persist 가 새 default 로 시작하므로 문제는 없지만, 사용자가 이전에 읽음 처리한 알림이 다시 unread 로 보임.
   - `modernize-notification-prefs` 의 per-project scope/retention 은 더 이상 참조 안 됨 (글로벌로 이동). 키는 남아있지만 dead code.
5. **백엔드 audit log 도입 시** — 현재 audit log 는 100% 프론트엔드 zustand store (`store/auditLog.ts`). 서버 audit_log 테이블이 들어오면 그 데이터를 zustand store 에 hydrate 하도록 fetch 로직만 바꾸면 됨. action 문자열 + snapshotType/snapshotId 가 백엔드 schema 에 그대로 매핑되도록 설계.

## Pitfalls / decision history

- **알림 클릭 race (가장 큰 함정)**: 초기에는 handler 에서 `setActiveProject(pid); navigate('/versions')` 직접 호출했음. 그런데 React 18 + zustand (`useSyncExternalStore`) + `useNavigate` 의 batching 이 완전 동기화 안 돼서, zustand 업데이트가 router 보다 한 박자 빨리 commit 되면 떠나는 사이트-레벨 페이지의 redirect `useEffect` 가 `activeProjectId !== null` 보고 `navigate('/', { replace: true })` 를 발사 → 최종 URL 이 `/` 로 덮어쓰여짐. 해결: handler 는 navigate 만 하고 projectId 는 location.state 로 위임, AppShell 의 `useLayoutEffect` 가 commit 직후 setActiveProject 함. **그래도 안 됐던 케이스가 또 있어서** 결국 사이트-레벨 페이지 4곳의 redirect `useEffect` 자체를 제거하고 사이드바 프로젝트 클릭에서 명시적으로 navigate 하도록 옮김. 이게 race 의 근원적 해결.
- **`var(--navy)` 가 사실 teal**: `#0e7268` 은 사용자 눈에 초록색으로 보임. PSNotify 의 Toggle 컴포넌트가 `on` 상태일 때 navy border + navy-50 배경을 썼는데 사용자가 "초록색 테두리 없애줘" 요청. 결국 Toggle 바깥 button 의 padding/border/background 전부 transparent 로 만들어서 알약 + 동그라미만 남김. 알림 type 색에서도 snapshot 은 navy → `--phase-analysis` (sky blue) 로 옮김.
- **알림 type 이름 변경 (`approval-req` → `pending`, `new-snapshot` → `snapshot`)**: 사용자 가독성을 위한 라벨 변경. 핸들러의 `item.type === '...'` 비교문도 함께 갱신함. 다른 type ('approved', 'rejected', 'run-start', 'info') 은 그대로.
- **Scope/Retention 글로벌 이전**: 처음에는 `notificationPreferences` store 에 per-project 로 구현했는데, 사용자가 "Solution Settings 로 옮겨줘" 요청. 의미상 user-level (Scope) / solution-level (Retention) 이라 글로벌이 더 맞는 모델. per-project store 의 `scopes`/`retentions` map + setters 는 호환을 위해 store 안에 남겨둠 (UI 에서만 안 씀).
- **VersionsPage 의 location.state.selectSnapshotId**: 옛 audit log entries 에는 `snapshotId` 가 없어서 알림 클릭해도 선택이 안 됨 (그냥 최신 snapshot 자동 선택으로 폴백). 신규 audit log 부터 정상 작동. 사용자에게 설명함.

## Intentionally not done

- **백엔드 audit log 테이블 / API** — PoC 1차 (2026-05-31) 까지는 프론트 zustand 만으로 충분. 다른 PC 에서 일관된 알림 보려면 서버 audit log 와 SSE/polling 이 필요한데, 그건 별도 PR.
- **Server-side 알림 push** — 현재 모든 알림은 본인 브라우저의 zustand 가 트리거. 다른 사용자의 audit log 는 polling (10초 fetchSnapshots) 으로 결국 들어오긴 하지만 즉시성이 떨어짐. WebSocket 또는 SSE 도입은 PoC 2차.
- **Notification analytics** — 어떤 알림이 무시되고 어떤 게 클릭되는지 추적 안 함. 필요하면 `markAllNotifRead` / 클릭 핸들러에 hook 추가.
- **`projectSettings.notify.recipients.*` / `projectSettings.notify.inbox.*` i18n key 정리** — UI 에서 안 쓰지만 파일에는 남아있음.
- **Retention 옵션 i18n** — `7일/30일/90일/OFF` 가 SolutionSettingsModal 에 inline 하드코딩.
- **이전 localStorage 데이터 마이그레이션 스크립트** — 사용자에게 hard refresh / localStorage 키 삭제 안내로 갈음.
