# 2026-05-20 — mapping-page (Suhyun Jin)

## What was done

Built `MappingPage.tsx` from scratch — a dual-pane mapping screen (inventory sidebar + workspace + inspector panel) with iterative refinements throughout the session. Also added the route to `App.tsx`.

The SQL migration `V20260520145102__unique_site_and_project_names.sql` (unique constraints on `sites.name` and `projects.(site_id, name)`) was completed in the prior session and is already committed.

---

## Architecture: MappingPage

### Component hierarchy

```
MappingPage                        ← owns tableBindingEdits (Record<string, TableBindingEdit>)
├── DualInventory                  ← sidebar; receives effectiveTobe for badge counts
│   ├── AsisInventory              ← AS-IS table list
│   └── TobeInventory              ← TO-BE table list (unrouted badge etc.)
└── Workspace                      ← receives tableBindingEdits + onBindingChange
    └── TobeMappingDetail          ← key={table.internalName} — one instance per selected table
        ├── CollapsibleBinding     ← source table editor (add/remove AS-IS sources, JOIN/UNION toggle)
        ├── <grid>                 ← mapping rows (filtered, sorted)
        └── Inspector              ← right panel; editing rule/strategy/source/default/notNull
```

### State model

`tableBindingEdits` lives in `MappingPage` (lifted) because the sidebar badge must reflect live edits without navigating away:

```typescript
type TableBindingEdit = {
  sources: TobeTable['sources'];   // current bound AS-IS tables
  mode: 'join' | 'union';
};
// key = table.internalName
const [tableBindingEdits, setTableBindingEdits] =
  useState<Record<string, TableBindingEdit>>({});
```

`effectiveTobe` merges static `TOBE_TABLES` with live edits via `useMemo`:

```typescript
const effectiveTobe = useMemo(() =>
  TOBE_TABLES.map((t) => {
    const edit = tableBindingEdits[t.internalName];
    if (!edit) return t;
    const srcs = edit.sources;
    return {
      ...t, sources: srcs,
      unrouted: srcs.length === 0,
      compositionKind: (srcs.length === 0 ? 'none'
        : srcs.length === 1 ? 'single'
        : edit.mode) as TobeTable['compositionKind'],
    };
  }), [tableBindingEdits]);
```

Row-level edits (`rowEdits`) stay local to each `TobeMappingDetail` instance. `key={table.internalName}` ensures a fresh instance (and fresh `rowEdits`) for each selected table.

---

## Key design decisions

### Skip rows belong to AS-IS, not TO-BE

`rule: 'skip'` rows represent AS-IS columns that are **not being migrated**. They have `tgt: '—'` and no place in the TO-BE mapping grid. They are completely hidden:

```typescript
const visibleRows = useMemo(
  () => allRows.filter((r) => r.rule !== 'skip'),
  [allRows],
);
```

`visibleRows` is the basis for the grid, the filter buttons (All/Unmapped/Passthrough/Transform/Null/Default — no Skip), and the Inspector. The filter bar and Inspector also have no Skip option.

### Unrouted table (zero sources)

When a TO-BE table has no bound AS-IS source, `TobeMappingDetail` still renders in full (no early return). An amber banner at the top prompts the user to open the binding panel, and `bindingOpen` is initialised to `true` when `sources.length === 0`:

```typescript
const [bindingOpen, setBindingOpen] = useState(
  (bindingEdit?.sources ?? table.sources).length === 0
);
```

This avoids the TDZ crash that occurs if you reference another `useState` result before it is declared.

### JOIN/UNION toggle only with 2+ sources

The mode toggle inside `CollapsibleBinding` is conditional:

```typescript
{sources.length >= 2 && (
  <div style={styles.modeToggle}>
    <button>⋈ JOIN</button>
    <button>∪ UNION</button>
  </div>
)}
```

### Transform strategy selector

Each TO-BE column's transform has three modes chosen before editing:

| Strategy | Behaviour |
|---|---|
| `expression` | Opens syntax-highlighted editor; validates SQL expression |
| `null` | Persists `NULL` literal; skips validation |
| `default` | Persists `DEFAULT` literal; skips validation |

Saved as `savedStrategy` in `rowEdits`. Filters `null` and `default` map to `ruleFilter` values of the same name.

### Stale alias cleanup after binding change

When the user removes an AS-IS table from the binding, any saved source references whose alias no longer exists are stripped before saving:

```typescript
const validAliases = new Set(sources.map((s) => s.alias));
const cleanedSrc = rawSrc.filter((s) => {
  if (!s) return true;
  const di = s.indexOf('.');
  const alias = di >= 0 ? s.slice(0, di) : '';
  return !alias || validAliases.has(alias);
});
```

### `+ Add field` (rule: added)

A row-add form appears at the bottom of the grid when the user clicks **+ Add field**. The new row gets `rule: 'added'` and `tgt` = the user-typed name. It is appended to `extraRows` state (separate from the static `rows` prop) and merged via:

```typescript
const allRows = useMemo(() => [...rows, ...extraRows], [rows, extraRows]);
```

Added rows are immediately selectable in the Inspector and support the full strategy/source/default editing flow.

---

## Mock fixtures in MappingPage.tsx (PoC only)

`ASIS_COLUMNS` is a module-level map keyed by `'SCHEMA.TABLE_NAME'`. It must contain entries for **all four** mock AS-IS tables used by `TOBE_TABLES`, otherwise the JOIN source-column dropdown will be empty:

- `'HR.EMPLOYEE_MASTER'` — 14 cols
- `'CRM.CUST_PROFILE_OLD'` — 12 cols
- `'HR.DEPARTMENT'` — 6 cols
- `'HR.POSITION_HISTORY'` — 9 cols

The `resolveSrcType` helper is declared at module level (not inside a component) to avoid TDZ errors inside `useEffect` closures. It looks up a source expression like `e.DEPT_CODE` against `ASIS_COLUMNS` via the alias map derived from `bindingSources`.

---

## What the next person should do

1. **Commit this set** (see commands below) and push `feature/mapping` for review.
2. **Wire MappingPage to real API data**: replace `TOBE_TABLES`, `ASIS_COLUMNS`, and `MAPPING_BY_TOBE` with API calls using `react-query`. Backend endpoints needed:
   - `GET /api/projects/{id}/mapping` — TO-BE table list with current binding
   - `GET /api/projects/{id}/asis-columns` — AS-IS column list per table
   - `PUT /api/projects/{id}/mapping/{tobeTable}` — save binding + row edits
3. **Inspector persistence**: `rowEdits` is currently in-memory per table instance. Decide whether to lift it to `MappingPage` (like `tableBindingEdits`) or persist via API on each save.
4. **Rule validation**: `validateRule()` is a stub. Implement SQL expression parser or at least bracket/quote balance check.
5. **Snapshot creation**: the sidebar has a "Create Snapshot" button stub. It should POST the current `tableBindingEdits` + `rowEdits` to create a mapping snapshot (see Phase model in ONBOARDING.md §3).

---

## Pitfalls / decision history

- **TDZ crash**: `useState(bindingSources.length === 0)` crashed because `bindingSources` was a prior `useState` result not yet in scope. Rule: compute the initial value inline from props, never from another `useState`.
- **`key` on TobeMappingDetail**: required for correct state isolation. Without it React reuses the component instance across table selections and `rowEdits` bleeds between tables.
- **`effectiveTobe` must be the source of truth for DualInventory**: If you pass raw `TOBE_TABLES` to the sidebar, badge counts won't update when the user changes a binding. Always pass the memoised `effectiveTobe`.
- **Filter bar truncation**: use `flexShrink: 0` on the container and `whiteSpace: 'nowrap'` + `padding: '0 8px'` on each button to prevent text clipping.

---

## Intentionally not done

- API integration (all data is mock fixtures).
- Snapshot creation / save-to-backend flow.
- AS-IS table view inside the mapping screen (out of scope for this session).
- Rule engine integration (Layer 1 / 2a / 2b from ONBOARDING.md §4).
