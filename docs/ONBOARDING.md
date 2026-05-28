# Modernize Pro Data — Team Onboarding (Pipeline & Rule Engine)

A team-shared document summarizing the accumulated design decisions for the data migration pipeline and rule engine. New team members or new AI sessions should read this alongside `CLAUDE.md` to quickly catch up on design intent and pitfalls.

**Prerequisite** — The one-line project intro, tech stack, directory map, and domain glossary live in the repo-root `CLAUDE.md`. This document covers the design details not (or only briefly) covered there.

Updated: 2026-05-22

---

## 1. Phase / Stage Model (finalized 2026-05-15)

### 1.1 9-stage Phase

```
planning → analysis → test → sign-off → rehearsal → ready → cutover → hypercare → done
```

### 1.2 4-stage Stage (environment label)

```
dev → test → staging → production
```

- `dev` is always first (order is fixed).
- **The `cutover` phase can only be executed in Stage=production**. A production guard in the code is mandatory.

### 1.3 Two Snapshot kinds + approval flow

| Snapshot | Phase transition on approval |
|---|---|
| mapping snapshot | → sign-off |
| cutover snapshot | → ready |

- **Phase transitions happen only at approve time**. They do not change at request time.

### 1.4 runStatus sub-status (test / rehearsal / cutover only)

| Value | Meaning | UI |
|---|---|---|
| `idle` | Before start | Default |
| `running` | In progress | Progress indicator |
| `completed` | Finished | **Gray badge** (UI convention) |

---

## 2. Pipeline — 4 Stages (finalized 2026-05-18)

```
Source Reader SPI → DuckDB Appender → Rule Engine (SQL + UDF) → Loader Adapter SPI
                       ↓ writes              ↓ writes
                     CP1 Raw Parquet        CP2 Transformed Parquet
                     (checkpoint ①)         (checkpoint ② — rehearsal only)
```

Each stage is abstracted via SPI so adapters can be swapped based on input format and TO-BE DB type. **Single-writer policy** — DuckDB instances are independent per worker.

### 2.1 Two checkpoints

- **CP1** = one Parquet per source file (`cp1_emp.parquet`, `cp1_dept.parquet`, …). All columns are VARCHAR. **JOIN / type conversion is strictly forbidden** — original data must be preserved.
- **CP2** = Parquet after JOIN/UNION + transform-rule application. Generated only for rehearsal; skipped for cutover (speed priority).

### 2.2 Four cases

| Case | Input | Phase | CP2 | Notes |
|---|---|---|---|---|
| 1 | CSV | rehearsal | O | Default |
| 2 | CSV | cutover | X | Rule Engine output → Loader directly |
| 3 | Non-CSV (EBCDIC etc.) | rehearsal | O | Source Reader unpacks |
| 4 | Non-CSV | cutover | X | If no JOIN, bypass DuckDB (Java direct). If JOIN needed, fall back to case 2 |

### 2.3 Restart matrix

| Failure point | Restart from |
|---|---|
| Source / CP1 generation | Beginning |
| Rule Engine | CP1 |
| Rehearsal load | CP2 |
| Cutover load | CP1 (no CP2) |

### 2.4 Directories

```
data/
├── incoming/             ← AS-IS files arrive here
├── staging/cp1/          ← Raw Parquet
├── staging/cp2/          ← Transformed Parquet
├── staging/quarantine/   ← UDF NULL rows
├── drivers/              ← TO-BE JDBC JARs (site-specific)
└── runs/                 ← Run artifacts
```

---

## 3. Rule Engine — DuckDB SQL + Java UDF

The transformation engine for the CP1 → CP2 stage. **A thin rule engine built on top of DuckDB.**

### 3.1 Processing order (within one SQL, strictly this sequence)

1. **JOIN / UNION** — between CP1 Parquets. Keyed on the original keys (e.g., `dept_code`).
2. **Apply transform rules** — SQL (`CAST`, `CASE WHEN`) + Java UDFs.
3. **Quarantine split** — UDF-NULL rows go to a separate COPY.

**Why JOIN comes before transformation**: If you transform first, the original keys are gone and JOINs may produce mismatches.

### 3.2 SQL pattern

```sql
-- Good rows → CP2
COPY (
    SELECT
        apply_scale(e.salary_raw, 2)    AS salary,
        convert_era(e.hire_date_raw)    AS hire_date,
        assign_seq(e.dept_code)         AS emp_seq,
        d.dept_name
    FROM read_parquet('cp1_emp.parquet') e
    JOIN read_parquet('cp1_dept.parquet') d ON e.dept_code = d.dept_code
    WHERE apply_scale(e.salary_raw, 2) IS NOT NULL
      AND convert_era(e.hire_date_raw) IS NOT NULL
) TO 'cp2_001.parquet' (FORMAT PARQUET);

-- Failed rows → Quarantine (same JOIN structure, inverted WHERE)
COPY (
    SELECT e.*, d.dept_name, 'UDF conversion failed' AS reason
    FROM read_parquet('cp1_emp.parquet') e
    JOIN read_parquet('cp1_dept.parquet') d ON e.dept_code = d.dept_code
    WHERE apply_scale(e.salary_raw, 2) IS NULL
       OR convert_era(e.hire_date_raw) IS NULL
) TO 'quarantine.parquet' (FORMAT PARQUET);
```

### 3.3 Registered UDFs (initial 3)

| Name | Input | Output | Type | Notes |
|---|---|---|---|---|
| `apply_scale` | VARCHAR, int | BigDecimal | scalar | COMP-3 unpack then apply decimal point. Fail → null. |
| `convert_era` | VARCHAR | LocalDate | vectorized (2048 rows) | Japanese era ("令和8年5月16日"). Fail → null. |
| `assign_seq` | VARCHAR | long | scalar + **withVolatile() required** | Sequence numbering. Without `withVolatile()`, DuckDB caches results. |

### 3.4 Four UDF pitfalls (most commonly forgotten)

1. **Always design `null` input → `null` output**. Missing this causes NPE and fails the whole job.
2. **`withVolatile()`** — required for any UDF that returns different values per call.
3. **Connection-bound** — call `registerAllUdfs()` for each new Connection.
4. **Vectorized UDF's `DuckDBDataChunkReader` is valid only inside the callback** — never save it for use after the callback returns.

### 3.5 Chunked processing (large volumes)

- Iterate CP1 in chunks via LIMIT/OFFSET.
- Reuse a temp table with TRUNCATE (CREATE once).
- Per chunk: Appender insert → `COPY TO cp2_NNN.parquet` → TRUNCATE.
- Final load: read everything with `read_parquet(['cp2_*.parquet'])`.
- Large JOINs: keep the small table fully resident, chunk the large one.

---

## 4. Rule Input Model — 3-tier Ladder (finalized 2026-05-19)

How users specify column-level transform rules. **Auto → Wizard → Free SQL**, a 3-tier ladder.

### 4.1 Tier 1 — Type-based auto mapping

The engine inspects AS-IS DDL + TO-BE DDL and picks defaults.

| AS-IS | TO-BE | Auto result |
|---|---|---|
| Oracle `CHAR(10)` | PG `VARCHAR(10)` | `strategy=copy` |
| Oracle `CHAR(10)` | PG `VARCHAR(8)` | `strategy=cast` + danger flag (length shrink) |
| Oracle `NUMBER(10,2)` | PG `NUMERIC(10,2)` | `strategy=copy` |
| Oracle `DATE` | PG `TIMESTAMP` | `strategy=copy` |
| Oracle `NUMBER` | PG `INTEGER` | `strategy=cast` + overflow danger flag |
| Oracle `BLOB` | PG `BYTEA` | `strategy=copy` |

### 4.2 Tier 2 — Structured rule (strategy + params)

When auto doesn't fit or the user overrides, pick from a dropdown.

| strategy | Compiled output (example) |
|---|---|
| `copy` | `src.col AS tgt_col` |
| `constant` | `'X' AS tgt_col` |
| `cast` | `CAST(src.col AS T) AS tgt_col` |
| `case_when` | `CASE src.col WHEN ... END AS tgt_col` |
| `comp3_decimal` | `apply_scale(src.col_raw, 2) AS tgt_col` |
| `era_to_date` | `convert_era(src.col_raw) AS tgt_col` |
| `seq` | `assign_seq(src.key) AS tgt_col` |
| `lookup` | `lkp.v AS tgt_col` + auto LEFT JOIN |
| `unmapped` | (not compiled — preflight blocks) |
| `custom_expr` | User input verbatim |

### 4.3 Tier 3 — Free SQL (`custom_expr`)

The 1–5% of cases that can't be expressed via tiers 1 or 2. Users type a DuckDB SQL fragment directly.

### 4.4 Core rule — UDFs are strategy-path only

**Calling a UDF (e.g. `apply_scale`) directly inside `custom_expr` is forbidden.** All UDFs must be wrapped by a strategy.

Reasons:

1. Avoid the migration hell when a UDF signature changes.
2. During sign-off audit, `SELECT strategy` alone reveals all transformations used.
3. New transformations must go through code review + tests as a strategy (audit / control).

Introducing a new UDF = backend code change (add a compiler branch). In the PoC scope the variety of transforms is limited, so the cost is small.

### 4.5 `column_override` schema (planned)

```
strategy        enum
params          jsonb
compiled_expr   text   -- filled by the engine (user input only when custom_expr)
source          enum   -- auto | manual (tier 1 vs tier 2/3)
```

---

## 5. Cases DuckDB Can't Solve — Escape Ladder

### 5.1 Rung 1 — Add a new UDF (90%+)

When people say "DuckDB can't do this," what they usually mean is "DuckDB's standard library doesn't have this function." → Add a new Java UDF. Same pattern.

Realistic candidates:

- In-house AES encryption (key wheel policy)
- Certified Java library calls (e.g., `KsBankCheckDigit.validate()`)
- MeCab morphological analysis then transform
- Company-standard normalization algorithms

### 5.2 Rung 2 — Java-only table mode (1–2%)

Cases where even a UDF doesn't fit (stateful, multi-pass, certified row-by-row libraries). **Bypass DuckDB for that one table only**:

```
[normal]    Source Reader → DuckDB Appender → Rule Engine → Loader
[dedicated] Source Reader → Java handler → Loader
```

Per-table flag `engine: duckdb | java`. The snapshot freezes the Java class name + version → guarantees deterministic replay.

**Cost**: You give up DuckDB's vectorized parallel processing. Use only when truly stuck.

---

## 6. Mapping Snapshot — Audit & Reproducibility

Approved mappings **freeze the `compiled_expr`** (not just `params`).

Reason: even if the engine / UDF is upgraded, the *meaning* of a snapshot already signed-off must not change — this would be a Japanese-finance audit violation.

Flow:

```
User edits rule
  → Engine refills compiled_expr (column_override)
  → User clicks Approve
  → compiled_expr values are copied into mapping_snapshot.payload_json = frozen
  → Subsequent runs use only the frozen SQL in the snapshot (never re-reads column_override)
```

Jargon: **deterministic replay**, **immutable snapshot**.

---

## 7. Source Reader SPI

| Adapter | Behavior |
|---|---|
| `CsvReaderAdapter` | Delegates to DuckDB `read_csv()`. Shift-JIS via `encoding='shift_jis'` (encodings extension). |
| `EbcdicReaderAdapter` | FileInputStream in binary mode + COMP-3 nibble math (high/low nibble, sign in the final nibble `0xC`=positive, `0xD`=negative) + EBCDIC → UTF-8. |
| `FixedWidthReaderAdapter` | Record-length + per-column offset/length. |

Air-gapped sites: the DuckDB encodings extension files must be bundled with the installer.

---

## 8. Loader Adapter SPI

| Adapter | TO-BE | Method |
|---|---|---|
| `PostgresLoaderAdapter` | PostgreSQL | `COPY FROM STDIN` (`CopyManager`) |
| `OracleLoaderAdapter` | Oracle | OCI Direct Path |
| `MySqlLoaderAdapter` | MySQL | JDBC + `reWriteBatchedInserts=true` |
| `SqlServerLoaderAdapter` | SQL Server | BulkCopy (TDS) |
| `JdbcFallbackAdapter` | Anything else | Plain JDBC batched INSERT |

Selection: `AdapterFactory` picks one based on `driverId`.

TO-BE JDBC driver JARs live in `data/drivers/` per site. Loaded via dynamic ClassLoader.

---

## 9. Meta DB — Additional Tables (Flyway V7 onward)

On top of the existing `site` / `project` (V4–V6):

| Table | Purpose |
|---|---|
| `ddl_imports` (V7) | History of AS-IS / TO-BE DDL file imports (filename, hash, side, table_count, …) |
| `ddl_tables` (V7) | Tables extracted from imported DDL (schema_name, physical_name, logical_name, side, …) |
| `ddl_columns` (V7) | Columns within a `ddl_tables` row (physical_name, logical_name, data_type, length, precision, scale, nullable, pk_order, default_value, comment) |
| `connection` | TO-BE DB JDBC credentials (AES-GCM encrypted) |
| `parsing_source` | AS-IS file metadata (encoding, delimiter, adapter kind) |
| `asis_db` | DuckDB store metadata (worker-scoped identifier) |
| `schema_diff` | Mapping definition per TO-BE table (column diffs + rule header) |
| `column_override` | Per-column transformation rules (strategy, params, compiled_expr) |
| `binding_source` | JOIN / UNION source bindings (PRIMARY / JOIN / UNION) |
| `mapping_snapshot` | Frozen approved mappings (`payload_json`) |
| `migration_run` | Run history |
| `run_quarantine` | Quarantined-row log (run_id, stage, severity, reason, …) |
| `audit_log` | Change history |

**Rule**: never let Hibernate auto-DDL create tables. Every new table / column must come from a Flyway `V{N}__*.sql`.

---

## 10. Coordinator / Worker Operating Model

- **Worker → Coordinator** communication: REST + WebSocket only. **No direct PG JDBC connection from Workers, ever.**
- **Meta PG bind**: `127.0.0.1` only — never exposed externally. Only the Coordinator process connects.

### 10.1 Worker registration flow

1. After Coordinator install, the UI shows:
   - Coordinator URL (e.g., `http://10.20.30.40:8080`)
   - Worker registration token (e.g., `WK-7HQ3-2X5L-8MNP`)
2. On Worker install, the operator enters both values → Worker calls the Coordinator API → token is verified → node is registered.
3. Token format: UUID-derived + short 4-4-4 hex easy for a human to retype.

### 10.2 Communication asymmetry

| Direction | Channel | Purpose |
|---|---|---|
| Coordinator → Worker | WebSocket push | Task instructions |
| Worker → Coordinator | REST | Result reports, status updates |

### 10.3 Heartbeat

- Worker pings Coordinator every 30 seconds.
- After a configured silence, the node is marked inactive.

---

## 11. Installer Policy

- **Bundled PG version**: PostgreSQL (※ see Open Issue #6 — docs disagree between 16 and 18, being reconciled).
- **Existing PG**: present the user with "use existing / install a separate instance."

### 11.1 Installer responsibilities (order)

1. Detect whether PG is installed.
2. If not, auto-install bundled PG (register as Windows Service, separate port / data directory / OS account).
3. If yes, show the choice.
4. Create the initial DB / account → apply Flyway migrations automatically.
5. After Coordinator startup, display the **URL + Worker registration token** in the UI.

### 11.2 Isolation rules

- **Must be isolated from TO-BE PG**: even on the same server, use a different port, different data directory, and different OS account.
- The installer itself: jpackage or WiX/NSIS (TBD).

### 11.3 Building the installer (current state)

Lives under `ModernizeProData/installer/`. Three-step pipeline produces a single `setup.exe` (7-Zip SFX) that bundles a C# language dispatcher and three per-language .msi payloads. End users run `setup.exe`; the dispatcher reads their language pick and invokes the matching .msi via `msiexec /i`.

**Prerequisites on the build host**: JDK 21+ on PATH (ships `jpackage`), WiX Toolset 3.14 under `C:\Program Files (x86)\WiX Toolset v3.14\bin\`, Node 18+ with npm, PowerShell 5.1+.

```powershell
cd ModernizeProData\installer
.\build.ps1 -Language all       # dist\ModernizeProData-{en,ko,ja}-1.0.0.msi (~274 MB each)
.\launcher\build-launcher.ps1   # dist\Launcher.exe (~200 KB)
.\package-sfx.ps1               # dist\ModernizeProData-1.0.0-setup.exe (~818 MB)
```

Each .msi is jpackage-produced with `--win-per-user-install` so the install goes into `%LOCALAPPDATA%\ModernizeProData\` with no UAC prompt. The three .msi files differ only in `JpProductLanguage` / bundled `MsiInstallerStrings_<lang>.wxl`; runtime image, fat jar and React bundle are identical across them.

**What the installer asks**: Role (Coordinator / Worker / Standalone), Language, and a read-only display of the Hardware ID. Coordinator URL, license file and admin credentials are entered in-app on first boot, not by the installer.

**First-boot flow**:
- **Coordinator / Standalone**: WebView opens the React UI. If no license is loaded, `App.tsx`'s `/api/v1/health/info` probe sees `licenseStatus=MISSING` and routes to `/license-setup`. Master picks the .lic file through a JavaFX FileChooser bridge (see 11.4), the file is uploaded, then the master signs in.
- **Worker**: A JavaFX form takes the Coordinator URL, runs an anonymous `/api/v1/health` reachability probe, then asks username + password. On successful login the JWT is handed to the WebView via `bootstrap_token` / `bootstrap_user` URL params (read by `frontend/src/bootstrap-from-url.ts`) so the user is not asked to sign in a second time inside the WebView.

### 11.4 JavaFX 21 WebView quirks (worked around in code)

JavaFX 21's bundled WebKit has three quirks that surface only inside the packaged app (Chromium under `npm run dev` does not exhibit any of them). All three have stable workarounds; if you add a new endpoint or screen, reuse the same patterns.

- **`window.location.replace()` and `window.location.href = …` change the URL but do NOT reload the page.** React stays mounted on the previous route forever, so the user is silently stuck. *Fix*: never call them from React — use `useNavigate()` from react-router. The 403/`LICENSE_MISSING` interceptor in `api/client.ts` uses `history.replaceState` + a manual `popstate` event.
- **`<input type="file">` renders, but clicking it never opens a native picker.** *Fix*: a sentinel-prompt bridge — React calls `window.prompt('OPEN_LICENSE_FILE')`, the JavaFX prompt handler in `Launcher.wireJsDialogs` intercepts that exact string, shows a real `FileChooser`, and returns the chosen file's contents as the prompt return value. Reuse this pattern for any future file-upload UI.
- **`multipart/form-data` POST NPEs inside `HTTP2Loader.<init>`.** *Fix*: add a `text/plain` (or `application/octet-stream` / `application/json`) body variant on the same endpoint. `LicenseController.initial-setup` ships both — the React UI uses the raw-body path; the multipart path is kept for callers outside the WebView.

If you add a new file-upload endpoint, either reuse the raw-body pattern or explicitly test the multipart path *inside the packaged WebView*, not just in `npm run dev`.

---

## 12. Test Strategy (Backend-mandatory)

### 12.1 No H2

- Removed from all dependencies. Not even in `test` scope.
- Reason: H2 PG-mode differs subtly from real PG (JSONB, ARRAY, functions, …). "Tests pass but prod breaks" incidents are unacceptable in Japanese finance.

### 12.2 Testcontainers + @ServiceConnection (Spring Boot 3.1+)

- A `TestcontainersConfiguration` bean returns `PostgreSQLContainer<>("postgres:16-alpine")`.
- Standard integration-test pattern: `@SpringBootTest` + `@Import(TestcontainersConfiguration.class)`.
- **Docker is required on every developer machine** (team policy 2026-05-14). Without Docker, automated tests cannot run.

### 12.3 Flyway is the single source for schema

- Even Spring Batch's own scripts are copied into `V1__spring_batch_schema.sql`.
- `spring.batch.jdbc.initialize-schema: never`.
- Hibernate auto-DDL is absolutely forbidden. Every new entity ships with a Flyway `V{N}__*.sql`.

### 12.4 Test-weight guidance

| Category | Share | Examples |
|---|---|---|
| PG required (Testcontainers) | 20–30% | JPA Repository, integration tests, migration validation, audit log |
| PG not required | 70–80% | Transform engine (DuckDB embedded), mapping logic, auth logic, DTO conversion |

### 12.5 Shared internal PG is unsuitable for auto-tests

- Test isolation, concurrency, and CI access are all problematic.
- It's fine for `mvn spring-boot:run` dev sessions where you click around the tool.

---

## 13. 12-factor Deployment Principles

**Current deployment model** = jpackage standalone + installer-bundled PG. K8s/Helm is too costly at this stage (Japanese-finance procurement + air-gapped media transport burdens).

That said, keep 12-factor habits so a future move is cheap:

### 13.1 Externally injected items

| Item | Method |
|---|---|
| Configuration | Env vars / external files (no hardcoding) |
| Meta DB connection | host/port/user/pass via env vars |
| License (.lic) path | Path injected externally |
| Coordinator URL (for Workers) | Injected externally |
| Data directory | Injected externally |

### 13.2 Logs

- **stdout only**. No log files.

### 13.3 No deployment-shape-dependent code

- jpackage → docker → K8s: the goal is zero code changes when moving between targets.
- `docker-compose` is **dev/test only**, never production deployment.

### 13.4 K8s is a second pass

- Hook it on as an extra channel only when a customer interview surfaces a concrete "we have a K8s cluster, we want it deployed there" request.

---

## 14. Open Issues (need a meeting)

1. **Finalize the `strategy` enum list** — 4.2 is the candidate set. Add / merge / remove?
2. **Formalize the no-UDF-in-custom_expr policy** — section 4.4. Needs sign-off.
3. **`unmapped` as a real strategy vs. absent row** — trade-off between progress-calc simplicity and table size.
4. **`compile-preview` endpoint (DuckDB `EXPLAIN` for design-time check)** — include in PoC scope?
5. **`drop` / `ignore` strategies vs. `unmapped`** — keep them distinct?
6. **PG version mismatch across docs** — `CLAUDE.md` says "PG 18 bundled", memory and `compose.yaml` say PG 16. Current guess: dev local = PG 18, installer-bundled = PG 16 (stability). Needs cleanup.

---

## 15. DDL Import — AS-IS / TO-BE Schema Capture (added 2026-05-19)

The feature that lets the tool ingest AS-IS / TO-BE database DDL files and persist their parsed schema into the meta DB. It is the foundation for the mapping editor, preflight checks, and rule compilation.

### 15.1 Data model (Flyway V7 + V9)

- `ddl_imports` — one row per upload (filename, sha-256 hash, side, dialect, table_count, column_count, imported_by, imported_at). A `side` column (`'asis' | 'tobe'`) distinguishes the two ladders inside the same three tables.
- `ddl_tables` — schema_name / physical_name / **logical_name** / table_comment / ordinal. UNIQUE `(project_id, side, schema_name, physical_name)`.
- `ddl_columns` — ordinal / physical_name / **logical_name** / data_type_raw (the raw DDL string, e.g. `NUMBER(10,2)`, `VARCHAR2(20 BYTE)`) / data_type / length / precision / scale / nullable / pk_order / default_value / column_comment.
- `projects.tobe_table_count` (added in V9) — counter of imported TO-BE tables. The existing `projects.table_count` is now interpreted as the AS-IS counter.
- CASCADE: deleting a `ddl_imports` row drops its `ddl_tables` and `ddl_columns` automatically.

### 15.2 Parser (`coordinator/ddl/parser/OracleDdlParser`)

- Scope: `CREATE TABLE` (with optional schema prefix), `COMMENT ON TABLE`, `COMMENT ON COLUMN`, plus inline `-- …` and `/* … */` comments.
- Logical-name priority: `COMMENT ON COLUMN` > inline comment.
- Ignored: foreign keys, indexes, sequences, triggers, STORAGE / TABLESPACE / PARTITION clauses.
- Tested with 13 unit cases in `OracleDdlParserTest`, including: file-leading comments, multi-table DDL, end-of-line comments belonging to the previous column, composite PK, escaped string literals in comments.
- Known pitfalls documented in the test cases:
  - The statement splitter must strip leading whitespace/comments before checking `startsWith("CREATE")`, otherwise files starting with `-- header` lose their first `CREATE TABLE`.
  - End-of-line comments (`COL TYPE, -- description`) must be attached to the preceding column, not the following one.

### 15.3 Service (`DdlImportService`)

- Single class handles both AS-IS and TO-BE, branching only on the `side` argument (`SIDE_ASIS` / `SIDE_TOBE`).
- Re-import semantics: in a single transaction, delete the existing import for `(project_id, side)` (CASCADE), then insert the new rows.
- After insertion, update `projects.table_count` (AS-IS) or `projects.tobe_table_count` (TO-BE). The delete path resets it to 0.
- Validates `side` and throws `INVALID_SIDE` for anything other than `asis` / `tobe`.

### 15.4 REST API

- `POST   /api/v1/projects/{id}/asis-ddl/import` — multipart upload, one file, max 50 MB, MASTER/ADMIN only.
- `GET    /api/v1/projects/{id}/asis-ddl` — latest import + table/column tree.
- `DELETE /api/v1/projects/{id}/asis-ddl` — drop the imported schema.
- Equivalent `tobe-ddl` endpoints on `TobeDdlController`.

### 15.5 Frontend wiring

- `api/asisDdl.ts`, `api/tobeDdl.ts` — typed clients.
- `store/asisDdl.ts`, `store/tobeDdl.ts` — zustand stores caching the schema per project.
- `components/DdlImportButton.tsx` — `side`-aware import button. Disabled state when already imported.
- `components/DdlSchemaPanel.tsx` — `side`-aware panel. Red outline = not imported, green outline = imported. Inline delete confirmation (UserManagement pattern). Supports `highlight` prop for a 1-second teal pulse + `scrollIntoView`.

### 15.6 UI entry points

- **DashboardPage → `MappingOnboarding`** — shown when `tableCount === 0 || tobeTableCount === 0`. Two buttons (AS-IS / TO-BE); the one already imported is disabled and labelled "imported ✓".
- **SettingsPage → AS-IS / TO-BE sections** — `DdlSchemaPanel` does the full lifecycle: import, view summary, re-import, delete (with confirm bar). Receives `highlight` from `location.state.highlightSide`.
- **AppShell top-right lamps** — AS-IS / TO-BE status lamps colored by import state (green / red). Clicking navigates to `/settings` with `{ state: { highlightSide } }`, which triggers the teal pulse + auto-scroll on the matching panel.

### 15.7 i18n keys

- `asisDdl.*` and `tobeDdl.*` covering button labels, panel summary, error prefixes, inline-confirm pre/post fragments.
- `shell.lamp.{asis,tobe}.{imported,notImported}` for the AppShell lamp tooltips.

### 15.8 Out of scope (intentionally deferred)

- Per-table / per-column viewer modal (`AsisSchemaModal.tsx` was prototyped then dropped — re-implement when there's a concrete use case).
- `column_override` writing and free-SQL `custom_expr` validation. Section 4 already specifies the design.
- TO-BE schema tree in `ProjectDashboard` (the `No mapping targets yet` empty state). Tracked separately.
- DDL drift detection (re-importing already overrides, but no notification when external DDL changes).
- Multi-file upload — one file per project per side.
- Pre-flight schema validation against the AS-IS DB after CSV ingestion. Covered by section 2.

---

## 16. Frontend Pitfalls (added 2026-05-20)

### 16.1 Never return a fresh array/object from a zustand selector

Under React 18, `zustand` uses `useSyncExternalStore` internally. React re-runs
`getSnapshot` on every render to detect tearing. If the selector returns a new
reference each call — typically because of `.filter()`, `.map()`, or an object
literal inline — React decides the store "changed" mid-render and either burns
CPU on infinite re-renders or unmounts the tree (white screen).

Symptom: works in VS Code's Simple Browser (whose localStorage often hasn't
reached the affected page), but a real Chrome window flashes the page and goes
blank a moment later.

Bad:

```ts
const snapshots = useSnapshotsStore((s) => s.snapshots.filter(...));   // ❌
```

Good — pull the raw slice and derive in `useMemo` (or use `useShallow`):

```ts
const all       = useSnapshotsStore((s) => s.snapshots);                 // ✅
const snapshots = useMemo(() => all.filter(...), [all, projectId]);
```

Applies to every zustand store in this repo (`useWorkspaceStore`,
`useSnapshotsStore`, `useUsersStore`, etc.).

### 16.2 Don't validate behavior in VS Code's Simple Browser alone

Simple Browser is convenient but has a different localStorage / cookie state
from the user's actual Chrome session. Some routes (notably
`DashboardPage` → `ProjectDashboard`, which only renders once a site +
project + TO-BE DDL exist) are unreachable in a freshly-opened Simple Browser.
Bugs that surface only past those gates will look fine there. Verify in real
Chrome before declaring "it works."

### 16.3 Global state transitions don't live inside a page-bound effect

The frontend mock run-engine used to mark an `activeRun` as `completed` from
inside `ExecutionPage`'s `useEffect`:

```ts
// ExecutionPage.tsx
useEffect(() => {
  if (computeElapsedMs(activeRun) >= TOTAL_RUN_MS) {
    finishActiveRun(projectId);
    setProjectRunStatus(projectId, 'completed');
  }
}, [tick, activeRun, projectId]);
```

This worked while the user stayed on `ExecutionPage`, but if they navigated
away mid-run (Dashboard, AllProjects, etc.), the page unmounted and no one
detected the completion. The sidebar `phase chip` for `test` / `rehearsal`
stayed colored ("running" variant) until the user returned to `ExecutionPage`.

Fix: any state transition that has to fire regardless of route belongs in
`AppShell.tsx` (always mounted), or in a zustand `subscribe` callback. The
current implementation polls `useExecutionPreflightStore.byProject` every
500 ms from `AppShell` and calls `finishActiveRun` + `setProjectRunStatus`
when elapsed crosses `TOTAL_RUN_MS`. Replace with WS events once the real
backend run engine is wired.

### 16.4 Dashboard mapped-counts: backend rules vs. zustand cache

The per-project Dashboard reads `useMappingEditsStore` (localStorage zustand,
hydrated from backend by `MappingPage` on mount). SiteOverview (AllProjects)
can't rely on that — projects the user hasn't opened in `MappingPage` have
no cached edits — so it fetches `mappingImportApi.listRules(projectId)` per
project in parallel and counts mapped rules itself.

The `mapped` rule definition is shared:

- `strategy === 'null'` or `'default'` → mapped
- `strategy === 'expression'` with non-empty `asisColumn[]` or `transformRule`
  → mapped
- `strategy === 'skip'` → not mapped

When mapping rules → DDL tables, mirror MappingPage's qualified-first /
short-fallback lookup (`{tobeSchema}.{tobeTable}` first, then bare
`{tobeTable}`). Skipping the fallback under-counts when `rules.tobeSchema`
is `null` but DDL `schemaName` is populated (or vice versa).

---

## 17. Scheduler & External Trigger Integration (added 2026-05-24)

Coordinator-side scheduling: internal Quartz nightly trigger + external scheduler
REST/CLI entry. Both gated by a solution-level mutex (only one can be active at
a time).

### 17.1 Architecture

```
                  ┌─ Quartz Nightly Job (internal) ─┐
                  │                                  │
 (Control-M / cron / etc.) ─ REST ──────────────────┼─→ RunService ─→ Spring Batch
                                                     │   (lock + insert run_history
              UI manual run ──────────────────────────┘    + WS dispatch to Worker)
```

Three trigger paths converge on `RunService.startRun()` (single entry point) →
`SELECT FOR UPDATE` on `projects.run_status` for idempotency → insert
`run_history` row → dispatch to Worker via STOMP (`/topic/worker/{workerId}/tasks`).

### 17.2 Internal mode — common vs individual

`solution_settings.internal_mode` is `'common' | 'individual' | NULL`.

- `common` — all projects fire at `solution_settings.internal_common_time`.
- `individual` — each project fires at its own `projects.schedule_start_time`.
- `NULL` — only valid when `internal_enabled = false`. When the toggle goes ON
  the user must explicitly pick a mode; otherwise save is rejected.

Default time on mode selection is `22:00` (pre-filled, editable). FE forces a
hard validation: in `individual` mode, every project must have a `start_time`
or Save is blocked.

`SchedulerInitializer.rescheduleAllNightly()` is called on app startup and on
every Solution Settings change. It deletes all `NIGHTLY_GROUP` triggers and
re-registers based on current `internal_mode`. Incremental diff-rebuild is a
future optimization (see 17.7).

### 17.3 API token auth — register, not generate

Token issuance is **inverted from the original design**: customers generate
tokens on the external scheduler side (Control-M / JP1 / etc.) and **register**
them via UI paste. The tool never generates tokens.

- `api_credentials.token_hash` — SHA-256 hex, used for auth lookup.
- `api_credentials.token_plain` — **stored plaintext** (PoC requirement; see
  17.6 for the security tradeoff).
- `api_credentials.display_prefix` + `display_last4` — for masked display.
- Min token length: 16 chars (4 prefix + 8 hidden + 4 last4).
- Registration revokes the previous default credential automatically.

`ApiTokenAuthFilter` accepts any Bearer token, with these exceptions:

- `WK-…` prefix → defer to `WorkerTokenAuthFilter`
- 3-segment dotted (`x.y.z`) → defer to `JwtAuthFilter` (heuristic)
- Otherwise: SHA-256 the token, look up by hash. Hit → `ROLE_API_CLIENT`.

### 17.4 Phase semantics for runs

`RunService.resolveRunTypeFromPhase()` maps phase → runType:

| Phase | runType | Notes |
|---|---|---|
| `test` | `test` | dry-run test |
| `rehearsal` | `rehearsal` | dry-run rehearsal |
| `ready` | `cutover` | **production cut-over fires here** |
| `cutover` | _(empty)_ | already running — new runs rejected |
| others | _(empty)_ | not eligible |

The `cutover` phase represents an **in-progress** cut-over (not a
"ready-to-cut" state). On completion, the project transitions to `hypercare`.

### 17.5 Trigger source enum

`run_history.trigger_source` is one of `internal` / `external` / `cli` /
`manual`. Names follow UI labels (`Internal scheduler` / `External
integrations`). Legacy `nightly` / `rest` / `manual_ui` rows from earlier
migrations are accepted by the CHECK constraint but never written by current
code.

### 17.6 Security tradeoff — plaintext token storage

`api_credentials.token_plain` stores the registered token in plaintext. This
contradicts the original design principle of hash-only storage but was added
because:

- Users want to view the registered token on different sessions / by different
  master accounts.
- Trigger examples docs in the UI embed the live token for copy-paste.

**Implications for production**:

- A DB leak (backup theft, direct SQL access) immediately compromises the
  scheduler credentials.
- This will likely be flagged in customer security review (FISC / J-SOX /
  PCI-DSS contexts).
- Pre-production deploy: confirm with customer security team, or switch to
  encrypted storage (AES + master key) before going live.

The columns / methods involved carry `⚠ PoC requirement, security tradeoff`
comments for traceability.

### 17.7 Intentionally out of scope (PoC 2nd or later)

- **Quartz incremental rebuild** — current `rescheduleAllNightly()` is full
  rebuild (delete-all + re-register). For high project counts this slows
  startup; switch to diff-based add/remove/modify later.
- **`/runs/all` bulk transaction** — currently a `for` loop calls
  `RunService.startRun()` per project, each in its own `@Transactional`. With
  100+ projects this becomes 100 sequential transactions. Future: bulk insert
  + parallel `ExecutorService`.
- **Token / SolutionSettings cache** — `CredentialService.authenticate()` and
  `SolutionSettingsRepository.get()` hit DB on every request. Adding Spring
  Cache (`@Cacheable` + `@CacheEvict` on update) cuts hot-path DB load.
- **Encrypted token storage** — see 18.6.
- **OSS scheduler vendor verification** — Control-M Workbench / Rundeck /
  Hinemos integration tests not run. Manual verification via Windows Task
  Scheduler + LAN-cross curl was sufficient for PoC.
- **SIEM (syslog) forwarding** — UI field was removed since BE has no syslog
  emitter. Re-add when SIEM integration is a real requirement.

---

## 18. Further Reading
## 17. Site Export — Client-side zip Delivery (added 2026-05-21)

The bulk-export feature that lets a Coordinator user package all artifacts of
a site into a single `.zip` and hand it off (USB stick, email, etc.) to the
review side. Lives on the `All projects` page under the `Site export` tab
(`/site/export`).

### 17.1 Why client-side

The backend `/api/v1/sites/{id}/export` endpoint with Apache POI and signed
ZIP streaming is **not yet built**. To unblock PoC delivery, the entire zip
assembly currently runs in the browser using `jszip` (zip container) and
`exceljs` (real `.xlsx` workbooks). When the backend export job lands, the
frontend will hand the same UX off to a single API call and dispose of the
client-side builders.

`xlsx` (SheetJS) was rejected in favour of `exceljs` because the npm-published
SheetJS version carries two open CVEs (Prototype Pollution, ReDoS). They are
not exploitable in write-only flows like ours, but `npm audit` warnings would
keep reappearing in the financial-grade security review.

### 17.2 Picker categories (4)

| Section | Category | Per-table? | Notes |
|---|---|---|---|
| Artifact formats | Migration (`.sql`) | yes | Currently a 4-line stub with `-- TODO: {tableName}`. Real CREATE TABLE / INDEX / FK / SEQUENCE / GRANT blocks come when backend export job is wired. |
| Artifact formats | Mapping (`.xlsx`) | yes | 1-sheet empty Cover ("Not yet populated") workbook. Real Rules sheet with `Source col / Source type / Target col / Target type / Rule / Status / Note` columns comes when mapping snapshot data is wired. |
| Artifact formats | Validation (`.xlsx`) | yes | 1-sheet empty Cover workbook. Real Checks sheet (`Check / Scope / Expected / Actual / Δ / Verdict / Note`) comes when test/rehearsal/cutover runs land. |
| Documents | Site summary (`.xlsx`) | site-level | **Already works with real data.** Sheets: Cover / Phase mix / All tables / one per project. |

DDL and Pipeline categories were intentionally removed (DDL is the customer-
supplied input, Pipeline is internal runtime config — neither is a customer
deliverable in their own right).

### 17.3 Bundle layout

```
site-export-<site>-YYYY-MM-DD-HHmm.zip
└── site-export-<site>-YYYY-MM-DD-HHmm/            (folder name == zip stem)
    ├── <project>/
    │   ├── migration/tbl_NNN.up.sql
    │   ├── mapping/tbl_NNN.map.xlsx
    │   └── validation/tbl_NNN.report.xlsx
    └── site-summary.xlsx
```

- Korean / Japanese site / project names are preserved as-is (only `\ / : * ? "
  < > |` are sanitised to `_`). Two helpers in `lib/siteExportManifest.ts` —
  `slugify` for ASCII-only IDs (Document IDs etc.) and `pathSafeName` for
  filesystem names that should keep their original characters.
- The zip filename stem and the inner top-level folder name are identical, so
  unpacking several exports side-by-side never collides.

### 17.4 Key files

- `frontend/src/pages/SiteExportPage.tsx` — composes the picker + preview,
  computes `bundleStem` (`site-export-<slug>-<stamp>`) once per render, passes
  it to manifest + zip filename so they stay in sync.
- `frontend/src/components/SiteExportPicker.tsx` — left 300 px column.
  Checkboxes + Download CTA. No total-size display (the old `rand()`-based
  estimate was removed; only `blob.size` after download would be honest, and
  the OS file manager already shows that).
- `frontend/src/components/SiteExportPreview.tsx` — right pane. Two tabs:
  **Site summary** (Excel-style preview of the live workbook) and **Manifest**
  (collapsible per-category file path list, no sizes).
- `frontend/src/lib/siteExportManifest.ts` — the core. `buildManifest` (no
  side effects), `generateZipBundle` (async, returns Blob),
  `buildSiteSummaryWorkbook` (real data), `buildEmptyArtifactWorkbook`
  (1-sheet placeholder Cover for Mapping / Validation), `pathSafeName`,
  `slugify`, `triggerBlobDownload`, `fmtBytes`.

### 17.5 What the next session must do for real data

Before writing builders, agree the JSON shape with backend (the meta DB
already has `mapping_snapshot`, `schema_diff`, `migration_run` — the export
endpoint will pull from there). Suggested shape:

```ts
{ tableName: string;
  mapping?:    { rules:  Array<{ sourceCol; sourceType; targetCol; targetType; ruleExpr; status: 'auto'|'lookup'|'custom'; note }> };
  validation?: { checks: Array<{ check; scope; expected; actual; delta; verdict: 'PASS'|'WARN'|'FAIL'; note }> };
  migration?:  { blocks: Array<{ kind: 'CREATE_TABLE'|'INDEX'|'FK'|'SEQUENCE'|'GRANT'; sql }> };
}
```

Then add three builders in `siteExportManifest.ts` next to the existing
`buildEmptyArtifactWorkbook`:

```ts
function buildMigrationSql(args, data): string
function buildMappingWorkbook(args, data): Promise<ArrayBuffer>
function buildValidationWorkbook(args, data): Promise<ArrayBuffer>
```

`generateZipBundle` already has clean branches per category — point them at
the new builders when data is present, fall through to the empty workbook
otherwise. The infrastructure (manifest, picker, zip assembly, file naming,
download trigger) does **not** need to change.

### 17.6 Pitfalls / decisions worth knowing

- **No fake data, ever.** Several iterations during 2026-05-21 added sample
  mapping / validation rows for meeting demos; all were removed before
  commit. Future demos must use either real backend data or a clearly
  branched demo route — not inline sample arrays.
- **Cover sheet metadata is conservative.** Only Document ID / Issued /
  Author. `Version` and `Classification` were removed because they had no
  data source.
- **Manifest entry has no `size` field.** Pre-download size estimation was
  pseudo-random (`rand()` function) and misled users when the actual zip was
  far smaller. The size display is gone from picker, button, and Manifest
  tab.
- **Excel chrome (title bar / ribbon / formula bar / sheet tabs) is shared
  visually between ArtifactsPage and SiteExportPreview** — keep them in sync
  when adjusting colours / fonts.
- **`/mockup` route and `lib/artifactSamples.ts` are deleted history.** Do
  not resurrect.

### 17.7 Out of scope (intentionally deferred)

- Backend Apache POI `/api/v1/sites/{id}/export` endpoint.
- SHA-256 + GPG signing + audit log entry on download.
- tar.gz bundle option (removed; zip only).
- In-app inline preview of `.sql` / placeholder file contents inside the
  Manifest tab — would need split-view layout; skipped because the workbook
  in Site summary already shows the substantive deliverable.
- Artifacts-page download (the project-scoped sibling of Site export). The
  page currently shows only the empty Excel chrome; its `Download bundle`
  button is disabled. When wired it will reuse `generateZipBundle` with a
  single-project manifest.

---

## 18. Pre-flight Gate — Execution Readiness Checks (rewritten 2026-05-27)

Readiness gate before Execution Start run AND before Versions Request Review.
The two gates share the same check engine but apply different thresholds.

### 18.1 Two gate contexts

| Gate | Where | Threshold |
|---|---|---|
| **Start run** | `ExecutionPage` → RunHeader | pin pinned snapshot + selected tables × every check pass + `runMode !== null` |
| **Request Review** | `VersionsPage` → SnapshotDetailView | cached result exists + **selectedTables covers all DDL TO-BE tables** + every check pass |

Selection can be a subset (partial migration is a real requirement). startrun
allows running that subset. Request Review demands the snapshot proven
end-to-end clean → coverage of the entire DDL is required.

### 18.2 The seven checks

| id | scope | Data source | Pass when |
|---|---|---|---|
| `csv-arrived` | per-table | `site.csvPath` + per-AS-IS file probe (`csv-preview/{name}?limit=1`) | path set + every needed `{asisTable}.csv` (or `{schema}.{table}.csv`) present |
| `ddl-asis` | project | live DDL store | AS-IS DDL imported |
| `ddl-tobe` | project | live DDL store | TO-BE DDL imported |
| `conn-tobe` | project | live BE `tobeDbApi.testConnection` | fields filled + BE returns success |
| `tobe-bindings` | per-table | snapshot.bindings | every selected TO-BE table has ≥1 binding with sources |
| `unmapped-cols` | per-table | snapshot.rules + TO-BE DDL | every column has a rule (`null` / `default` / producing `expression`) or an explicit `skip` rule |
| `asis-unmapped` | **per-AS-IS-table** | snapshot.rules + AS-IS DDL | every column in the AS-IS table is referenced by some rule |

- `project` rows show one inline detail (no expand).
- `per-table` rows are expandable, showing the per-table breakdown.
- `asis-unmapped` keys per-table rows by AS-IS physical name (not TO-BE) so
  the Fix button can navigate to the AS-IS side of MappingPage.

### 18.3 Pin requirement

Execution requires a pinned snapshot. Without one the SnapshotDisplay panel
shows an amber banner, and TableSelector / Pre-flight / Start are all
disabled. Pin eligibility (`isPinEligible`) is enforced per phase — see
`store/snapshots.ts`.

### 18.4 RunMode derivation (`deriveRunMode(phase, env)`)

Mirrors BE `RunService.resolveRunTypeFromPhase`:

| env | phase | runMode |
|---|---|---|
| production | ready | cutover |
| production | other | null (blocked) |
| non-prod | rehearsal | rehearsal |
| non-prod | ready / cutover / hypercare / done | null (blocked — ready run は production 限定) |
| non-prod | planning / analysis / test / sign-off | test |

Phase auto-advance on Start is **forward-only** (e.g., starting a test run
from `planning` advances to `test`; starting a test from `sign-off` does
**not** regress to `test`).

### 18.5 Result cache (per-snapshot)

`store/executionPreflight.byProject[projectId].bySnapshot[snapshotId]` holds
`{ runAt, selectedTables, results }`. This is the **single source of truth**
for both the Execution display and the Versions Request Review gate. The
old project-wide `preflightResults` field has been removed (persist v5).

When the pinned snapshot changes on Execution, the display automatically
switches to that snapshot's cached result (or empty = "not run yet"). No
separate state reset needed.

### 18.6 Fix routing

| Check id | Destination |
|---|---|
| `csv-arrived` | SiteSettings → CSV section (aggregate-only Fix — `fixIsProjectWide: true`) |
| `ddl-asis` / `ddl-tobe` | `/settings` with `state.highlightSide` |
| `conn-tobe` | SiteSettings → TO-BE DB section |
| `tobe-bindings` / `unmapped-cols` | `/mapping` with `state.fixTarget = { kind, table }`. MappingPage matches by qualified name / internalName / physicalName (`tt.short`). |
| `asis-unmapped` | same as above but `kind: 'unmapped-asis'`, table = AS-IS physical name |

### 18.7 Demo modes

- `?demo=preflight` — 7 fail fixture (worst case).
- `?demo=run-fail` — 7 pass fixture, then user can `⚡ Simulate failure` mid-run.

### 18.8 BE concurrency note (workaround in place)

`SiteCsvPreviewController` reads via DuckDB through a shared `DuckDbService`.
Concurrent requests collide with `"Invalid Input Error: Attempting to execute
an unsuccessful or closed pending query result"`. Workaround: FE calls
`csv-preview` **sequentially** (`for...of await`) in `startPreflight` instead
of `Promise.all`. See handoff `2026-05-27-execution-preflight-real.md`.

### 18.9 Decision history

- 8 checks → 7 (`approved-snapshot` removed; snapshot integrity is now
  enforced via the pin-required model + Versions Request Review gate).
- `TableSelector` is intentionally kept to support partial-migration
  scenarios — it limits the run scope (Execution) but does NOT relax the
  Request Review gate.
- `unmapped-cols` covers all columns, not just NOT-NULL no-default ones.
  Rationale: aligns with `DashboardPage` `isMappingRuleMapped` semantics.
- `asis-unmapped` rows are keyed by AS-IS table, contrary to the other
  per-table checks which are keyed by TO-BE table. Required so the Fix
  button can pass the correct table to MappingPage AS-IS side.

### 18.10 Out of scope (deferred)

- BE `POST /api/v1/projects/{id}/preflight/run` — preflight still runs on
  the frontend; only `csv-preview` and `tobe-db/test-connection` call BE.
- `CheckStage` / `ExtractStage` (in dev merge but stubs) — once they write
  to `stage_instances`, preflight can read authoritative completion flags.
- BE `DuckDbService` concurrency safety / connection pool — required to
  drop the FE sequential workaround.
- React style warning (`border` / `borderColor` shorthand mix) in the
  Preflight panel — cosmetic.

---

## 19. Further Reading
## 18. License (Ed25519 .lic verification — finalized 2026-05-22)

### 18.1 Goals

Stop unauthorized use of the tool after the agreed term, without depending on
network reachability (target sites are fully air-gapped). The license is a
signed JSON file (`.lic`) delivered to the site by USB and uploaded through
the in-app UI.

### 18.2 Cryptographic shape

- **Signature**: Ed25519 (java.security built-in, no extra libs).
- **One global keypair**: HQ holds the single `private.pem`; every shipped
  backend binary embeds the matching `public.pem` at build time. New
  customers ≠ new keypair; new keypair = full backend rebuild + redeploy.
- **Public key embed path**: `backend/src/main/resources/license/public.pem` (same filename the issuer produces — drop the file as-is, no rename).
- **Fingerprint** = first 16 bytes of SHA-256 over the public key DER, hex
  encoded. Stored in each `.lic` as `publicKeyFp` so corruption / wrong-key
  uploads can be diagnosed quickly.

### 18.3 .lic file format

```json
{
  "alg": "Ed25519",
  "payload": {
    "v": 1,
    "licenseId": "MPD-2026-05-22-kdb-bank",
    "customer": "KDB Bank",
    "siteId": "kdb-prod-2026",
    "edition": "standard",
    "features": [],
    "issuedAt": "2026-05-22",
    "expiresAt": "2027-05-22",
    "graceDays": 14,
    "publicKeyFp": "a3f1...c920"
  },
  "signature": "base64(ed25519-sig-over-jackson-bytes(payload))"
}
```

- `edition` is currently always `"standard"` (no tiering yet).
- `features` is currently always `[]` — feature gating was implemented and
  then removed because there is no second tier. The field is preserved to
  keep the JSON shape stable in case tiers are introduced later.

### 18.4 Lifecycle stages (`LicenseStatus`)

```
issued                expires           expires+grace      expires+grace+15d
   │                     │                     │                  │
   │ ACTIVE      ──►    │   IN_GRACE   ──►    │   READ_ONLY  ──►  │  EXPIRED
   │ (60d before expiry: EXPIRING — banner, no functional change)
```

| Status      | Behavior                                                  |
|-------------|-----------------------------------------------------------|
| `ACTIVE`    | Normal.                                                   |
| `EXPIRING`  | Amber banner; ≤60 days remaining.                         |
| `IN_GRACE`  | Amber banner; past expiry, still within `graceDays`.      |
| `READ_ONLY` | Write APIs return 403 `LICENSE_READ_ONLY`. 15-day window. |
| `EXPIRED`   | All non-whitelisted APIs return 403.                      |
| `MISSING`   | No `.lic` ever uploaded — same blocking as EXPIRED.       |
| `INVALID`   | Signature failed or clock-rollback detected.              |

`statusOf()` uses `ChronoUnit.DAYS.between(today, expires)` — not
`Period.getDays()` (which returns only the day component of a Period).

### 18.5 Enforcement filter (`LicenseEnforcementFilter`)

Runs after `JwtAuthFilter`. Always-allowed path prefixes regardless of
status (so the user can recover from MISSING/EXPIRED):

```
/api/v1/health/**
/api/v1/auth/**
/api/v1/license       (GET + master POST + master DELETE)
/ws/**
```

For other paths it gates on `LicenseStatus.isFullyBlocked()` /
`isWriteBlocked()`. Throttled `last_seen_at` touch (5-min) updates both the
DB column and the sealed-clock file on each request.

### 18.6 Clock-rollback detection (`LicenseSealedClock`)

A tiny AES-GCM-sealed file written next to the live license tracks the
last-seen wall-clock time. If the OS clock is later observed earlier than
the sealed value by more than 5 minutes, the verifier flips the status to
`INVALID` and emits a `LICENSE_CLOCK_TAMPER` audit row.

- Sealed file lives at `${user.home}/.ksinfo-modernize/license-seen.bin`
  (configurable via `modernize.license.sealed-file`).
- AES-GCM key is derived from `SHA-256(public-key-fingerprint + fixed salt)`.
  Defeating it requires source code or the keypair — sufficient for the
  honest-operator threat model.

### 18.7 Backend artefacts

- `coordinator/license/` package — `License` entity, `LicenseRepository`,
  `LicenseService`, `LicenseDocument` record, `LicenseStatus` enum,
  `LicenseVerifier`, `LicenseSealedClock`, `LicenseEnforcementFilter`,
  `LicenseStartupLoader`.
- `coordinator/api/LicenseController` — `GET` returns status DTO,
  `POST` uploads a `.lic` (master only, multipart), `DELETE` wipes
  (master only, dev-mode shortcut).
- Migration: `V20260522114140__license.sql` adds the `license` table with
  `last_seen_at` and `imported_at` columns. Audit log gets two new actions:
  `LICENSE_LOADED`, `LICENSE_INVALID_SIG`, plus `LICENSE_CLEARED` and
  `LICENSE_CLOCK_TAMPER`.

### 18.8 Frontend artefacts

- `api/license.ts` — `get()`, `upload(File)`, `clear()` (dev).
- `store/license.ts` — singleton zustand store with 30-min polling. Banner
  reads from this; LicenseCard refreshes it after upload/clear so the
  banner reacts immediately.
- `components/LicenseBanner.tsx` — amber/red header band shown for any
  non-`ACTIVE` status. Mounted by `AppShell` above the main flex column.
- `components/SolutionSettingsModal.tsx` → `LicenseCard` — shows
  customer / edition / dates / days-remaining badge / status chip. Master-
  only `Update license` button triggers a hidden file picker. In Vite dev
  builds, an extra red `Clear (dev)` button wipes the license server-side.

### 18.9 Issuer module (`ModernizeProData/issuer/`)

A standalone Maven module (Spring-free, Jackson only) that produces both a
CLI and a Swing GUI for issuing `.lic` files. Build script `build-exe.ps1`
packages it via jpackage `--type app-image` into a self-contained Windows
bundle (LicenseIssuer\) with bundled JRE — no separate installer, no Inno
Setup / WiX dependency.

- Default key location: `LicenseIssuer\license\` (portable — copies with
  the install folder, survives PC handover via USB).
- jpackage's bundled JRE uses **System Look-and-Feel** so OS-level font
  composite handles Korean/Japanese/Latin glyphs in the GUI without manual
  fontconfig surgery.
- `--icon mpd.ico` (generated from `mpd_lic.png` by `make-ico.ps1`) — sets
  the Windows Explorer / taskbar / title-bar icon for both launchers.
- `build-exe.ps1` preserves the `license\` folder across rebuilds by
  moving it to `%TEMP%` before `jpackage` and restoring it after. Without
  this, rebuilds would silently destroy the keypair.
- Issuer keypair must never be regenerated except for security-incident
  rotation. Rotation = full backend rebuild + redeployment to every
  customer site. PC handover should be `license\` folder copy, not regen.

### 18.10 Open items (intentionally deferred)

- Per-customer keypair (currently one global key for all customers — same
  fingerprint everywhere). Per-customer would isolate blast radius but
  needs a per-customer backend build pipeline.
- Hardware-bound license (e.g. tied to machine UUID). Not required by the
  current threat model.
- License rotation tooling — currently manual (delete `license\` folder,
  regenerate, rebuild backend). A CLI/UI flow could automate the warning
  about cascading rebuilds.

---

## 19. Windows Installer — Coordinator MVP (Phase 1, 2026-05-24)

### 19.1 Goals

Ship the main tool (Coordinator backend + React frontend) as a single Windows
.msi. Double-click install → native window opens → user logs in. PoC 1st-round
demo deliverable. Three downstream modes (Client / Standalone / Coordinator)
remain Phase 2 — a first-boot wizard branches there from the same installer.

### 19.2 Architecture (single fat jar inside JavaFX shell)

```
%LOCALAPPDATA%\ModernizeProData\                   (per-user install)
├── ModernizeProData.exe          ← jpackage launcher
├── app\modernize-pro-data-*.jar  ← Spring Boot fat jar (BOOT-INF/classes/static/
│                                   = Vite dist)
└── runtime\                       ← bundled JRE + JavaFX modules (jlink)
```

```
double-click ModernizeProData.exe
  -> Launcher.main (jpackage sets -Dmpd.gui.enabled=true)
  -> GuiApp.launch (JavaFX Application)
       -> Stage opens with "Starting..." HTML
       -> Spring Boot started on background thread
       -> ApplicationReadyEvent fires
       -> Platform.runLater -> WebView.load("http://localhost:8080/")
  -> User logs in; window close = SpringApplication.exit + Platform.exit
```

### 19.3 Decision log

- **PowerShell, not Maven jpackage plugin** — orchestration mirrors
  `issuer/build-exe.ps1`. Single source of pattern for both modules.
- **Single fat jar with static under classpath:/static/** — spring-boot-maven-
  plugin already produces this layout; SPA fallback controller forwards non-
  `/api`/`/ws`/`/assets` paths to `/index.html`.
- **.msi via WiX 3.14** — chosen for Japan finance market acceptance. WiX 4 is
  not compatible with jpackage; build.ps1 explicitly checks 3.x.
- **Per-user install** — `--win-per-user-install` puts everything under
  `%LOCALAPPDATA%`, no UAC, no admin rights. Standalone deployment matches the
  isolated-customer-PC story.
- **JavaFX WebView (not browser-auto-open)** — UX requirement is "native
  desktop app, not a browser tab". JavaFX is the lightest path in our Java
  stack to embed React. Native dependency on JavaFX SDK 21.0.4 from Gluon, not
  in JDK 21 by default.
- **JavaFX as `provided` Maven scope** — keeps the fat jar lean (no JavaFX in
  BOOT-INF/lib). jpackage gets the runtime modules from JavaFX SDK via
  `--module-path` and `--add-modules javafx.controls,javafx.web`.
- **PG pre-installed assumption (Phase 1)** — host native PostgreSQL on
  localhost:5433, DB `mpd_meta`, user/pw `mpd`/`mpd` (matches CLAUDE.md
  default). Bundling PG portable is deferred. If the DB is missing, Spring
  startup fails and the WebView shows an error page (Phase 1 simple; Phase 2
  wizard improves it).
- **`mpd.gui.enabled` system property** — Launcher branches dev vs installed
  on this flag. `mvn spring-boot:run` does not set it, so JavaFX never
  initializes during dev. jpackage launcher sets it, so the installed mode
  always runs the JavaFX shell.

### 19.4 Frontend build divergence (tsc gate)

`npm run build` is `tsc -b && vite build`. Other team members' work-in-
progress branches on `dev` may leave the `tsc -b` gate failing for code
unrelated to the installer. The installer pipeline therefore calls `npx
vite build` directly — Vite's own bundler still validates the build, and
unblocking the installer is more valuable than enforcing the strict TS gate at
this stage. The dev workflow (`npm run build` from a feature branch) keeps the
gate.

### 19.5 Static frontend wiring on the backend

- `frontend/.env.production`: `VITE_API_BASE_URL=` (empty) → axios prefix is
  empty → requests go to `/api/v1/...` relative → same-origin Spring Boot.
- `SpaFallbackController`: regex-routes any non-`/api`/`/ws`/`/assets`/`/favicon`/`/mpd*`
  path to `forward:/index.html`. React Router takes over from there.
- `SecurityConfig`: anonymous permitAll for `/`, `/index.html`, `/favicon.svg`,
  `/favicon.ico`, `/mpd.png`, `/mpd_lic.png`, `/assets/**`. Login still happens
  through `/api/v1/auth/**` (also anonymous, pre-existing).

### 19.6 application-prod.yml

Bundled in fat jar. Activated by `-Dspring.profiles.active=prod`. Overrides
nothing the user has to care about — only:

- `spring.datasource.url` default points to `localhost:5433/mpd_meta`
  (matches CLAUDE.md, not the Spring Boot Maven Plugin's docker-compose
  default of 5432).
- Logging tightened to INFO root, WARN for `org.hibernate.SQL` and
  `org.springframework.security`.
- Vite dev-server origin removed from CORS (only `http://localhost:8080`).
- `modernize.license.public-key` falls back to `classpath:license/public.pem`
  and accepts `MPD_LICENSE_PUBKEY` env override.

### 19.7 Build pipeline (installer/build.ps1)

7 phases, in order:

0. **Verify environment** — `jpackage`, WiX 3.x (auto-detects `Program Files
   (x86)\WiX Toolset v3.14\bin` or v3.11 paths), `npm`.
1. **JavaFX SDK cache** — first run downloads
   `openjfx-21.0.4_windows-x64_bin-sdk.zip` (~30MB) from Gluon to
   `installer/cache/`. Subsequent runs skip.
2. **Frontend** — `npx vite build` in `frontend/`.
3. **Stage frontend** — `frontend/dist/*` → `backend/src/main/resources/static/`.
4. **Backend** — `./mvnw -DskipTests package` in `backend/` produces fat jar.
5. **Stage jar** — fat jar copied into `installer/staging/app/`.
6. **Icon** — `make-ico.ps1` wraps `frontend/public/mpd.png` as PNG-embedded
   `.ico` (same pattern as issuer). Cached at `installer/assets/mpd.ico`.
7. **jpackage** — `--type msi --win-per-user-install --module-path
   <javafx-sdk-lib> --add-modules javafx.controls,javafx.web,...`. Adds
   shortcut + Start Menu group + dir chooser.

Output: `installer/dist/ModernizeProData-1.0.0.msi`, ~130–160MB (JRE + JavaFX
modules + fat jar).

### 19.8 Critical rules carried over from issuer

- All `.ps1` files **must keep UTF-8 BOM** — PowerShell 5.1 on Korean Windows
  reads BOM-less UTF-8 as CP949 and corrupts non-ASCII content. Keep build
  output ASCII to be safe across encoding regressions.
- **Do not "simplify" `installer/staging/`'s `Remove-Item -Recurse`** — same
  cautionary tale as issuer's `license/` preservation. If we ever stage
  generated state (license, signing materials, captured certs) here, it MUST
  be preserved across rebuilds.
- **System Look-and-Feel only** (Swing-style components stay native) —
  Cross-Platform L&F on Korean Windows breaks Hangul rendering in jpackage'd
  JRE. JavaFX WebView is unaffected, but if we ever add Swing dialogs in the
  installer they must respect this.

### 19.9 Verification flow

Build: `cd ModernizeProData\installer; .\build.ps1`. Output is the .msi under
`installer\dist\`.

Smoke test (clean Windows account or VM):

1. PG 18 running on `localhost:5433/mpd_meta` (user/pw `mpd`/`mpd`).
2. Double-click .msi → next/next/install. No UAC prompt expected.
3. Start Menu → ModernizeProData → window opens "Starting...", then loads the
   login page within ~10s.
4. master/password (UserBootstrap default) → Dashboard.
5. Close window → no orphan processes.

PG-missing path: open the window, see the WebView error page. Phase 2 wizard
will turn this into an interactive setup.

### 19.10 Phase 2 / 3 forward references

- **Phase 2** — same .msi gets a first-boot mode selector (Coordinator /
  Client / Standalone). Client mode drops Spring Boot + DB entirely, leaving
  the JavaFX shell pointed at a remote Coordinator's URL.
- **Phase 3** — License hardening (per-customer keypair, fingerprint binding,
  password-encrypted private.pem). The Phase 1 installer assumes the existing
  single global keypair from `feature/license`.

---

## 20. Further Reading

- `CLAUDE.md` — stack, conventions, domain glossary, local run.
- `docs/handoff/` — time-stamped handoff notes (read the most recent first).
- `docs/DESIGN.md` — initial design (partially outdated — this document takes precedence).
- `docs/USER_MANUAL.md` / `docs/DEVELOPER_MANUAL.md` — UI and operations manuals.
