# 2026-05-25 — scheduler-trigger-ui (Hiroyuki Onda)

## 한 일

`feature/schedule` merge 후의 Scheduler page UI 정리 4 가지 (FE only, BE / migration 무변경).

- `solution.internal.desc` / `activeHint` 를 현 사양 (common/individual mode + phase → run type) 에 맞춰 재작성. 구사양 wording ("Nightly rehearsal", "Project Settings → Schedule") 의 잔재 제거.
- Trigger examples → **Trigger commands** 로 rename. desc 도 "project ID 는 본 도구 내에서 생성된 project ID 가 임베드" 로 정확화 (이전 wording 은 "입력값" 으로 표기되어 오해 소지 있음).
- curl 예시 **1 줄로 평탄화** (bash `\` line continuation 의 PowerShell / cmd 호환 문제 회피).
- **Shell dropdown** 을 Trigger commands 위에 배치 — 3 선택지에 따라 `curl` 기동 prefix 와 `-d` body quote/escape 형식이 동적 변경:
  - bash → `curl ... -d '{"projectId":"..."}'`
  - windows → `curl ... -d "{\"projectId\":\"...\"}"`
  - powershell → `curl.exe --% ... -d "{\"projectId\":\"...\"}"`

## 함정 / 결정 이력

- Windows CRT (argv parser) 는 `'` 을 quote 로 인식하지 않음 → bash 식 `-d '...'` 은 cmd / Task Scheduler 그대로 안 통함. `\"` escape 필수.
- PowerShell 은 자체의 native argument 재가공도 들어가므로 `curl.exe --%` (stop-parsing token) prefix 로 회피. body file 방식 (`--data-binary @file`) 도 검토했으나 3 선택지로 99% 커버되어 dropdown 에서 제외.
- `shellMode` 는 session state 만 (`useState`, persist 안 함). 매 페이지 진입시 default = bash 강제 — 이전 선택을 무심코 그대로 copy 하는 사고 회피.
- `triggerExamples` i18n key 명은 UI 표시 (`Trigger commands`) 와 불일치 — rename refactor 회피로 의도적. 다음 PR 에서 일제 정리 가능.

## 안 한 것 (의도적으로)

- ONBOARDING.md §17 / CLAUDE.md 추기 없음 — UI 표층 변경이라 설계 문서 갱신 불필요. §17 은 설계 (run type 결정 / token 인증 / phase semantics 등) 가 본질로, dropdown 따위는 굳이 안 적음.
- `--%` 의 PowerShell 5.1 vs 7 호환성 실측 안 함 — `--%` 는 양 버전 표준 사양이므로 문제 없을 것으로 판단. 현장 PowerShell 5.1 PC 에서 동작 확인은 완료.
