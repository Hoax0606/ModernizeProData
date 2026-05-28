---
description: Generate docs/handoff/{date}-{slug}.md from current git changes
argument-hint: [slug] — optional kebab-case slug; ask user if missing
---

너는 지금 작업 인수인계 노트를 `docs/handoff/` 폴더에 만든다. 다음 순서로 진행해라.

1. **사용자 정보 수집** (필요한 경우에만 묻는다):
   - `slug` 가 인자로 주어졌으면 그대로. 아니면 사용자에게 짧은 영문 kebab-case slug 를 물어라 (예: `project-settings`, `flyway-v7-connection`).
   - 작성자 이름이 git config 에서 안 나오거나 모호하면 사용자에게 물어라. 기본은 `git config user.name` 또는 시스템 메모리의 user 이름.

2. **변경 사항 수집** (한 번에 병렬로):
   - `git status --short`
   - `git diff --stat HEAD` (working tree 의 누적 변경)
   - `git log -10 --oneline` (최근 컨텍스트)
   - 큰 변경 파일은 `git diff -- <path>` 로 일부만 확인 (전체 다 읽지 말 것 — 토큰 낭비)

3. **분석**: 변경된 파일에서 다음을 파악해라:
   - 어떤 기능/버그/리팩터링인지 (한 일)
   - 코드에 남은 TODO/FIXME, 또는 미완 부분 (다음 사람이 할 일)
   - 코드만 보면 알 수 없는 결정·우회·트레이드오프 (함정)
   - 명시적으로 범위 밖으로 둔 것 (안 한 것)

4. **파일 작성**:
   - 경로: `docs/handoff/{YYYY-MM-DD}-{slug}.md`
   - 날짜는 시스템의 현재 날짜를 사용.
   - 템플릿:
     ```markdown
     # {YYYY-MM-DD} — {slug} ({작성자})

     ## 한 일
     - ...

     ## 다음 사람이 할 일
     - ...

     ## 함정 / 결정 이력
     - ...

     ## 안 한 것 (의도적으로)
     - ...
     ```
   - 200 단어 안쪽으로 압축. 사실(WHAT)보다 의도(WHY) 위주.
   - 파일·함수·테이블명은 `백틱` 으로 감싸기.
   - 한국어로 작성 (CLAUDE.md 의 답변 스타일 규칙).

5. **검증**: 작성 후 `git status` 한 번 보여줘서 사용자가 파일을 확인할 수 있게 해라. commit 은 하지 마라 — 사용자가 알아서 PR 마지막 commit 에 포함할 수 있도록.

## 참고

- 작성 가이드는 `docs/handoff/README.md` 에 있다.
- 다른 handoff 파일들의 톤·길이를 한 번 참고해 일관성 유지.
- 빈 섹션 ("해당 없음" 같은 placeholder) 은 두지 말고 그냥 그 섹션을 빼라.
