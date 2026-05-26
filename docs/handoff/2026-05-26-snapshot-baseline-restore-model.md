# 2026-05-26 — snapshot-baseline-restore-model (Suhyun Jin)

Snapshot 고정핀(baseline) 을 Mapping 화면과 연동 + **Restore 모델** 도입.

## 한 일

- **Mapping 화면 칩**: TO-BE 칩 / 테이블 칩 옆에 baseline snapshot 의 `version` 칩 추가
  (`PinIconSvg` Versions 사이드바와 동일, 초록 계열). 클릭 시 `/versions` 로 이동하며
  `location.state.selectSnapshotId` 로 해당 snapshot 자동 선택.
- **수정 시 자동 해제**: row editor 의 `handleSaveEdit` 가 `await upsertRule` → `clearBaselineIfPinned`
  순서로 호출. 순서가 반대였을 때 main hydrate effect 가 race 로 옛 live 데이터를 가져와
  사용자 변경을 덮어쓰는 버그가 있었음.
- **Apply 시 변경 감지**: `MappingDefinitionImportModal.handleApply` 가 apply 후 mapping_rules /
  bindings 의 시그니처(id/timestamp 제외) 를 snapshot frozen 과 비교 → 다르면 핀 해제.
  같은 CSV 로 단순 reapply 했고 결과가 동일하면 핀 유지. codeMaps 는 listAPI 가 없어
  `codePending != 'none'` 으로 보조 판단.
- **Restore 모델 전환** (가장 큰 변화):
  - **Backend**: `SnapshotController.setBaseline` 안에서 `restoreMappingFromSnapshot` 호출.
    그 snapshot 의 `snapshotData` 를 `mapping_rules` / `mapping_code_maps` / `mapping_table_bindings`
    로 wipe + replace (entity-level deleteAll 로 bindings → sources cascade 보장).
  - **Frontend store**: `togglePin`(set) / `setPin` 이 `setBaseline` 완료 **후** pinnedIds 갱신
    + `fetchByProject` 호출. 낙관적 갱신 시 hydrate 가 backend restore 완료 전에 옛 live 를
    가져오는 race 회피. clear 케이스는 mapping_* 그대로라 즉시 낙관적.
  - **Frontend page**: main hydrate effect 의 baseline override 분기 제거. 핀 = live 가 곧
    snapshot 시점 = 항상 backend live fetch 면 충분. `hydrateBindingsFromDb` /
    `hydrateRowEditsFromDb` 의 `override` 파라미터도 제거.

## 함정 / 결정 이력

- **View 모델 → Restore 모델 전환 이유**: 처음엔 frontend rowEdits 만 snapshot data 로 override
  하는 View 모델로 구현. 사용자가 "v1 핀 + 두 번째 컬럼만 mapping 했더니 그 밑 컬럼이 다 v3 로
  자동 mapping 됨" 으로 보고. 원인 — live mapping_rules 가 핀 상태와 무관하게 항상 latest 라,
  사용자 수정 시 핀 해제 + hydrate → live(=v3) 가 통째로 표시. 사용자 의도는 "snapshot 으로
  돌아가서 거기서 작업" = Restore 모델. 핀 누르는 순간 backend live 자체가 snapshot 시점으로
  교체되어야 함.
- **Destructive 액션 명시**: 단순 보기로 핀을 눌러도 live mapping_* 가 즉시 교체된다. 모델
  선택 시 사용자에게 확인 받음 (UX option A — confirm prompt 없이 즉시 restore).
- **race 회피**: `setBaseline` 응답 전에 frontend pinnedIds 를 낙관적 갱신하면 main hydrate
  effect 가 backend restore 끝나기 전 listRules 호출 → 옛 데이터 + 깜빡임. set 케이스는
  완료 후 갱신, clear 는 그대로 낙관적.
- **JPA 1차 캐시 충돌 방지**: `restoreMappingFromSnapshot` 안에서 wipe 후 `snapshotRepository.flush()`
  강제. JPQL `@Modifying` delete + 같은 트랜잭션 안 새 insert 패턴의 정석.
- **새 UUID 발급**: restore 시 frozen id 그대로 쓰면 다음 snapshot 이 같은 id 의 frozen 을
  또 생성 → ID 충돌 위험. 새 UUID + `updatedBy/At` 은 호출자 user / now.
- **handleSaveEdit await 순서**: upsertRule → clearPin. 반대 순서는 race (직전 fix 와 동일).

## 다음 사람이 할 일

- **codeMaps 비교 정확도 개선**: 현재 `MappingDefinitionImportModal` 의 apply 후 비교는
  codeMaps 를 `codePending` 으로만 보조 판단 (listCodeMaps API 가 없어서). 정확도 필요하면
  backend `GET /api/v1/projects/{projectId}/mapping/code-maps` 추가 + frontend 비교 helper
  `codeMapsEqual` 추가.
- **destructive 액션 확인 prompt 검토**: 현재 핀 클릭 즉시 live 교체. 사용자가 single click
  으로 destructive 결과를 만드는 게 너무 쉽다는 피드백이 나오면 모달 confirm 추가 검토
  (옵션 C 였던 것).
- **fetchByProject payload 비용**: setBaseline 완료 후 snapshots 전체 refetch — snapshotData
  jsonb 가 큼. snapshot 수 늘어나면 비용 문제. setBaseline 응답의 single Snapshot 으로
  store 부분 갱신 + 같은 project 의 다른 snapshots `baseline=false` 직접 set 하는 방식으로
  대체 가능.
