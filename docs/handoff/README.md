# docs/handoff/ — work handoff notes

The 5-person team works from separate PCs, so we drop a per-unit-of-work note in this folder. The goal: the next person to touch that code (which may be your future self) doesn't start their AI session with zero context.

## When to write one

- Before opening a PR — include the handoff file in the last commit.
- Or when you stop work for the day — for "tomorrow's you" as well.

## Filename convention

```
docs/handoff/YYYY-MM-DD-{slug}.md
```

- `slug` is short English kebab-case. Examples: `project-settings`, `flyway-v7-connection`, `worker-bootstrap`.
- Multiple files on the same day are fine — just keep slugs distinct.
- Move files to `docs/handoff/archive/YYYY-MM/` monthly (clean up once a quarter).

## Template

New files follow this shape:

```markdown
# YYYY-MM-DD — {slug} ({author})

## What was done
- 1–3 bullets — the feature, bug fix, or refactor.

## What the next person should do
- The most specific next action for whoever picks this up.
- Include file paths and function names if you know them.

## Pitfalls / decision history
- "Why this was done this way" — context the code alone doesn't reveal.
- Where you got stuck, what you worked around, what you intentionally didn't do.

## Intentionally not done
- Out-of-scope items. To be addressed in a later PR.
```

To auto-generate, use the `/handoff` slash command — it inspects `git status` / `git diff` and fills in the template.

## Writing guidelines

- **Write the WHY** — the WHAT is already in `git log` / `git diff`. The "why" is what's valuable.
- Under 200 words is usually enough. This is a handoff, not a diary.
- Wrap code identifiers (file, function, table names) in backticks — so follow-up AI sessions can grep them.
- Negative statements ("did NOT do X") matter too. "Not done" is often the next person's starting point.

## How to read

When starting a new session (and per `CLAUDE.md`):

1. List `docs/handoff/` sorted by name descending → skim the most recent 1–3 files.
2. Confirm with the user in one line: "The recent handoffs were X and Y — should I continue from there?"
3. Once confirmed, start from the "what the next person should do" section.
