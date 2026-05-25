# 2026-05-25 — dev-merge-conflict-cleanup (Suhyun Jin)

`dev` pull 후 `mvn spring-boot:run` 컴파일 실패. 두 파일에 머지 충돌 해결 잔재.

## 한 일

- **`SecurityConfig.java:57`** — `addFilterBefore(apiTokenAuthFilter, ...);` 끝의 `;` 제거 + 그 다음 줄의 중복 `addFilterBefore(jwtAuthFilter, ...)` 라인 삭제. 결과 체이닝 순서: `jwt → workerToken → apiToken → licenseEnforcement(after)`.
- **`DdlImportService.java:223-230`** — 자체 `sha256Hex(byte[])` 메소드 통째 삭제. import 가 누락돼 컴파일 실패였지만, 78 줄에서 이미 `HashUtil.sha256Hex(...)` 를 쓰고 있어 dead code 였음. import 추가 대신 정리.

## 함정 / 결정 이력

- 두 파일 모두 다른 PR (`feature/schedule` 머지 추정) 의 잔재로 보임 — 우리 작업과 무관. 머지한 사람에게 알려둘 것.
- `DdlImportService` 의 dead method 는 import 추가로도 살릴 수 있었지만 같은 책임이 이미 `HashUtil` 에 있어서 중복 회피 쪽이 정공법.
