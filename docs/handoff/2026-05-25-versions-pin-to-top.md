# 2026-05-25 — versions-pin-to-top (Seongmin Bae)

Versions 페이지의 snapshot 목록에 **상단 고정 (pin)** 기능을 추가했다. 백엔드 손대지 않은 UI-only 기능이며 `localStorage` 영속.

## What was done

### 1) Pin store — UI-only, persisted

`store/snapshots.ts` 에 `usePinnedSnapshotsStore` 추가 (zustand `persist`, key `modernize-pinned-snapshots`).

- 한 번에 **단 하나의 snapshot** 만 고정. `togglePin` 은 다른 pin 을 자동 해제하고 새 id 만 남김.
- `setPin(id)` 는 강제 교체 — Approvals 에서 승인 직후 호출용.
- 별도 컬렉션이라 기존 `useSnapshotsStore` 와 독립적으로 hydrate.

### 2) Phase-aware pin eligibility — `isPinEligible(snapshot, phase)`

| Phase                                  | Pin 가능 대상                       |
|----------------------------------------|------------------------------------|
| `planning` / `analysis` / `test`       | non-approved **mapping** snapshot |
| `sign-off` / `rehearsal`               | approved **mapping** snapshot     |
| `ready` / `cutover` / `hypercare` / `done` | approved **cutover** snapshot |

→ 즉 "현재 phase 에서 가장 의미 있는 snapshot 한 개" 만 사용자가 상단 고정 가능. 부적합한 snapshot 은 토글 disabled.

### 3) Versions 페이지 UI

- snapshot 목록 정렬: pinned-first → 그 후 `createdAt` desc
- 좌측 카드 우상단에 작은 pin 아이콘 (`PinIconSvg`)
- 우측 상세 패널 하단의 `Approval Status` 영역을 2-col grid 로 분리:
  - 왼쪽: 기존 Approval Status (단, `pending/approved/rejected` 카드 색을 amber/green/red 로 채색)
  - 오른쪽: 새 `Pin` 카드 — 토글 스위치 + 현 상태 설명
- Cutover 태그 폰트·padding 미세 조정 (8.5→9, 두께 700, padding 1×6).
- `btnCutover` 가 red ghost → red **solid** 로 변경.

### 4) Approvals → Auto-pin on approve

`ApprovalsPage.tsx::handleApprove` 가 승인 직후 `setPin(snap.id)` 호출.

- 매핑 snapshot approve → phase 가 `sign-off` 로 넘어가는데, 이때 자동으로 그 mapping snapshot 이 pin 됨 → 사용자는 versions 페이지를 열자마자 "방금 승인된 것" 을 상단에서 확인.
- Cutover snapshot approve → `ready` phase + 해당 cutover snapshot pin.

### 5) i18n — ko/ja/en 모두 추가

새 키 (`versions.pin.*`):

```
section, descPinned, descEligible, descIneligible,
toggleTitlePin, toggleTitleUnpin, toggleTitleIneligible, iconAria
```

- `section` / `iconAria` / `toggleTitlePin` / `toggleTitleUnpin` — 4종은 ko/ja/en 모두 동일 영문 (정책: `*.title` 류)
- `descPinned` / `descEligible` / `descIneligible` / `toggleTitleIneligible` — 4종은 언어별 번역

추가로 **기존부터 하드코딩이던 Approval Status 카드 카피도 같이 i18n 화** 했다 (사용자 요청):

- `versions.statusDesc.{draftReady,pending,approved,rejected}` — desc 4종, 언어별 번역. `approved` / `rejected` 는 `{date}` `{who}` 보간.
- `versions.descError.repeat` — Description 입력 시 같은 글자 반복 에러 메시지.
- 카드 **title** 텍스트 (`승인 대기 중` / `승인됨` / `반려됨`) 는 기존 `versions.status.{pending,approved,rejected}` (ko/ja/en 모두 영문 `Pending`/`Approved`/`Rejected`) 키 재사용 — CLAUDE.md 의 `*.status.*` 동일영문 정책 준수. 한국어 UI 의 상태 텍스트가 "승인 대기 중" → "Pending" 으로 바뀜에 유의.
- 반려 사유 prefix (`사유:`) 는 기존 `versions.reasonPrefix` 재사용 (`'Reason: '` 동일).
- Confirm request 문장 (`<b>{name}</b> 스냅샷에 대해 승인을 요청하시겠습니까?`) 은 기존 `versions.confirmRequestPre/Post` 재사용. 영문 톤: `Request approval for <b>name</b>?`.

`VersionsPage.tsx` 안 남은 한국어는 **comment 전용**. 사용자 노출 문자열은 전부 `t()` 호출.

## What the next person should do

1. **Pin 영속 범위 결정** — 현재 `localStorage` (PC 단위, 사용자 무관). 같은 PC 의 다른 사용자에게도 동일 pin 이 보임. 사용자별 저장이 필요하면 `useAuthStore` 의 user id 를 key 에 섞거나, 백엔드로 옮길 것.
2. **테스트**: 매핑/cutover 두 snapshot 이 같은 프로젝트에 있을 때 phase 가 바뀌면 pin 이 사라지지 않고 그대로 남는다는 점 확인 (의도된 동작 — eligibility 와 pin 보존은 분리). 사용자가 혼란스러우면 phase 전환 시 자동 unpin 로직 추가 고려.
3. **ja 번역 검토** — `versions.statusDesc.*` 와 `versions.descError.repeat` 의 일본어는 일반적인 정중체로 작성. ja native 팀원 (Suhyun, KMA 등) 확인받으면 좋음.

## Pitfalls / decision history

- **왜 backend persist 가 아닌가**: pin 은 "지금 내 화면에서 보기 좋게" 정도의 보조 기능이라 메타 DB 까지 확장하지 않음. PoC 단계에서는 LS 로 충분. 추후 다중 사용자 협업 요구 생기면 옮긴다.
- **왜 한 번에 한 개만 고정인가**: 여러 개를 고정 가능하게 하면 어느 게 "현재 의미 있는 snapshot 인지" 가 흐려진다. 특히 자동 pin (approve 시) 이 누적되면 더더욱. 단일 pin 으로 잠그고, 다른 걸 pin 하려면 기존 pin 이 자동으로 풀리도록 함.
- **승인 카드 컬러 변경 이유**: 기존엔 status 4개 모두 회색 `--panel-2` 였음 — 한 눈에 상태 식별이 어려웠음. amber/green/red 로 칠해서 시각적 hierarchy 부여. draft 는 의도적으로 강조 색을 안 줘서 "아직 승인 흐름 진입 전" 임을 약하게 표현.
- **detailSection marginBottom 22 → 56**: pin 카드가 추가되면서 Approval/Pin row 와 그 아래 Changes 섹션 간 여백이 너무 좁아 보였음. 그 한 군데만 늘릴 게 아니라 전체 detailSection 의 reading rhythm 도 같이 개선.

## Intentionally not done

- 사용자별 pin 분리 (위 1번 참고)
- Pin/Unpin 액션의 audit log 기록 — 의미 있는 도메인 변경이 아니라 UI preference 라 audit 대상에서 제외
- Phase 변경 시 pin 자동 해제 — eligibility 체크는 토글 disable 로 충분하다고 판단
- VersionsPage 안의 **comment** 한글화 유지 — comment 는 한국어 BE/FE 팀 가독성 우선이라 유지. 사용자 노출 문자열만 i18n.
