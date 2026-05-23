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

---

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

## 18. Pre-flight Gate — Execution Readiness Checks (added 2026-05-22)

The check panel that guards Start run on the Execution page. A run can only be
started when every applicable check is in pass state.

### 18.1 Check status model

- `pass | fail | skip` — three-state. `skip` ("n/a") means the check is not
  applicable to the current table selection (today: only `approved-snapshot`).
- `fail` blocks Start run; the hint switches to "resolve the failing items
  above first."
- `RunHeader`'s `canStart` AND-gates `preflightPassed` on top of the existing
  mapping-complete and phase gates.

### 18.2 The eight checks

| id | Title | Status when |
|---|---|---|
| `csv-arrived` | AS-IS extract data arrived | pass: customer's CSV received |
| `ddl-asis` | AS-IS DDL import | pass: N tables registered / fail: not yet |
| `ddl-tobe` | TO-BE DDL import | pass: N tables registered / fail: not yet |
| `conn-tobe` | TO-BE DB reachable | pass: latency ok / fail: slow / fail: unreachable |
| `tobe-bindings` | All TO-BE tables source-bound | pass: every TO-BE column has a source / fail: N unbound |
| `asis-unmapped` | Selected AS-IS columns unmapped check | pass: all selected AS-IS columns mapped / fail: N unmapped |
| `unmapped-cols` | All TO-BE columns unmapped check | pass: all TO-BE columns have a source / fail: N unmapped |
| `approved-snapshot` | Snapshot approval check | pass: approved snapshot in place / fail: no snapshot / **skip: partial table selection** |

`approved-snapshot` is the only check that uses `skip`: it is only meaningful
when the user runs against all tables — partial selections cannot validate
against a project-wide approved snapshot.

### 18.3 Table selection

- `TableSelector` lists TO-BE tables with a "select all" checkbox + per-table
  checkboxes.
- Empty state ("Register TO-BE DDL first") shown when `ddl-tobe` has not been
  imported yet — the Pre-flight check button is disabled in that state.
- Selection drives which AS-IS columns are inspected by `asis-unmapped`, and
  whether `approved-snapshot` runs (all) or is skipped (subset).

### 18.4 Trigger + mock simulation

- "Pre-flight check" button starts the run. Each check resolves at a 600 ms
  interval (mock `setTimeout`); the panel transitions `idle → checking → done`.
- `?demo=preflight` URL param renders an instant preview state (4 pass + 3
  fail + 1 skip) — used to verify the design without selecting tables. A
  "Back to real data" link exits the preview.

### 18.5 Fix → wiring (deferred)

Each `fail` row carries a `Fix →` affordance pointing at the page that
resolves it (Mapping for unbound TO-BE columns, Snapshots for missing
approval, Settings for DDL import). The onClick wiring + a one-second teal
pulse on the affected MappingPage column is **P3** — a new `fixTarget`
zustand store will carry `{ tableId, columnId }` across navigation.

### 18.6 Decision history

- `CheckStatus` shipped as 4-state → 2-state → settled at 3-state. The third
  value (`skip`) was introduced for the "snapshot only when ALL is selected"
  requirement — needed a value distinct from `fail` for the not-applicable
  case.
- `snapshotApproved` initially missed `'sign-off'`. The truth lives in
  `ApprovalsPage.tsx` ("Approve transitions phase: mapping → sign-off"), so a
  sign-off phase project must read as pass for `approved-snapshot`.
- `RunHistory` panel was removed (it duplicated `AuditLogPage` semantically).
  Run history lives in the audit log.

### 18.7 Out of scope (deferred)

- **P2** — backend `POST /api/v1/projects/{id}/preflight/run` and each
  check's real verification logic. Today the panel runs entirely on mocked
  store data.
- **P3** — Fix-button onClick wiring + MappingPage column pulse highlight via
  the new `fixTarget` store.
- `ExecutionPage.tsx` L578 `StartRunDialog` Confirm — backend wiring (today
  `/* backend wiring TBD */`).
- L202 Abort button onClick wiring.
- Quarantine / Worker-pool side panels — intentionally excluded from the
  initial Execution layout.

---

## 19. Further Reading

- `CLAUDE.md` — stack, conventions, domain glossary, local run.
- `docs/handoff/` — time-stamped handoff notes (read the most recent first).
- `docs/DESIGN.md` — initial design (partially outdated — this document takes precedence).
- `docs/USER_MANUAL.md` / `docs/DEVELOPER_MANUAL.md` — UI and operations manuals.
