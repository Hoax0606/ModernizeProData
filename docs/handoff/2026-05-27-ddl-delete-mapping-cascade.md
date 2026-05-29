# 2026-05-27 — ddl-delete-mapping-cascade (onda)

## What was done

- `DdlImportService.deleteDdl()` 가 DDL 삭제시 **mapping 관련 3 테이블을 일률 wipe**
  하도록 확장: `mapping_rules` / `mapping_table_bindings` / `mapping_code_maps`.
  AS-IS / TO-BE 어느 쪽 삭제도 동일하게 cascade. 「DDL 삭제 = 처음부터 다시」 의미로
  통일.
- 기존 「孤児 rule 이 同名 DDL 재 import 시 자동 재연결」 동작은 명시 삭제에서만
  깨짐. `importDdl()` (재 Import) 은 그대로 두어서 「DDL 의 수정판 반영, mapping 은
  名前 일치로 자동 재연결」 설계가 살아 있음.

## What the next person should do

- 다른 브랜치에서 진행 중인 「per-table run tracking + Request Review 게이트 변경」
  작업과는 **이번 변경은 독립**. 그쪽에서 mapping 영역을 만지더라도 본 변경과 충돌
  소지 없음.
- 명시 DDL 삭제 시 영향이 큰 destructive 동작이라 UI 확인 모달은 기존 그대로 두면
  되지만, 「mapping 도 삭제됨」 문구를 모달에 추가해두는 것도 친절 (asisDdl
  `confirmDeletePost` 등에 "mapping 정의도 함께 삭제됩니다" 추가하면 됨).

## Pitfalls / decision history

- AS-IS 만 삭제할 때 「rule 의 asis 참조만 null clear」 하는 안도 검토했지만,
  사용자 결정으로 「둘 다 일률 wipe」 채택. rule 은 양쪽 DDL 의 결합으로 의미를
  가지므로 한쪽이 사라진 시점에서 rule 도 의미가 없다는 판단.
- 재 Import 의 mapping 보존 동작은 의도적으로 유지. 軽한 DDL 수정으로 mapping
  전부 날라가면 UX 가 최악. 만일 「재 Import 도 wipe」 하고 싶다면 별도 결정으로.
- 알려진 한계: 재 Import 로 테이블 / 컬럼이 rename 되면 旧名 rule 이 조용히
  孤児화 (MappingPage 에 표시되지 않음). 본 PR 이전부터 존재하던 설계 한계로,
  여기서는 손대지 않음.

## Intentionally not done

- 별도 브랜치에서 진행 중인 「Request Review 게이트 변경 (preflight → completed
  run)」 관련 작업은 본 PR 에서 모두 revert. BE endpoint 신설 / FE 게이트 refactor
  / i18n 변경 / docs 업데이트 일체 포함. 다음 통합은 그 브랜치 머지 후 진행.
- 모달 문구의 「mapping 도 삭제됨」 추가 (위 「next person」 항목 참고).
