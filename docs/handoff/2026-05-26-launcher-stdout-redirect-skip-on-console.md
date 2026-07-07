# 2026-05-26 — launcher-stdout-redirect-skip-on-console (Suhyun Jin)

`Launcher.redirectStdoutToFile()` 가 콘솔 환경에서 redirect 되지 않도록 한 줄 가드 추가.

## 한 일

- **`Launcher.redirectStdoutToFile()` 첫 줄에 `if (System.console() != null) return;`** 추가. `mvnw spring-boot:run` / `java -jar` 처럼 콘솔이 있는 실행에서는 stdout/stderr 를 그대로 콘솔로 흘려보내고, jpackage WinExe (console=null) 일 때만 `%LOCALAPPDATA%\ModernizeProDataBridge\launcher.log` 로 redirect.

## 함정 / 결정 이력

- license-setup PR (`4f12ff6`) 이 `Launcher.java` 의 `redirectStdoutToFile()` 를 무차별 발동시켜서, 개발 환경 `mvnw spring-boot:run` 의 Spring Boot banner / 로그가 콘솔에 안 뜨고 launcher.log 로만 흐르는 회귀가 있었다. Spring Boot 자체는 정상 부팅이라 hang 처럼 보이지만 사실은 stdout 만 안 보이는 상태였음 (8080 listen + health 200 확인).
- 회귀 진단은 thread dump → 부팅 완료 + Tomcat acceptor 확인 → 부모 process 추적 → `Launcher.main` 의 첫 줄이 stdout redirect 라는 점 발견.
- `System.console() != null` 가드가 가장 단순 + 사이드 이펙트 없음. system property 옵션 (`-Dmpd.launcher.no-redirect`) 보다 사용자가 추가 인자 안 줘도 자동 동작.

## 다음 사람이 할 일

- 일시적 thread-dump.txt (root 에) 가 작업 중 만들어졌으면 삭제. commit 대상 아님.
