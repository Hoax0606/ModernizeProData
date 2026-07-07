# 2026-05-22 — License feature + standalone Issuer

## What landed

End-to-end license layer: Ed25519-signed `.lic` files issued at HQ, uploaded
and verified at the customer Coordinator, with expiry stages, enforcement
filter, clock-rollback detection, and a standalone Swing-based issuer app
packaged via jpackage.

See `docs/ONBOARDING.md` §18 for the full design. This handoff covers what
the next session needs to know to continue.

## Branch / scope

- Branch: `feature/license`
- Backend: new `coordinator/license/` package, `LicenseController`,
  one Flyway migration (`V20260522114140__license.sql`), enforcement filter
  wired in `SecurityConfig`.
- Frontend: new `api/license.ts`, `store/license.ts`,
  `components/LicenseBanner.tsx`. `SolutionSettingsModal.LicenseCard`
  rewritten to call real backend.
- New module: `ModernizeProDataBridge/issuer/` — Maven (Spring-free), CLI +
  Swing GUI, jpackage build script.

## Built and verified

- `backend/mvnw package` — green.
- `frontend/npx tsc --noEmit` — green.
- `issuer/build-exe.ps1` — produces `target/dist/LicenseIssuer/` with
  `LicenseIssuer.exe` + `LicenseIssuerCli.exe`, bundled JRE,
  PNG-embedded `.ico`. Keypair under `license/` is preserved across
  rebuilds.

## Operational rules (read before touching)

1. **Never regenerate the issuer keypair.** Embedded public key in
   backend would no longer match. Rotation = full backend rebuild +
   redeploy to every site. There is an existing safeguard in
   `KeyManager.generate()` (refuses if `private.pem` already present), but
   it can be bypassed by deleting the `license/` folder. Document this
   when handing off to non-engineers.
2. **`build-exe.ps1` preserves `license/` via `%TEMP%` move-and-restore.**
   Do not "simplify" this back to a plain `Remove-Item -Recurse` on the
   dist folder — keys will be wiped.
3. **`statusOf()` and the days-remaining DTO must use
   `ChronoUnit.DAYS.between`, not `Period.getDays()`.** The latter returns
   only the day component (a year-out license reports 0 days, gets
   classified as EXPIRING). This was a real bug, fixed here.

## Three reusable utilities introduced

- `LicenseSealedClock` (AES-GCM sealed last-seen file) — could be reused
  for any anti-clock-rollback feature.
- `Icons.java` in the issuer — `calendar`, `folder`, `lock`, `unlock`
  vector icons painted via Graphics2D. Reusable inside the issuer module.
  Not exposed to backend/frontend.
- `DatePickerPopup` — non-modal, anchor-relative month-view calendar.
  Toggles off on icon re-click and on focus loss (with a 200ms suppress
  window to avoid the "click closes then immediately reopens" race).

## i18n keys added (synced across ko/ja/en)

```
solution.license.status.ACTIVE / EXPIRING / IN_GRACE / READ_ONLY / EXPIRED / MISSING / INVALID
solution.license.upload.ok / .invalidSig / .failed
solution.license.clearDev / .clearDev.confirm / .clearDev.failed
license.banner.expiring / .inGrace / .readOnly / .expired / .missing / .invalid
```

The status labels are identical English across all three languages per
the project i18n convention; the upload / banner / clear messages are
translated.

## Known gotchas

- jpackage on Korean Windows + Cross-Platform L&F fails to render Hangul
  in tooltips (the JRE's font composite doesn't pick up the system
  fallback). Fix: use System L&F. This is already applied in
  `IssuerGui.launch()` — do not revert.
- PowerShell 5.1 reads BOM-less UTF-8 `.ps1` files as CP949 on Korean
  Windows, which mangles non-ASCII output. `build-exe.ps1` and
  `make-ico.ps1` are saved with UTF-8 BOM. Re-saving them with a basic
  editor that strips BOM will break the build messages.
- `import.meta.env.DEV` (Vite) gates the dev-only `Clear (dev)` button on
  the frontend. Production builds will not see it.

## Not done — pick up next session if needed

- Per-customer keypair (currently one global keypair for all customers).
- Hardware binding (machine UUID inside payload, verified on each
  request).
- Backend automation for rotation: a CLI/UI flow that rebuilds backend
  with new public key and produces a redeployment bundle.
- Multi-resolution `.ico` (currently single 256×256 PNG-embedded —
  Windows downscales for the smaller display sizes). `make-ico.ps1` could
  be extended to include 16/32/48/256 explicit sizes.

## Files touched (high signal)

```
backend/
  src/main/java/.../coordinator/api/LicenseController.java               (new)
  src/main/java/.../coordinator/license/                                  (new package)
  src/main/java/.../common/config/SecurityConfig.java                     (wires enforcement filter)
  src/main/java/.../coordinator/api/SiteController.java                   (removed MULTI_SITE feature gate)
  src/main/resources/db/migration/V20260522114140__license.sql            (new)
  src/main/resources/license/public-key.pem                               (must exist; created at first setup)

frontend/
  src/api/license.ts                                                       (new)
  src/store/license.ts                                                     (new)
  src/components/LicenseBanner.tsx                                         (new)
  src/components/SolutionSettingsModal.tsx                                 (LicenseCard rewritten)
  src/layout/AppShell.tsx                                                  (banner mount + polling)
  src/i18n/{ko,ja,en}.ts                                                   (status / upload / banner / clearDev keys)

issuer/                                                                    (new module)
  pom.xml
  build-exe.ps1
  make-ico.ps1
  installer/launcher-cli.properties
  src/main/java/com/ksinfo/license/issuer/
    DatePickerPopup.java
    Icons.java
    IssuerCli.java
    IssuerGui.java
    IssuerMain.java
    KeyManager.java
    LicenseDocument.java
    LicenseSigner.java
  src/main/resources/com/ksinfo/license/issuer/
    mpd.png   (copied from frontend/public/mpd_lic.png)
    mpd.ico   (generated)
```
