# 2026-05-20 — dashboard (Onda)

## What was done

- **Rebuilt `ProjectDashboard`** in `frontend/src/pages/DashboardPage.tsx` on `feature/dashboard` branch.
- Replaced the "No mapping targets yet" empty state with a per-TO-BE-table row view.
  Columns: ● readiness dot / TO-BE TABLE / AS-IS SOURCE / COLUMN COVERAGE (progress bar + `N/M`) / ISSUES (`N unmapped` or `—`) / READINESS badge / `›` chevron.
  Schema name is rendered as a dim prefix (`<dim>public.</dim>card`); omitted when `schemaName` is empty.
- KPI strip values now use prototype tones (READY green, REVIEW amber, UNBOUND red). SNAPSHOT cell colors itself green when an approved snapshot exists, otherwise idle. LAST RUN stays idle until execution engine ships.
- **Removed**: TOOL INFO dev card, the per-row APPROVAL column (project-level info is already in the KPI SNAPSHOT cell), and the dead `Open Versions` / `Go to Execution` buttons. Also removed unused `Kv` helper and stale styles.
- Row is now clickable (cursor + hover); click handler is a no-op marked `// TODO: mapping 画面ができたら navigate(...)` — wire it up when the mapping page ships.
- **React 18 + zustand crash fix**: a selector that returned `.filter(...)` from the store triggered React's tearing-detection on every render (white screen in Chrome, OK in VS Code Simple Browser because that environment didn't reach `ProjectDashboard`). See the new ONBOARDING §16 for the rule.

## What the next person should do

1. **Verify in real Chrome** (not just VS Code Simple Browser) once a project has both AS-IS and TO-BE DDL imported. The dashboard must show one row per TO-BE table, all currently `UNBOUND` until the mapping layer lands.
2. **Mapping layer (V7+ Flyway + APIs + UI)** is the unlock for `ready` / `review` states to actually appear. The dashboard reads `mappedColumns` (currently hard-coded to 0); switch this to real mapping data when the table exists.
3. **Wire the row click to mapping** — grep `TODO: mapping 画面` in `DashboardPage.tsx` and replace the no-op `onClick` with `navigate(\`/mapping/${r.tableId}\`)` (or whatever the final route is).

## Pitfalls / decision history

- **Approval is project-level, not per-table** (no `snapshot_table` join table yet), so per-row display was redundant. We kept the project-level value only in the KPI strip. When per-table snapshot association exists, re-add the column.
- **AS-IS SOURCE is hard-coded `(no source)`** — placeholder until the binding table (per ONBOARDING §9) exists.
- A `?mock=1` URL flag was used during development to spread `ready` / `review` / `unbound` across rows for visual QA; it has been removed.
- **Rehearsal-failure rollback surface** (rehearsal → analysis with error context) was discussed and deliberately deferred — needs execution engine + error data model first.

## Intentionally not done

- Mapping data layer — separate work.
- Run-history wiring for the `LAST RUN` KPI tile.
- Per-table snapshot association — needs new `snapshot_table` (or equivalent) Flyway migration.
- New columns suggested but rejected for now: LOGICAL NAME, PK PRESENT, TABLE COMMENT.
- ONBOARDING §15.8 still lists `TO-BE schema tree in ProjectDashboard` as deferred — that refers to a tree view, which is a different shape from the flat row list we built. Left as-is.
