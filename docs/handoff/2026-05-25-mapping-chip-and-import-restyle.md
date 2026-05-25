# 2026-05-25 — mapping-chip-and-import-restyle (Suhyun Jin)

`MappingPage.tsx` 한 파일에 모인 시각·워딩 다듬기. 기능 변경 없음.

## 한 일

- **필터바 라벨 통일**: `Passthrough`/`Transform` → `Pass`/`Rule`. 모든 라벨 첫 글자 대문자.
- **`RuleTag` 칩 재디자인**: 기존 `StatusBadge` tone 대신 pill 형 (`borderRadius: 10`) + 좌측 dot + 진한 텍스트(`#065f46`) + 옅은 배경(`#ecfdf5`). dot/border 색은 필터바와 동일한 `TOBE_RULE_COLORS[rule]` 사용. `unmapped` 만 red 팔레트. `err`/`warn` status 와 `skip`/`added` 룰은 기존 톤 유지.
- **`TOBE_RULE_COLORS` 그라데이션 균등화**: `#059669 → #8AEDC3` RGB 직선 보간으로 4 등분 (`Pass · Rule · Default · Null`). 진하기 순서로 `Null` 이 가장 옅음.
- **Mapping Detail 섹션 라벨**: `Transform` → `Rule`.
- **Import 버튼 통합**: `Auto-map unmapped`/`Auto-mapping` → `↓ Import Mapping`/`✓ Mapping Imported`. `Import YAML` 도 같은 패턴 (`↓ Import YAML`/`✓ YAML Imported`). 둘 다 `btnSecondary` (`var(--border-strong)`) + Font Awesome `fa-download` (`\f019`). 임포트 후엔 텍스트만 `var(--text-3)` 으로 톤다운.
- **`ImportFileModal` 에 `onImported?` 콜백 추가**: 백엔드 API 없어도 frontend state 가 임포트 완료를 인지할 수 있게.

## 다음 사람이 할 일

- `yamlImported` 는 in-memory state 라 새로고침하면 사라짐. YAML 임포트 백엔드 API 가 생기면 `mappingImported` 처럼 서버 상태 (`mappingStatus`) 에서 유도하도록 교체.
- `ImportFileModal` 의 Import 버튼은 여전히 `console.log` 만 함 (`MappingPage.tsx:2551`). 실제 import endpoint 가 생기면 `onImported` 는 그 호출 성공 후에 부르도록.

## 함정 / 결정 이력

- `RuleTag` 의 진한 텍스트는 모든 칩에서 `#065f46` 통일. dot/border 색만 차등화 — 라벨 가독성 확보 + 한 화면에 여러 칩이 떠도 톤 균일.
- `mappingImported` 상태일 때 보더는 그대로 `var(--border-strong)` 유지하고 텍스트만 옅게 한 이유: 보더까지 옅게 하면 `Import YAML` 과 두께/색이 달라 보여 "왜 다르지?" 가 됨.
