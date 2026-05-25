# Modernize Pro Data — Team Onboarding (Pipeline & Rule Engine)

A team-shared digest of the accumulated design decisions for the migration pipeline and rule engine. Read this together with `CLAUDE.md` when onboarding a new teammate or starting a new AI session.

**Prerequisites** — One-line project summary, tech stack, directory map, and domain glossary live in `CLAUDE.md` at the repo root. This document covers what isn't there (or is only one line there): **the pipeline, the rule engine, supporting SPIs, and workflow conventions**.

Last updated: 2026-05-20

---

## 1. Phase / Stage model (confirmed 2026-05-15)

### 1.1 Nine phases
```
planning → analysis → test → sign-off → rehearsal → ready → cutover → hypercare → done
```

### 1.2 Four stages (environment label)
```
dev → test → staging → production
```
- `dev` is always first (fixed order).
- **The `cutover` phase can only run in `production` stage.** Enforce with a code-level guard.

### 1.3 Two snapshot types + approval flow
| Snapshot | Phase it advances on approve | When can it be created |
|---|---|---|
| mapping snapshot | → sign-off | any time |
| cutover snapshot | → ready | **post-rehearsal phases only** (`rehearsal · ready · cutover · hypercare · done`) |

- **Phase transitions happen only on `approve`** — never at request time.
- When creating a cutover snapshot the UI shows an extra **red strong-confirm dialog** (separate from the production-stage guard).

### 1.4 Snapshot version assignment (confirmed 2026-05-19)

Each snapshot carries a `version VARCHAR(16)` column auto-assigned by the server. No manual editing. The logic lives in `Snapshot.generateNextVersion(latestVersion, latestStatus)`.

| Previous snapshot status | Next version | Meaning |
|---|---|---|
| (none, first creation) | `v1.0` | initial value |
| `approved` | major bump (`v1.3 → v2.0`) | new mapping cycle after a signed-off baseline |
| `draft` / `pending` / `rejected` | minor bump (`v1.2 → v1.3`) | rework within the same cycle |

- Versioning is triggered **only when a new snapshot is created**. Status transitions (request / approve / reject) do not change the version.
- "Previous" = the single row with the latest `created_at DESC` (`SnapshotRepository.findLatestByProjectId`).
- Stored as `VARCHAR`, so lexicographic ordering gives `v10.0 < v2.0`. The current UI sorts by `created_at`, so this is fine — if a version-based sort UI is added later, a dedicated parser is required.
- Concurrent creation of snapshots for the same project by multiple users is assumed not to occur (air-gapped, single-operator usage); no lock.

### 1.5 AUDIT LOG (current state)

- The frontend `store/auditLog.ts` persists entries to **client-side localStorage** via zustand `persist`. Accumulated per project, with count + collapse in the UI.
- Limitation: the record differs per PC. Acceptable for the PoC demo, which runs on a single PC.
- Once the server `audit_log` table (§9) lands, keep the store interface as-is and swap only the implementation to call the API.

### 1.4 `runStatus` sub-status (test / rehearsal / cutover only)
| Value | Meaning | UI |
|---|---|---|
| `idle` | not started | default |
| `running` | in progress | progress shown |
| `completed` | done | **gray badge** (UI convention) |

---

## 2. Pipeline — 4 stages (confirmed 2026-05-18)

```
Source Reader SPI → DuckDB Appender → Rule Engine (SQL + UDF) → Loader Adapter SPI
                       ↓ writes              ↓ writes
                     CP1 Raw Parquet       CP2 Transformed Parquet
                     (checkpoint ①)        (checkpoint ② — rehearsal only)
```

Every stage is SPI-abstracted: adapters swap based on input format or TO-BE DB type. **Single-writer policy** — one DuckDB instance per worker.

### 2.1 Two checkpoints
- **CP1** = one Parquet per source file (`cp1_emp.parquet`, `cp1_dept.parquet`...). All columns VARCHAR. **No JOINs and no type conversion** — raw preservation only.
- **CP2** = after JOIN/UNION + transform rules. Generated for rehearsal only; cutover skips it for speed.

### 2.2 Four cases
| Case | Input | Phase | CP2 | Notes |
|---|---|---|---|---|
| 1 | CSV | rehearsal | yes | default path |
| 2 | CSV | cutover | no | Rule Engine output → Loader directly |
| 3 | non-CSV (EBCDIC, etc.) | rehearsal | yes | Source Reader unpacks before Appender |
| 4 | non-CSV | cutover | no | If no JOINs needed, bypass DuckDB (Java direct). If JOINs needed, fall back to case 2 |

### 2.3 Restart matrix
| Failure point | Restart from |
|---|---|
| Source / CP1 generation | start |
| Rule Engine | CP1 (no need to re-read CSV) |
| Rehearsal load | CP2 |
| Cutover load | CP1 (CP2 doesn't exist) |

### 2.4 Directory layout
```
data/
├── incoming/             ← AS-IS files land here
├── staging/cp1/          ← Raw Parquet
├── staging/cp2/          ← Transformed Parquet
├── staging/quarantine/   ← UDF-null rows
├── drivers/              ← TO-BE JDBC JARs (per-site)
└── runs/                 ← run artifacts
```

---

## 3. Rule Engine — DuckDB SQL + Java UDF

The CP1 → CP2 transform engine: **a thin rule engine on top of DuckDB**.

### 3.1 Execution order (within a single SQL statement)
1. **JOIN / UNION** — combine CP1 Parquets by raw keys (e.g., `dept_code`).
2. **Apply transforms** — SQL (`CAST`, `CASE WHEN`) + Java UDFs.
3. **Split quarantine** — same JOIN/UNION shape, inverted WHERE, separate COPY.

**Why JOIN first**: raw keys must match before any transform changes them.

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

-- Failed rows → Quarantine (same JOIN, inverted WHERE)
COPY (
    SELECT e.*, d.dept_name, 'UDF transform failed' AS reason
    FROM read_parquet('cp1_emp.parquet') e
    JOIN read_parquet('cp1_dept.parquet') d ON e.dept_code = d.dept_code
    WHERE apply_scale(e.salary_raw, 2) IS NULL
       OR convert_era(e.hire_date_raw) IS NULL
) TO 'quarantine.parquet' (FORMAT PARQUET);
```

### 3.3 Initial UDFs (3)
| Name | Input | Output | Kind | Notes |
|---|---|---|---|---|
| `apply_scale` | VARCHAR, int | BigDecimal | scalar | COMP-3 unpack + scale. Fail → null. |
| `convert_era` | VARCHAR | LocalDate | vectorized (2048 rows) | Japanese era (`"令和8年5月16日"`). Fail → null. |
| `assign_seq` | VARCHAR | long | scalar + **`withVolatile()` required** | Sequence numbering. Without volatile, DuckDB caches. |

### 3.4 UDF gotchas (most-forgotten)
1. **NULL in → NULL out** by design. Otherwise NPE → whole job fails.
2. **`withVolatile()`** for any UDF whose return varies between calls.
3. **Connection scope** — `registerAllUdfs()` per new `Connection`.
4. **Vectorized UDF's `DuckDBDataChunkReader`** is only valid inside the callback — never store outside.

### 3.5 Chunking (large tables)
- LIMIT/OFFSET over CP1.
- Reuse temp table via TRUNCATE (CREATE once).
- Per chunk: Appender insert → `COPY TO cp2_NNN.parquet` → TRUNCATE.
- Final load: `read_parquet(['cp2_*.parquet'])`.
- Large JOIN: keep small side full in memory, chunk only the large side.

---

## 4. Rule input model — 3-layer toolbox (refined 2026-05-20)

Three ways the user defines a column's transform. Originally framed as a fallback **cascade** (1 → 2 → 3 when the previous fails). Refinement on 2026-05-20: in practice users **select by business intent, not by complexity**, so expose all three as a toolbox. Layer 1 is suggested by default; the user can jump to any layer directly.

### 4.1 Layer 1 — Type-based auto-mapping
Backend has explicit Java functions for each `(source DB, target DB, source type, target type)` rule — written as testable units, not a generic matrix. Examples:

| AS-IS | TO-BE | Result | Risk flag |
|---|---|---|---|
| Oracle `CHAR(N)` | PG `VARCHAR(N)` | `strategy=copy` | — |
| Oracle `CHAR(N)` | PG `VARCHAR(M < N)` | `strategy=cast` | **length truncation** |
| Oracle `NUMBER(p,s)` | PG `NUMERIC(p,s)` | `strategy=copy` | — |
| Oracle `NUMBER` | PG `INTEGER` | `strategy=cast` | **overflow** |
| Oracle `DATE` | PG `TIMESTAMP` | `strategy=copy` | — |
| Oracle `BLOB` | PG `BYTEA` | `strategy=copy` | — |

Unknown/unmapped pairs land as `strategy=unmapped` → user must choose in Layer 2.

**UI:** `source=auto` badge on the column row. Risk-flagged rows get an amber indicator.

### 4.2 Layer 2 — Strategy library

**Critical split (added 2026-05-20):** Layer 2 is two things with different governance.

#### 4.2a — Parameterized SQL templates (pure SQL, no Java)
| strategy | params | compiled_expr | Notes |
|---|---|---|---|
| `copy` | `{}` | `src.col AS tgt_col` | |
| `constant` | `{"value":"X"}` | `'X' AS tgt_col` | |
| `cast` | `{"type":"INTEGER"}` | `CAST(src.col AS INTEGER) AS tgt_col` | |
| `case_when` | `{"map":{"1":"M","2":"F"}, "default":null}` | `CASE src.col WHEN ... END AS tgt_col` | |
| `lookup` | `{"table":"code_map","key":"src.col"}` | `lkp.value AS tgt_col` + auto LEFT JOIN | Triggers `binding_source` insert |

DuckDB version upgrades rarely affect these. Vectorized automatically.

#### 4.2b — Java UDF wrappers
| strategy | UDF called | params |
|---|---|---|
| `comp3_decimal` | `apply_scale` | `{"scale":2}` |
| `era_to_date` | `convert_era` | `{}` |
| `seq` | `assign_seq` | `{"key":"dept_code"}` |

UDF signature changes affect 2b only (compiler is the single point of update). Surface usage stats for 2a and 2b separately — different risk profiles.

### 4.3 Layer 3 — Custom user-input code (deferred to PoC 2nd round)
For cases not covered by 1, 2a, or 2b.

**Decided 2026-05-20:**
- **Out of scope for PoC 1st round** (deadline 2026-05-31). Security (arbitrary code execution), performance (per-row interpret), debuggability cannot be designed safely in remaining time.
- For 1st round, the fallback when Layer 1/2 doesn't suffice is the **table-scoped Java mode** (escape ladder 2 in §5) — a coded escape, not a user-input one.
- When introduced in 2nd round, use a **safe expression language** (MVEL / JEXL / Janino with strict whitelist). Never raw Java.

**Correct mechanism (for 2nd-round implementation):** dynamic UDFs registered per snapshot at run start. Snapshot stores the code text once; SQL calls the dynamic UDF by name. Not "user code passed as a per-row string argument".

```json
"dynamic_udfs": {
  "udf_proj42_col_foo_v3": {
    "language": "mvel",
    "source": "<user code>",
    "compiled_sha": "abc123"
  }
}
```

### 4.4 UDF visibility policy
| Layer | UDFs in user-visible text? |
|---|---|
| 1 | Never (auto-generated SQL uses no UDFs) |
| 2 | Hidden behind strategy name (`comp3_decimal`, not `apply_scale(...)`) |
| 3 | Forbidden in user code; engine registers dynamic UDFs |

**Why:** UDF signature changes (`apply_scale(v,s)` → `apply_scale(v,s,mode)`) become trivial when no snapshot stores the call text. If UDFs were callable in user-typed text, every signature change would require migrating every site's frozen snapshots — operationally impossible.

### 4.5 `column_override` schema (planned)
```
strategy        enum
params          jsonb
compiled_expr   text   -- engine-filled (user-filled only when strategy=custom_expr)
source          enum   -- auto | manual (auto recalc never overwrites manual)
```

---

## 5. Escape ladder — when DuckDB doesn't suffice

### 5.1 Ladder 1 — add a new UDF (90%+)
"DuckDB can't do X" almost always means "DuckDB stdlib doesn't have X". Add a Java UDF. Same pattern as `apply_scale` / `convert_era` / `assign_seq`.

Real candidates:
- In-house AES encryption with key-wheel policy
- Calls to certified Java libraries (e.g., `KsBankCheckDigit.validate()`)
- MeCab tokenization + transform
- Company-standard normalization

### 5.2 Ladder 2 — Java-only table mode (1–2%)
For cases UDF can't cover either (cross-row state, multi-pass, certified row-by-row libraries). **Only that table** bypasses DuckDB:

```
[normal] Source Reader → DuckDB Appender → Rule Engine → Loader
[bypass] Source Reader → Java row processor → Loader
```

Per-table flag `engine: duckdb | java`. Snapshot freezes the Java class name + version → deterministic replay.

**Cost:** lose DuckDB's vectorized parallelism. Use only when truly stuck.

---

## 6. Validation rules — parallel track (OPEN, raised 2026-05-20)

The rule engine as modeled today only expresses **transformations**. Real migration also needs **assertions** that `column_override` can't express:

- **Pre-conditions** — before transform, `salary` must be in `[0, 1e9]`
- **Post-conditions** — after transform, `email` must match `\S+@\S+`
- **Cross-row invariants** — sum of `amount` equals batch report total
- **Cross-table invariants** — every `emp.dept_code` exists in `dept` (beyond FK)

Recommendation: a parallel **Validation Rules** track, same `strategy + params + compiled_expr` shape, evaluated separately, with failures going to quarantine with a validation-specific `reason`.

**Status: open as of 2026-05-20.** Not yet modeled in `column_override` or any other meta table. Decide before V7 Flyway migration is written.

---

## 7. Mapping snapshot — audit & reproducibility

Approved mappings **freeze the `compiled_expr`** (not just params).

Reason: engine/UDF upgrades must not change the semantics of an already-signed-off snapshot — Japanese financial audit failure mode.

Lifecycle:
```
user edits rules
  → engine refills compiled_expr (column_override)
  → user clicks "approve mapping snapshot"
  → compiled_expr values copied into mapping_snapshot.payload_json (frozen)
  → subsequent runs read ONLY the snapshot (column_override is ignored)
```

Terms: **deterministic replay**, **immutable snapshot**.

---

## 8. Source Reader SPI

| Adapter | Handling |
|---|---|
| `CsvReaderAdapter` | Delegates to DuckDB `read_csv()`. Shift-JIS via `encoding='shift_jis'` (encodings extension). |
| `EbcdicReaderAdapter` | FileInputStream binary mode + COMP-3 nibble unpack (`0xC` = positive, `0xD` = negative) + EBCDIC → UTF-8 |
| `FixedWidthReaderAdapter` | Record length + per-column `{offset, length}` |

Air-gapped requirement: bundle DuckDB `encodings` extension in installer.

---

## 9. Loader Adapter SPI

| Adapter | TO-BE | Method |
|---|---|---|
| `PostgresLoaderAdapter` | PostgreSQL | `COPY FROM STDIN` (`CopyManager`) |
| `OracleLoaderAdapter` | Oracle | OCI Direct Path |
| `MySqlLoaderAdapter` | MySQL | JDBC + `reWriteBatchedInserts=true` |
| `SqlServerLoaderAdapter` | SQL Server | BulkCopy (TDS) |
| `JdbcFallbackAdapter` | other | plain JDBC batch INSERT |

Selection: `AdapterFactory` chooses by `driverId`. TO-BE JDBC driver JARs live in `data/drivers/`, loaded dynamically per site.

---

## 10. Meta DB — new tables (Flyway V7+ planned)

On top of existing `site` / `project` (V4–V6):

| Table | Role |
|---|---|
| `connection` | TO-BE DB JDBC credentials (AES-GCM encrypted) |
| `parsing_source` | AS-IS file meta (encoding, delimiter, adapter type) |
| `asis_db` | DuckDB store meta (per worker) |
| `schema_diff` | per-target-table mapping header (column diff + rule header) |
| `column_override` | per-column transform rule (`strategy, params, compiled_expr, source`) |
| `binding_source` | JOIN/UNION source bindings (`PRIMARY / JOIN / UNION`) |
| `mapping_snapshot` | approved frozen mapping (`payload_json`) |
| `migration_run` | run history |
| `run_quarantine` | quarantined rows (`run_id, stage, severity, reason, ...`) |
| `audit_log` | change history |

**Rule:** never rely on Hibernate auto-DDL. New tables go in `V{N}__*.sql`.

---

## 11. Coordinator / Worker operational model

- **Worker → Coordinator** over REST + WebSocket only. **No direct PG JDBC.**
- **Meta PG bind**: `127.0.0.1` only — Coordinator process is the only client.

### 11.1 Worker registration flow
1. After Coordinator install, the screen shows:
   - Coordinator URL (e.g., `http://10.20.30.40:8080`)
   - Worker registration token (e.g., `WK-7HQ3-2X5L-8MNP`)
2. Worker install asks for both values → POSTs to Coordinator API → token validated → node added.
3. Token format: UUID-derived, short 4-4-4 hex segments (human-transcribable).

### 11.2 Asymmetric channels
| Direction | Channel | Use |
|---|---|---|
| Coordinator → Worker | WebSocket push | task dispatch |
| Worker → Coordinator | REST | result/status report |

### 11.3 Heartbeat
- Worker pings Coordinator every 30 seconds.
- Missed beats beyond a threshold → node marked inactive.

---

## 12. Installer policy

- **Bundled PG version**: PostgreSQL (see §17 item 6 — version discrepancy between docs being resolved)
- **Existing PG**: user picks "use existing" vs "install separate instance"

### 12.1 Installer responsibilities (in order)
1. Detect whether PG is installed.
2. If not: install bundled PG (Windows Service, separate port + data dir + OS account).
3. If yes: present the choice.
4. Create initial DB + account → Flyway applies migrations.
5. After Coordinator starts, screen shows URL + Worker registration token.

### 12.2 Isolation
- **TO-BE PG must be isolated**: even on the same server, separate port, data dir, OS account.
- Installer tech: jpackage or WiX/NSIS (TBD).

---

## 13. Test strategy (mandatory reading for BE)

### 13.1 H2 fully dropped
- Removed from dependencies, including test scope.
- Why: H2's PG-mode is subtly different (JSONB, ARRAY, functions). "Tests passed but prod broke" is unacceptable for Japanese finance.

### 13.2 Testcontainers + `@ServiceConnection` (Spring Boot 3.1+)
- `TestcontainersConfiguration` bean returns `PostgreSQLContainer<>("postgres:16-alpine")`.
- Standard integration test setup: `@SpringBootTest` + `@Import(TestcontainersConfiguration.class)`.
- **Docker required on every dev PC** (team policy 2026-05-14). No Docker → can't run automated tests.

### 13.3 Flyway owns the schema
- Spring Batch schema included as `V1__spring_batch_schema.sql`.
- `spring.batch.jdbc.initialize-schema: never`.
- Hibernate auto-DDL forbidden. New entity = new `V{N}__*.sql`.

### 13.4 Test mix guideline
| Category | Share | Examples |
|---|---|---|
| PG required (Testcontainers) | 20–30% | JPA repos, integration tests, migration checks, audit log |
| PG not required | 70–80% | Transform engine (embedded DuckDB), mapping logic, auth, DTO mapping |

### 13.5 Shared in-house PG not suitable for tests
- Isolation, concurrency, CI access issues.
- OK for running the tool locally via `mvn spring-boot:run` (dev clicking through UI).

---

## 14. 12-factor deployment habits

**Current model** = jpackage standalone + installer-bundled PG. K8s/Helm is over-cost (Japanese finance procurement + air-gapped image distribution overhead).

But keep code 12-factor-friendly for future portability:

### 14.1 External injection
| Item | How |
|---|---|
| Config | env vars / external files (no hardcoding) |
| Meta DB connection | host/port/user/pass env vars |
| License (.lic) path | injected |
| Coordinator URL (for Workers) | injected |
| Data directory | injected |

### 14.2 Logs
- **stdout only.** No file logging.

### 14.3 No deployment-shape coupling
- jpackage → docker → K8s: same code, zero changes is the goal.
- docker-compose is **dev/test only**, never operational.

### 14.4 K8s as a second-pass
- If a customer explicitly asks "we have K8s, deploy there", add it as a second channel — not the primary.

---

## 15. Git workflow (added 2026-05-20)

### 15.1 Commit format — Conventional Commits
`<type>(<scope>): <description>` — e.g., `fix(settings): restore useLocation import lost in PR #3 merge`.

Types: `feat | fix | chore | docs | refactor | test | perf | build | ci`. Scope optional but narrow when used.

Anti-pattern: `fix: (settings) restore ...` (scope after colon) — breaks Conventional Commits parsers.

### 15.2 Merge conflicts — never resolve in GitHub UI
GitHub's web conflict editor is a plain textarea with **no typecheck or build**. PR #3 lost a `useLocation` import that way, breaking SettingsPage at runtime.

Mandatory workflow: PR author (not reviewer) merges `dev` into the feature branch locally, runs `npx tsc --noEmit` + build, then pushes.

### 15.3 Import conflicts — always union, never pick
When both sides modify the same `import` line, take the union of additions. Picking one side is how symbols silently disappear.

Example:
```typescript
// Side A
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// Side B
import { useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// Correct — union
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
```

### 15.4 Branch protection — pending
On `dev` and `master`: require PR, require status checks (CI typecheck + build), no force push. Until CI workflow exists in `.github/workflows/`, manual discipline is the only safeguard.

---

## 16. Artifacts UI — preview & export shell (added 2026-05-20)

`/artifacts` is the read-only view layer for everything the migration pipeline produces. It does **not** generate anything itself — it visualizes outputs from DDL imports, mapping definitions, snapshots, and runs.

### 16.1 Six categories

| Category | Backing data (when wired) | Visual unit |
|---|---|---|
| **Dashboard snapshot** | Project-wide mapping progress + run stats aggregation | One file per project (`dashboard-snapshot.dashboard.xlsx`) |
| **Schema diff** | AS-IS DDL ↔ TO-BE DDL diff (added / removed / typed / renamed) | One per TO-BE table |
| **DDL scripts** | TO-BE DDL — `CREATE TABLE` text generated from imported schema | One per TO-BE table |
| **Migration SQL** | `INSERT … SELECT` rendered from mapping rules | One per TO-BE table |
| **Mapping** | Mapping rules + lookup tables — workbook with Overview / Rules / Lookups sheets | One per TO-BE table |
| **Validation** | Run-result checks: row count, checksum, SUM reconciliation, NULL parity, range/overflow | One per TO-BE table |

### 16.2 Backend data availability (as of 2026-05-20)

| Category | Available now | Blocker |
|---|---|---|
| DDL scripts | ✅ AS-IS / TO-BE DDL imports already loaded into `asisDdl` / `tobeDdl` stores | — |
| Schema diff | ✅ partial — name-based diff when both sides imported (added/removed/typed) | rename/merge detection blocked on mapping module |
| Migration SQL | ❌ | mapping rules don't exist yet |
| Mapping | ❌ | mapping module not started |
| Validation | ❌ | run module not wired |
| Dashboard | ❌ | mapping-progress aggregation not computed |

→ DDL is the first wiring target. Diff is the natural second once both DDLs are commonly present.

### 16.3 UI shape

The page intentionally mimics Excel — title bar → ribbon (`File … View`, no active tab) → Name Box (`A1 ▾`) + gray separator with `⋮` + `✕ ✓ fx` + formula content → sheet area → sheet tabs. The ribbon and Name Box are **decorative**. Real interactivity is on the sidebar (toggle / select), the sheet tabs (switch active sheet when populated), and the `Download` button.

The formula bar shows a single-line summary in the format documented in `~/.claude/projects/.../memory/project_artifacts_formula_bar.md`:

```
Diff       Schema diff: {ASIS} → {TOBE} · +n added · -n removed · ~n typed
DDL        DDL: {table} · {n} columns · {n} primary key
SQL        Migration SQL: {ASIS} → {TOBE} · {n} lines
Mapping    Mapping: {ASIS} → {TOBE} · {n} rules · {n} lookups
Validation Validation: {table} · {n} checks · PASS/FAIL
Dashboard  Snapshot: {project} · {n} tables · {n.n}% migrated
```

While empty, the summary slot shows the format itself (italic gray), so reviewers see what will appear when data arrives.

### 16.4 Out of scope on the UI side

- **Real `.xlsx` generation** — this can be added per category when each backend output starts flowing. A demo using `xlsx-js-style` was built during the porting session and removed before commit (see handoff `2026-05-20-artifacts-page.md`). If/when reintroduced, keep the dependency in `frontend/package.json` only after it's used in committed code, not for review-only previews.
- **Cumulative bundle export** (`Export all` button) — placeholder only; will be defined once at least two categories have data.
- **Editing** — none of the views permit edits. Diff/mapping authoring lives in the upcoming Mapping module, not here.

---

## 17. Open items (decisions needed)

1. **Final `strategy` enum list** — §4.2 lists the current candidates. Add/merge/remove?
2. **Codify "no UDF calls in `custom_expr`"** as a compiler-enforced check (whitelist).
3. **`unmapped` as a first-class strategy** vs row absence — pick one (impacts progress counting).
4. **`compile-preview` endpoint** (DuckDB `EXPLAIN` for design-time SQL validation) — include in PoC 1st round, or defer?
5. **`drop` / `ignore` strategy** — distinguish from `unmapped` (preflight passes vs blocks)?
6. **PG version doc discrepancy** — `CLAUDE.md` says "PG 18", memory `installer-pg-bundle` and `compose.yaml` say PG 16. Best guess: dev local = PG 18, installer bundle = PG 16. Reconcile.
7. **Validation rules track** (§6) — model in V7 schema? Or defer to V8+?

---

## 18. Further reading

- `CLAUDE.md` — stack, conventions, glossary, local dev commands
- `docs/handoff/` — point-in-time work handoff notes (read the most recent first)
- `docs/DESIGN.md` — initial design (some parts outdated; this document takes precedence)
- `docs/USER_MANUAL.md` / `DEVELOPER_MANUAL.md` — UI/operations manuals

---

## 19. Log Viewer page structure (added 2026-05-25)

`/logs` is the single read-side surface for everything a run produces. Three tabs
in the toolbar:

1. **Stream** — virtualized log-line table with INFO/WARN/ERROR + Step filter.
   Mock-driven until BE log ingest lands; flip `USE_MOCK` in `LogViewerPage.tsx`
   when swapping in real data.
2. **Quarantine** — rule-violation row groups with sample-row preview and a
   "jump to Mapping" action.
3. **Run history** — per-project run list via `runsApi.listByProject`. Has
   client-side `Status` / `Type` / `Trigger` filters; option lists are derived
   from the current dataset (so empty options don't appear in the dropdowns).

Run history used to live in Project Settings → Schedule tab. That tab is removed
entirely; Log Viewer's Run history tab is now the only per-project entry point.

The same 3-axis filter UI is mirrored on the All Projects → Schedule page
(`/site/scheduler`) Run history section, which still uses `runsApi.listAll`
(cross-project, with the dev `Abort` action).
