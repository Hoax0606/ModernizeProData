# 2026-05-20 — site-settings-lock-ux (Hyunho)

## What was done

Tightened the Site Settings / Project Settings lock UX and resolved several
inconsistencies around DB lock state, CSV path workflow, and modal layout.

- **Site Settings — two-step lock model**
  - **DB lock** (per-stage): master can always toggle `tobeDbLocks[stage]`
    regardless of saved/unsaved state or field contents. Reflected in the DB
    card header as a `LockIcon` button and in `StagePills` (small lock icon
    when a stage is locked).
  - **Site-level edit lock** (whole modal): new chip in the Site Name field
    label row — `Site locked` (green) / `Site unlocked` (amber, mono caps).
    Toggling to `locked` is gated by **two conditions**:
    (a) site name non-empty, and (b) current stage's DB lock is on
    (`tobeDbLocks[stage] === true`). If either fails, the chip is visually
    disabled (`opacity 0.45 + cursor: not-allowed`) with a tooltip explaining
    which condition is missing. **Save** is enabled only when site is locked.
  - On save (`handleSave`), data-bearing stages have their lock forced to
    `true` — guarantees that reopening the modal always shows DB locked.
- **`StagePills` dot color** now driven by `isDbConfigured(byEnv[env])`:
  green if all of `type/host/database/username` are present, red otherwise.
  Applied identically in `SiteSettingsModal` and `CreateSiteModal`.
- **Sidebar (`AppShell`)**: replaced the binary DB-configured dot next to the
  active site name with a stage chip (`DEV` / `TEST` / `STG` / `PROD`),
  green-filled when configured / red-filled when not.
- **Modal layout**: `Modal` got a new `headerRight` prop slot. When provided,
  it replaces the default `✕` close button. `SiteSettingsModal` uses it to
  place `[Close] [Save]` in the header. Site name + project count · created
  meta moved into the modal title; body footer removed. Danger Zone stays at
  the bottom of the body.
- **CSV path workflow**
  - `CsvPathField`: added `<input type="file" webkitdirectory>` fallback for
    browsers without `showDirectoryPicker` (Firefox/Safari). Chromium +
    secure context still uses the native directory dialog.
  - Project Settings AS-IS `CsvSourceCard` now reads/writes `site.csvPath`
    (was a local `useState` doing nothing). Save calls `updateSite`. Layout
    rebuilt from horizontal `PSRow` to vertical `label → field → right-aligned
    Save row` because the row was visually cramped.
- **Project Settings — General**: name edit toggle is now a `LockIcon`
  button (green outline) instead of a text "Lock/Unlock" button. The "잠금
  해제 후 편집할 수 있습니다." hint was removed entirely. `envChip` color
  switches to red when the site's current-stage DB is not configured.
- **Project Settings — TO-BE**: removed the "이행 대상 데이터베이스입니다."
  desc (PSHead.desc made optional). Also fixed the "TO-BE DDL · 대상 DB"
  sidebar desc by stripping the "· 대상 DB" tail in all three locales.
- **New shared component**: `src/components/LockIcon.tsx` — small SVG with
  `open` / `color` / `size` / `title` props. Used in three places
  (SettingsPage name lock, SiteSettingsModal site lock chip + DB lock button
  + StagePills lock indicator).
- **i18n**: 6 new keys (`siteSettings.lock.title`, `unlock.title`,
  `siteLock.locked`, `siteLock.unlocked`, `siteLock.blockedDbUnlocked`,
  `siteLock.blockedNameMissing`) added to ko/ja/en. Per the
  CLAUDE.md i18n policy `.title` is English-uniform across locales; messages
  (`blocked*`) are localized. Removed: `projectSettings.general.lockedHint`.
  Updated: `projectSettings.csv.title` (dropped "(CSV)"),
  `projectSettings.sidebar.target.desc` (dropped "· 대상 DB").

## What the next person should do

- **Backend `tobeDbLocks` persistence**: confirm the meta DB persists
  `tobeDbLocks` as a jsonb on `sites` and that the JPA mapping serializes a
  `Map<String, Boolean>`. The frontend now always writes `true` for every
  data-bearing stage on save, so any stage with data should round-trip
  locked. If old rows have inconsistent lock state, a one-shot Flyway
  backfill might be worth it.
- **Worker UX for site-level lock**: currently `siteUnlocked` is purely
  client-side state (resets to `false` every time the modal opens). Worker
  role can still toggle the site lock chip — that's fine for editing
  non-DB fields, but consider whether worker should be allowed to unlock at
  all (right now `toggleSiteLock` has no role guard, unlike `toggleStageLock`
  which is master-only).
- **Browser file picker limitation**: `CsvPathField` can only get the folder
  *name*, not the absolute path. Per `CLAUDE.md` we ship as jpackage — once
  the desktop wrapper is decided (likely a small JavaFX host or similar),
  replace the browser pickers with a native dialog that returns the full
  path.

## Pitfalls / decision history

- **Why guard site lock on *current* stage only, not all stages?** Earlier
  iteration checked every stage with data. User pushback: "딱 Site name과 db
  lock이 되었는지만 확인" — only what the user can currently see should
  block. Other stages' lock state is enforced via `handleSave` forcing all
  data-bearing stages to `locked = true` on persist.
- **Why force DB lock = true on save instead of preserving user state?**
  Previous behavior `tobeDbLocks[env] = tobeDbLocks[env] ?? true` allowed an
  unlocked stage to be saved unlocked, so reopening the modal showed it
  unlocked — user reported this as a bug. The new contract: anything saved
  is locked; unlock is a transient editing mode only.
- **Why `headerRight` slot instead of always rendering ✕?** User wanted
  Close/Save in the header (not in body footer). Couldn't drop ✕ from
  every modal — existing modals still want it. `headerRight` prop is
  opt-in; default ✕ stays for modals that don't pass it.
- **Why `webkitdirectory` fallback rather than only `showDirectoryPicker`?**
  We dev/test on Chrome where the modern API works, but devs on Firefox
  hit the `window.prompt` fallback which was awful UX. Both paths now open
  a real folder dialog.
- **`amber` for unlocked, `green` for locked** — inverse of intuition, but
  matches the rest of the codebase (DDL lamp / DB status: green = settled,
  warning colors = "needs attention / in flight"). Editing state is the
  "in flight" state.

## Intentionally not done

- No backend changes in this PR. `tobeDbLocks` schema unchanged; frontend
  contract change only.
- Did **not** touch `CreateSiteModal` further beyond the small consistency
  fixes already in. New sites are created unlocked; `siteUnlocked` modal
  flow only applies to existing-site editing.
- Did **not** remove the now-unused styles (`dbLockTag`, `dbUnlockBtn`,
  `dbCoordOnly`, `metaRow`, etc.) in `SiteSettingsModal.tsx` — left in
  place to avoid noise in the diff; safe to clean up in a follow-up.
- Did **not** rename `siteSettings.unlock` (the old short-form lock chip
  label, still used as a tooltip in DB card) — kept for backward
  compatibility with existing translations.
