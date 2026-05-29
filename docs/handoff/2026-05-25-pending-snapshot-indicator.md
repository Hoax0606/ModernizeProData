# 2026-05-25 — pending-snapshot-indicator (Seongmin Bae)

같은 날의 `2026-05-25-versions-pin-to-top.md` 에 이어진 작업. snapshot approval flow 의 시인성을 높이는 두 번째 단계 — Coordinator 가 어느 프로젝트의 snapshot 을 승인해야 하는지 한 눈에 알도록 amber 모래시계 표시.

## What was done

### 1) 공용 아이콘 컴포넌트 — `components/HourglassHalfIcon.tsx`

FontAwesome Free 7.2 의 `hourglass-half` solid path 를 인라인 SVG 로. `fill="currentColor"` 라 부모 `color` 따라감. `LockIcon` 과 동일한 패턴 (`size` / `color` / `title` prop). 사용자가 FA 사이트에서 직접 다운로드한 svg (`hourglass-half-solid-full.svg`) 의 path 를 그대로 사용.

**왜 인라인 SVG 인가** (`index.html` line 8 의 FA Free 6.5 CDN 한계):
- `fa-regular fa-hourglass-half` → Pro 전용. 무료 CDN 에선 빈 글리프.
- `fa-sharp fa-regular fa-hourglass-half` → 마찬가지로 Pro 전용.
- `fa-solid fa-hourglass-half` 는 무료에 있지만 한번 Pro/Regular 스타일이 필요해질 가능성을 미리 차단.
- 인라인 SVG 는 CDN 변경에도 안전 + currentColor 로 테마 자동 따라감.
- Sharp/Regular 변형이 필요해지면 `index.html` 의 link 를 FA Pro kit URL 로 교체.

### 2) Pending snapshot 표시 — 두 위치

해당 프로젝트에 **`status === 'pending'` 인 snapshot 이 1개 이상** + **흰색 TEST 단계** 일 때만 프로젝트 이름 옆에 amber 모래시계.

**트리거 조건**:
```ts
pendingProjectIds.has(p.id)
  && p.phase === 'test'
  && p.runStatus === 'completed'
```

"흰색 TEST" 의 정의는 `DashboardPage.tsx::phaseChipColor` 안에 있음 — `runStatus === 'completed' && (phase === 'test' || phase === 'rehearsal')` 일 때 흰 배경 chip. 단, 사용자가 명시적으로 **TEST 만** 요청해서 rehearsal 은 제외.

**의미상**: Trial 실행 끝나고 사용자가 결과 보고 매핑 수정하면서 snapshot 만들어 승인 요청한 직후의 단계 — 정확히 그 시점에 Coordinator 에게 액션이 필요함을 알려야 함. sign-off / ready / cutover 단계엔 이미 다른 UI (Approvals 페이지 등) 가 있어서 모래시계 중복 안 띄움.

**두 위치 모두 적용**:
- `DashboardPage.tsx` 의 SiteOverview 테이블 → Project name 컬럼 안.
- `AppShell.tsx` 의 사이드바 Projects 리스트 → projectNameRow 안.

**데이터 소스**:
- 두 페이지 모두 `useSnapshotsStore.snapshots` 구독 → `useMemo` 로 `pendingProjectIds` Set 계산.
- DashboardPage 의 SiteOverview 는 마운트 시 `fetchBySite(activeSiteId)` 호출 (Approvals 안 들렀어도 store 채우기).
- AppShell 은 이미 site-wide snapshot polling 이 돌고 있어서 (`AppShell.tsx:127` `await fetchSnapshots(siteId)`) 추가 호출 불필요.

### 3) i18n — ko/ja/en 모두

새 키 `siteOverview.pendingSnapshotIcon.title`:

- ko: `스냅샷 승인 대기 중`
- en: `Snapshot waiting for approval`
- ja: `スナップショット承認待ち`

tooltip + aria-label 로 두 위치 동일 키 사용.

### 4) 시각 정렬 보정

flex `align-items: center` 는 line-box 의 **기하 중심** 에 맞추는데, 텍스트는 baseline 위쪽 (caps + x-height) 에 시각적 무게가 쏠려 있어서 아이콘이 살짝 처져 보임. 두 곳 모두 `transform: translateY(-1px)` 으로 보정 (paint-only, layout 영향 없음). 0.5px 는 디바이스에 따라 0 으로 라운딩될 수 있어서 정수 단위가 안전.

## What the next person should do

1. **end-to-end 시나리오 검증**: Mapping → Trial 완료 → Versions 에서 snapshot 생성 (draft) → Request Review → Confirm → All Projects 테이블 / 사이드바 양쪽에 amber 모래시계 표시 → Coordinator 가 Approvals 에서 승인 → 양쪽 동시에 사라짐 (status `approved` + phase `sign-off` 양쪽 조건 모두 거짓이 됨).

2. **Rehearsal 단계도 동일 처리 결정** — 사용자가 명시적으로 "흰색 TEST" 만 요청해서 rehearsal 은 제외했지만, 같은 흐름 (Trial → snapshot → approval) 이 rehearsal 에도 존재. 동일 패턴이 필요하다고 판단되면 두 조건문에 `|| p.phase === 'rehearsal'` 추가만 하면 됨.

3. **모래시계 클릭 동작 고려** — 현재는 표시 전용. Approvals 페이지로 deep-link 하거나 해당 snapshot 의 Versions detail 로 이동시키면 Coordinator UX 가 더 좋아짐.

## Pitfalls / decision history

- **왜 phase 까지 좁히는가**: 초기엔 `pendingProjectIds.has(p.id)` 만 봤더니 sign-off / ready / cutover 에서도 모래시계가 떠서 사용자가 "흰색 TEST 일 때에만" 으로 정정. 해당 단계엔 이미 Approvals 페이지가 전용 UI 라 사이드바/테이블 표시는 시그널 노이즈가 됨.
- **왜 사이드바와 테이블 모두**: 사용자가 두 번째 메시지에서 "**바깥쪽 전체 PROJECTS 를 볼 수 있는 곳에도**" 요청 — sidebar 도 같이.
- **왜 공용 컴포넌트로 추출**: 초기엔 `DashboardPage.tsx` 안에 로컬 함수로 정의 (`HourglassHalfIcon`). AppShell 에서도 쓰게 되면서 `components/HourglassHalfIcon.tsx` 로 추출. 후속 사용처에서 import 만 하면 됨.
- **승인 race condition**: Coordinator 가 approve 누르면 backend 에서 snapshot status (`pending → approved`) + project phase (`test → sign-off`) 가 거의 동시 변경. 프론트는 각각 다른 fetch 로 sync. 어느 쪽이 먼저 도착해도 두 조건 모두 `&&` 라서 한쪽만 거짓이 돼도 모래시계는 사라짐 — race 안전.
- **두 위치의 size 차이**: 사이드바 11px (텍스트 fontSize 11.5), 테이블 12px (텍스트 fontWeight 500 default size). caller 가 결정 (`HourglassHalfIcon` 의 size prop).

## Intentionally not done

- Rehearsal 단계에 동일 표시 (위 next person 2번 참조)
- 모래시계에 클릭 동작 (위 3번)
- VersionsPage 의 PENDING 배지 옆 아이콘 — 세션 중 두 번 시도했다가 사용자 요청으로 둘 다 revert. PENDING 배지 자체는 기존 amber 컬러로 충분히 시인성 있고, 진짜 필요한 건 "어느 프로젝트가 대기 중인지" 의 list-level 시그널이라는 결론.
- FA Pro CDN 으로 교체 — 한 번 인라인 SVG 패턴이 자리잡으면 Pro 가 굳이 필요 없음. 비용 회피 + offline 환경 (현장 격리망) 친화적.
