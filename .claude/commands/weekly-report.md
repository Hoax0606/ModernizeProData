---
description: 이번 주 작업을 카톡용 보고 형태로 정리
argument-hint: [days] — optional, 기본 7
---

너는 카톡 보고용 간단 작업 정리를 만든다. 다음 규칙을 **엄격히** 지켜라.

## 형식 규칙 (이걸 어기면 안 됨)

- 한국어
- 3-5 bullet, 한 bullet 1-2 문장
- **emoji 사용 금지**
- 어조: "~ 했습니다 / ~ 예정입니다" 같은 카톡 보고체
- 코드 블록·표·헤더 사용 금지 — 평문 리스트만
- 누구에게 / 어떤 시점에 / 무엇을 했는지 명확히

## 수집 (병렬 실행)

기본 기간은 최근 7일 (인자로 받은 `days` 가 있으면 그 값).

```
git log --since="N days ago" --pretty=format:"%h %ad %s" --date=short
git diff --stat HEAD@{N.days.ago} HEAD
```

머지 commit 은 제외. `chore:` / `docs:` 위주 trivial commit 은 합쳐서 한 줄로.

## 작성 구조 (3-5 bullet)

다음 항목에서 골라 채워라. 모두 들어가야 한다는 뜻은 아니다. 자연스러운 흐름이 되도록.

1. **이번 주 진행 한 일** — 핵심 PR/feature 1-2 개를 줄여 묘사. 예: "Project Settings 화면 6 섹션 UI 재작성, General/Danger 는 백엔드 연결까지 완료."
2. **다음 주 할 일** — handoff 노트의 "다음 사람이 할 일" 을 모아 정리. 예: "다음 주는 백엔드 Project 엔티티에 connection/credentials/schedule jsonb 필드 추가하고 Flyway V7 마이그레이션 예정."
3. **막힌 부분 / 도움 필요** — 의사결정 필요한 항목, 환경 문제. 없으면 생략.
4. **확인 부탁** — 사용자(코디네이터)가 검토해줘야 할 PR/스펙. 없으면 생략.

## 출력

채팅에 바로 붙여넣을 수 있도록 메시지 본문만 출력해라. 헤더 ("주간 보고", "이번 주" 등) 도 붙이지 마라 — 사용자가 카톡에 별도 헤더 작성해 보낸다.

handoff 파일이 `docs/handoff/` 에 있다면 그것도 참고 자료로 읽어 정리에 반영해라.
