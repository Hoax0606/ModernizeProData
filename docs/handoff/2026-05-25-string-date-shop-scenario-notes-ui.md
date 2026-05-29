# 2026-05-25 — String→Date auto transform, Shop scenario, Notes UI, keyword-only uppercase

Continuation of 2026-05-24 work. Five independent improvements on top of the
DuckDB report pipeline + auto-transform generation that landed yesterday.

## 1. Auto STRPTIME for CHAR → DATE/TIMESTAMP

Yesterday's `MappingImportService` would fall through to a naive
`CAST(c.HIRE_YMD AS DATE)` for any string→date mismatch. DuckDB refuses to
cast `'20180601'` to DATE because it isn't ISO-formatted, so every CHAR(8)
YYYYMMDD field came back NULL.

New helpers `tryStringToDateSql` + `extractCharLength` infer the format from
the AS-IS column length and emit STRPTIME:

| AS-IS | TO-BE | Generated transform_sql |
|---|---|---|
| `CHAR(8)` | `DATE` | `STRPTIME(em.HIRE_YMD, '%Y%m%d')::DATE` |
| `CHAR(8)` | `TIMESTAMP` | `STRPTIME(em.HIRE_YMD, '%Y%m%d')` |
| `CHAR(14)` | `TIMESTAMP` | `STRPTIME(em.ENTRY_TS, '%Y%m%d%H%M%S')` |
| `CHAR(14)` | `DATE` | `STRPTIME(em.ENTRY_TS, '%Y%m%d%H%M%S')::DATE` |
| `CHAR(10)` | `DATE` | `STRPTIME(em.X, '%Y-%m-%d')::DATE` |
| `CHAR(19)` | `TIMESTAMP` | `STRPTIME(em.X, '%Y-%m-%d %H:%M:%S')` |
| (anything else) | DATE/TIMESTAMP | falls back to `CAST(... AS ...)` (TRY_CAST at run time) |

`extractCharLength` tolerates `CHAR(8)` / `VARCHAR2(60 CHAR)` / `VARCHAR2(20 BYTE)`
— it grabs the first integer inside parens.

Generation order in `buildSql`:
1. code_domain matches → CASE
2. asis/tobe type categories equal → passthrough
3. **NEW** — `tryStringToDateSql` for string → date/timestamp
4. fallback CAST

## 2. Shop scenario — JOIN / WHERE / UNION sample data

Three new sample DDLs + CSVs to exercise the not-yet-automated binding
features. The mapping CSV defines the column-level rules; the JOIN ON /
WHERE / UNION composition still has to be entered manually in the binding UI
(see § 5 below).

**DDL** (`/Users/Jinjinzara/Sample/ddl/`)
- `shop_oracle.sql` — SHOP schema, 4 tables
  - `SHOP_CUSTOMERS` (customer master with GRADE_CD)
  - `SHOP_ORDERS` (active orders, last 12 months)
  - `SHOP_ORDERS_ARCH` (older than 12 months — identical schema)
  - `SHOP_ORDER_ITEMS` (lines)
- `shop_postgres.sql` — public schema, 2 tables
  - `public.orders` ← `SHOP_ORDERS ∪ SHOP_ORDERS_ARCH` JOIN `SHOP_CUSTOMERS` WHERE `STATUS_CD <> 'CN'`
  - `public.order_lines` ← `SHOP_ORDER_ITEMS` (1:1)

**CSV** (`/Users/Jinjinzara/Sample/csv/`)
- `shop_customers.csv` (6 rows)
- `shop_orders.csv` (8 rows — includes one canceled order to validate WHERE)
- `shop_orders_arch.csv` (6 rows — older deliveries)
- `shop_order_items.csv` (11 rows)

**Mapping** (`/Users/Jinjinzara/Sample/mapping/`)
- `column_mapping.csv` — 14 rows appended for the Shop scenario
- `code_mapping.csv` — 3 domains appended: `CUSTOMER_GRADE` / `ORDER_STATUS` /
  `PAYMENT_METHOD`

The `is_archived` flag on `public.orders` is a UNION marker (false for active,
true for archive); since one CSV row can only have one `asis_table`, the
default is `false` and the archive source's row rule has to be flipped to
`true` by hand.

## 3. Suppressed Report SQL debug logging

`MappingReportService.runReport` was logging the generated SQL at DEBUG.
That's noisy when the user is exercising the UI repeatedly. Removed
`log.debug("Report SQL for {}.{}: {}", schema, tobeTable, sql)` from
`MappingReportService.java:106`.

If you ever want to debug, re-enable it temporarily; do not commit a TRACE
variant.

## 4. Mapping detail — Notes column with collapsible icon

`column_mapping.csv` has always had a `notes` column, and the backend has
been persisting it to `mapping_rules.notes` since the initial schema. The
field just wasn't surfaced in the UI.

**Wiring**

- `RowEdit.savedNotes?: string` added.
- `hydrateRuleEdits` populates `savedNotes: r.notes ?? undefined`.
- `allRows` merges `note: re.savedNotes || r.note` so the field is visible on
  the `MappingRow`.

**UI** (in `Inspector`, below the `Default` MetaRow)

- Empty notes → `—`
- Non-empty notes → FA `` icon (regular weight, `var(--navy)`) inside
  the children area of the `Notes` MetaRow.
  - Click toggles `notesOpen`. Icon rotates 180° via CSS transition when
    expanded.
  - Expanded content sits in a separate `<div>` outside the MetaRow, full
    width, `panel-2` background + `border-strong` border, with `pre-wrap` /
    `break-word` so multi-line notes survive intact.
  - `useEffect` resets `notesOpen` to `false` whenever `active?.tgt` changes —
    selecting a new column always starts collapsed.

Notes are **read-only** for now. If editing is needed later, extend
`UpsertRuleRequest` with a `notes` field and add a textarea to the row
editor; the backend column and DTO already accept it.

## 5. Transform editor — uppercase SQL keywords only

The Transform editor was calling `value.toUpperCase()` on every keystroke,
which mangled column names and string literals (`'%Y%m%d'` became
`'%Y%M%D'`). Three call sites in `MappingPage.tsx` were folded into a new
helper.

**New helper**

```ts
function upperSqlKeywords(s: string): string {
  return s.replace(/'(?:[^']|'')*'|[A-Za-z_][A-Za-z_0-9]*/g, (m) => {
    if (m.startsWith("'")) return m;
    const u = m.toUpperCase();
    return SQL_KW.has(u) ? u : m;
  });
}
```

`SQL_KW` extended with `TRY_CAST` and `STRPTIME`.

**Call sites changed**

- `computeAutoCast` — drop `.toUpperCase()` on the CAST template; the
  literal `CAST`/`AS` were already uppercase in the template, and the column
  name + type are taken from the source verbatim.
- `handleEdit` — drop `.toUpperCase()` on `savedRule ?? initialAutoCast`.
- `HighlightEditor` `onChange` — `setEditValue(upperSqlKeywords(v))` instead
  of `setEditValue(v.toUpperCase())`.

**Result**

| User types | Stored / displayed |
|---|---|
| `cast(c.cust_id as varchar(20))` | `CAST(c.cust_id AS VARCHAR(20))` |
| `c.first_name \|\| ' ' \|\| c.last_name` | unchanged |
| `case when c.status = 'A' then 'active' end` | `CASE WHEN c.status = 'A' THEN 'active' END` |
| `strptime(c.hire_ymd, '%y%m%d')::date` | `STRPTIME(c.hire_ymd, '%y%m%d')::DATE` |

The last row is the important one: the strftime format string `'%y%m%d'`
(lowercase `y` = 2-digit year, totally different from `%Y`) is now preserved.

## What's not done yet

- **Auto JOIN ON inference.** `deriveBindings` still emits `join_type=null`,
  `join_on=null` whenever a TO-BE table pulls from 2+ AS-IS tables. The user
  has to fill the ON condition manually in the binding panel. If we capture
  FK metadata during DDL import, this could be auto-populated.
- **Auto UNION detection.** `compositionKind` only resolves to
  `single | join | none`. The Shop scenario's `SHOP_ORDERS ∪ SHOP_ORDERS_ARCH`
  case has to be flipped to `union` manually.
- **Notes editing.** Read-only in the inspector. Editing requires extending
  the upsert request (see § 4).

## Smoke test — quickest end-to-end check

1. Backend restart (after the `MappingImportService` change).
2. Create a project pointing at `/Users/Jinjinzara/Sample/csv` with the
   `codemaster_postgres.sql` DDL.
3. Auto-mapping → pick `/Users/Jinjinzara/Sample/mapping/column_mapping.csv`
   + `code_mapping.csv` → Apply.
4. Open `public.employees` → Report:
   - `hire_date` shows as `2018-06-01` style DATE (proves STRPTIME works).
   - `created_at` shows full timestamp.
   - `gender` shows `MALE`/`FEMALE` (proves CASE generation still works).
5. Click a row → inspector shows `Notes ▾` icon. Click it to expand.
6. Edit the transform: type `cast(c.salary as numeric(11,2))` — should become
   `CAST(c.salary AS NUMERIC(11,2))` with the column name in original case.
