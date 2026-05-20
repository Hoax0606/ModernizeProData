# 2026-05-20 — artifacts-page (Im Jiyeong)

## What was done

- **Replaced `/artifacts` PlaceholderPage with a new `ArtifactsPage`** (`frontend/src/pages/ArtifactsPage.tsx`). Ported the structure of `Prototype/src/artifacts.jsx` to TypeScript — sidebar tree with 6 categories (Dashboard / Diff / DDL / SQL / Mapping / Validation) and an Excel-style workbook chrome (title bar, ribbon, Name Box + ✕/✓/fx + formula bar, sheet tabs).
- **Empty state shows category-aware hints** — each category renders a placeholder summary in the formula bar slot (e.g., `Schema diff: {ASIS} → {TOBE} · +n added · -n removed · ~n typed`) plus the expected sheet tab names (e.g., `Diff · Summary · ASIS · TOBE`), so reviewers see what each slot will eventually hold.
- **i18n keys (`artifacts.*`)** added to `ko/ja/en` per CLAUDE.md convention (titles + category labels in shared English; subtitle / hint / empty messages translated).
- **Memory note** at `~/.claude/projects/.../memory/project_artifacts_formula_bar.md` records the chosen "Plain title + stats" format for the formula bar summary (chosen over function-call / badges / labeled-fields alternatives).

## What the next person should do

The page is a **structural shell** — no store / API wiring yet. Hot path:

1. **Wire DDL category to real data first.** `frontend/src/store/asisDdl.ts` and `tobeDdl.ts` already expose imported tables/columns per project. Replace the empty DDL category items with actual DDL tables, render `CREATE TABLE` output via a dark code viewer (port `genDDL()` from prototype).
2. **Schema diff next** — when both AS-IS and TO-BE DDL are imported, compute a name-based diff (added / removed / typed only; rename detection needs mapping data which doesn't exist yet).
3. **Other categories defer** until their backend lands:
   - Mapping → mapping module not started
   - Migration SQL → depends on mapping rules
   - Validation → depends on run results
   - Dashboard → depends on mapping-progress aggregation
4. Keep the per-category constants (`SUMMARY_PLACEHOLDER`, `SHEET_NAMES`) and the `EmptyExcelWorkbook` component as-is. Wiring is replacing the empty body, not redesigning the chrome.

## Pitfalls / decision history

- **Ribbon (File / Home / ... / View) and the A1 Name Box are decorative only.** No active tab, no click handlers — kept purely to make the workbook look authentically Excel-like. Do not wire them.
- **`⋮` (vertical ellipsis) lives inside the gray spacer** between the Name Box and the `✕ ✓ fx` group. Final layout was iterated several times before settling: `60px Name Box | 20px gray spacer with centered ⋮ | white area with ✕ ✓ fx | formula content`.
- **Categories are clickable to toggle expand/collapse + switch the right-pane view.** When an item (file) is selected, the parent category is *not* highlighted — only the item gets the navy accent. This avoids two-row highlight ambiguity.
- **Tree-line characters `├─ / └─` were tried then removed** — user preferred plain indentation. Items use 32px left-padding for the hierarchy cue.
- **Bottom subtitle caption was removed** ("매핑 스냅샷·DDL·검증 리포트…") — caption felt redundant once the chrome had its own labels.
- **Demo mode `?demo=1` was built and used during this session for visual review, then removed before commit.** The demo lived in a sibling file (`ArtifactsPage.demo.tsx`, ~750 lines) with hardcoded mock data (CUST_M / ACCT_M / TXN_H — Japanese banking schema with EBCDIC / COMP-3 / YYYYMMDD / merge cases). It used `xlsx-js-style` (SheetJS fork with style write support) to produce real multi-sheet `.xlsx` downloads matching the on-screen palette (kind tints, zebra striping, status/verdict badges, grid borders, auto column widths). If you need to re-add it later for review, recover from git history — but treat it as throwaway preview code, and remember the dependency must be uninstalled before merge.

## Intentionally not done

- **No data wiring.** The page renders empty regardless of project state — DDL imports, mapping data, run results are not read.
- **Export all + per-artifact Download buttons disabled.** Will be wired once at least one category has real data.
- **Mapping / Migration SQL / Validation / Dashboard categories have no view logic** beyond the empty placeholder. They wait for their respective backend modules.
- **No tests.** The page is a visual shell; meaningful tests can be written when data wiring starts.
