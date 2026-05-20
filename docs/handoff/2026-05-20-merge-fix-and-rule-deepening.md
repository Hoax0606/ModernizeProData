# 2026-05-20 — merge-fix-and-rule-deepening (Oh Hyunho)

## What was done

- **Merged PR #2 (feature/versions) and PR #3 (feature/ddl-import) into `dev`.** PR #3 had a 2-block conflict on `SettingsPage.tsx`; the conflict was resolved through the GitHub web UI.
- **Hotfix on `dev`**: the conflict resolution lost the `useLocation` import on line 2 of `SettingsPage.tsx` while still keeping `const location = useLocation()` on line 29, crashing the page at runtime. Restored the import in a one-line edit. `npx tsc --noEmit` now passes.
- **Rule engine deepening** (design only, no code yet):
  - Reframed the 3-layer rule input model from cascade to **toolbox** — users select by business intent, not technical complexity.
  - Split Layer 2 into **2a (parameterized SQL templates)** and **2b (Java UDF wrappers)** — different governance, different risk profiles.
  - **Layer 3 (user-input code) postponed to PoC 2nd round.** Security, performance, and debuggability can't be designed safely before 2026-05-31. For now, fallback when Layer 1/2 doesn't cover is the **table-scoped Java escape (ladder 2)**.
  - Layer 3 mechanism corrected: when implemented, use **dynamic UDF registration per snapshot** (not "user code as per-row argument to a generic CustomUDF").
  - Raised the missing **Validation Rules** track — pre/post conditions and cross-row/table invariants. Must be modeled before V7 Flyway migration.
- **Team git conventions added** to memory + `ONBOARDING.md` §15: Conventional Commits format, no GitHub-UI conflict resolution, import conflicts default to union, PR author resolves locally with typecheck + build.
- **`ONBOARDING.md` converted to English in full**, §4 restructured for the refinements, new §6 (Validation) and §15 (Git workflow) added.

## What the next person should do

Immediate hot path:

1. **Commit and push this set** (`SettingsPage.tsx` + `ONBOARDING.md` + `docs/handoff/2026-05-20-*.md`).
   Suggested commit message:
   ```
   fix(settings): restore useLocation import lost in PR #3 merge
   ```
   Bundle the doc updates in the same commit, or split into a second `docs:` commit — either is fine.
2. **Set up GitHub branch protection on `dev` and `master`** before more PRs land. Require PR + status checks. This is the durable fix for the PR #3 incident.
3. **Add a CI workflow** (`.github/workflows/ci.yml`) running `npx tsc --noEmit` + `npm run build` (frontend) and `./mvnw test` (backend) on every PR. Required for branch protection to be meaningful.
4. **Settle the 5 open rule-engine decisions** in `ONBOARDING.md` §16 — at minimum items 1, 2, 3, and 7 (validation track) before V7 Flyway. Items 4 and 5 can wait.
5. **Start V7 Flyway migrations** once schema decisions are in:
   - `V7__column_override.sql`
   - `V8__binding_source.sql`
   - `V9__mapping_snapshot_extended.sql`
   - Plus a Validation-rules track (table TBD)

## Pitfalls / decision history

- **The PR #3 root cause was the GitHub web conflict editor**, not the developer or the conflict itself. The web editor has no typecheck/build, so a "looks fine" resolution can hide a missing import. Memory and ONBOARDING now require: never resolve conflicts there; PR author resolves locally with verification before push.
- **Why Layer 2 was split into 2a / 2b**: from a user perspective they look like one menu of strategies. Operationally, 2a (pure SQL templates) is immune to UDF signature changes; 2b (Java UDFs) is not. Mixing them under a single "UDF library" obscures the risk and makes future governance (e.g., "what's at risk if we bump the UDF jar?") harder.
- **Why Layer 3 was deferred**: "user types code in a textbox" is a tempting escape hatch, but it implies (a) arbitrary code execution by non-Java-developer users, (b) per-row interpreter cost in the cutover hot path, (c) stack traces that point inside user input. None of these can be designed safely before 2026-05-31. The table-scoped Java mode (ladder 2) covers the same need with a coding overhead acceptable for the 1st round.
- **Validation gap**: every rule-engine conversation so far has been about transforms. Quarantine catches UDF failures but doesn't express "row transformed correctly but violates business invariant". Without a parallel validation track, sites will ship migrations that pass all UDF gates yet fail downstream audit.

## Intentionally not done

- Code for the rule engine — still in design phase.
- CI workflow (`.github/workflows/ci.yml`) — flagged in next-steps but not in this commit.
- GitHub branch protection settings — needs the user's GitHub admin access.
- `docs/DESIGN.md` correction — outdated §7 ("매핑 정의 형식") not touched. Will be addressed in a later PR.
- Conversion of other memory files to English — only the files touched today (`project-rule-engine-design.md`, `MEMORY.md`) and the new `project-git-workflow.md` are in English. Older memories remain Korean.
