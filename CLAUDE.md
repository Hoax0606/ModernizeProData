# Modernize Pro Data — AI context

This file ensures every AI session starts from the same baseline when our 5-person team (3 BE / 2 FE) works on separate PCs. When you start a new session, **read this file first**, then read the most recent file under `docs/handoff/`.

## Project in one line
Data migration tool for the Japanese financial sector. Customer sites are fully air-gapped (no network bridge, no HQ telemetry); HQ ↔ field transfers happen by hand via USB. PoC 1st-round deadline: **2026-05-31**.

## Stack

### Backend (BE)
- Java + Spring Boot 3 + Spring Batch
- JPA / Hibernate, meta DB is PostgreSQL 18
- Flyway migrations (`V{N}__{name}.sql`)
- Arrow Java, DuckDB JDBC (the tool's embedded AS-IS DB)
- PostgreSQL `COPY` via `PgCopyManager`
- Build: Maven (`./mvnw` wrapper, `pom.xml`)
- IDE: **VSCode + Extension Pack for Java** (not IntelliJ)
- Deployment: jpackage — no K8s during PoC
- Testing: Testcontainers + Flyway. **H2 forbidden** (too different from production PG)

### Frontend (FE)
- React 18 + Vite + TypeScript
- State management: zustand (persist middleware)
- Routing: react-router-dom v6
- Server communication: in-house `api/client.ts` (fetch wrapper)
- i18n: in-house (`src/i18n/{ko,ja,en}.ts` + `useT` hook)

### Operational model
- **Coordinator (HQ)** ↔ **Worker (field)** split. Worker talks to Coordinator over REST + WebSocket only. No direct meta-DB access. Registration via URL + token.
- Installer bundles PG 18; if an existing PG is present, the user picks "use existing" or "install separate".

## Directory map

```
ModernizeProData/
├── backend/                    # Spring Boot
│   └── src/main/
│       ├── java/com/ksinfo/modernize_pro_data/
│       │   ├── common/         # config, dto, exception
│       │   └── coordinator/    # api, auth, site, ddl, ...
│       │                       # ddl/ = DDL import (entity / repository / service / parser)
│       └── resources/
│           ├── application.yml
│           └── db/migration/   # V{N}__*.sql — Flyway
└── frontend/                   # React + Vite
    └── src/
        ├── api/                # client + endpoint wrappers
        ├── components/         # reusable components / modals
        ├── i18n/               # ko/ja/en
        ├── layout/             # AppShell (sidebar, topbar, tabbar)
        ├── pages/              # page components
        ├── routes/             # ProtectedRoute
        └── store/              # zustand stores

Prototype/                       # HTML/JSX prototype — reference only. Do not modify.
docs/                            # manuals, architecture, handoff (.docx/.pdf are ignored)
```

## Conventions

### i18n policy (FE)
- `menu.*` / `tab.*` / `*.title` / `*.status.*` → **identical English across ko/ja/en**
- `*.subtitle` / `*.desc` / `*.hint` / error messages / placeholders → translated per language
- The user-issuing/management screen is always called **"User Management"**. Internal variable names (`ClusterAdminModal`, etc.) may stay as-is.

### Backend migrations
- New tables/columns must go through Flyway `V{N}__name.sql`. Do not rely on Hibernate auto-DDL by just editing entities.
- Existing pattern: `V4__sites_projects.sql` · `V5__project_run_status.sql` · `V6__snapshots.sql`.

### Phase model
- 9 phases: `planning · analysis · test · sign-off · rehearsal · ready · cutover · hypercare · done`
- `cutover` can run **only in production environments**.
- Two snapshot types: mapping snapshot and cutover snapshot.
- `runStatus` (`idle | running | completed`) is a sub-status of test/rehearsal/cutover.

### Git workflow
- Commit format: Conventional Commits — `<type>(<scope>): <description>`.
- **Never resolve merge conflicts in the GitHub web UI.** PR author resolves locally; runs `npx tsc --noEmit` and build before pushing.
- For import-line conflicts, always take the **union** of both sides — never pick one side.

### Response style (user preference)
- When discussing tool direction, **do not split answers into V1/V2/Phase tiers**. Present one recommended approach.
- Without an explicit request, **do not create new .md files**. Do not correct outdated existing docs without a user request either.
- Weekly work reports should be in a **KakaoTalk-friendly short form** — 3–5 bullets, Korean, no emojis.

## Local development

### Backend
```powershell
# First run: bring up the PG 18 container (compose.yaml is OFF by default)
docker compose up -d postgres   # port 5433

# Run the app
$env:SPRING_PROFILES_ACTIVE = "local"
cd ModernizeProData/backend
./mvnw spring-boot:run
```
- Local config: `application-local.yml` (gitignored — each developer writes their own).
- Meta DB: `localhost:5433`, db `modernize`, user `modernize`.

### Frontend
```powershell
cd ModernizeProData/frontend
npm install
npm run dev   # Vite proxy /api → localhost:8080
```

### Type check
```powershell
cd ModernizeProData/frontend; npx tsc --noEmit
```

## Domain glossary

| Term | Meaning |
|---|---|
| Coordinator | HQ management node. Owns the meta DB. The single point of authority. |
| Worker | Execution node installed on the air-gapped field network. Communicates over REST/WS only. |
| Site | One operating environment of one customer. Holds AS-IS / TO-BE / environment label (dev/test/stg/prod). |
| Project | A migration unit inside a Site. One AS-IS → TO-BE mapping job. |
| Phase | A Project's progression phase (the 9 above). |
| Snapshot | The approval unit for a mapping definition. Two kinds: mapping snapshot, cutover snapshot. |
| Cutover | Real-production cutover. Only in production environment, requires an approved snapshot. |
| Rehearsal | Dry-run. Validates cutover scenarios in the test environment. |
| AS-IS DB (tool-embedded) | The tool ingests the ops team's nightly CSV extracts into DuckDB — no direct connection to the source DB. |

## Recommended session-start workflow

1. Read this file (CLAUDE.md) once at the start.
2. Read the most recent file under `docs/handoff/` (most recent = filename sorted descending).
3. Before starting work, confirm with the user in one line: "The latest handoff was X — should I continue from there?"
4. When work is done, write a note for the next person via the `/handoff` slash command.

## External references (do not put here)

- Personal preferences / memory live in `~/.claude/projects/.../memory/` (per developer, separate).
- Detailed context for in-progress work goes to `docs/handoff/YYYY-MM-DD-{slug}.md`.
- Slash commands live in `.claude/commands/*.md`.
- Accumulated design decisions (pipeline, rule engine, SPIs, etc.) live in `ONBOARDING.md` at the repo root.
