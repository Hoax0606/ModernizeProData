# 2026-05-24 — Installer Phase 1 (Coordinator MVP)

## What landed

A single-script Windows .msi pipeline for the main tool. `installer/build.ps1`
takes the project from `git pull` to a one-double-click installer that drops a
JavaFX-shelled Spring Boot + Vite-built React app under
`%LOCALAPPDATA%\ModernizeProData\`.

Phase 1 scope is Coordinator-only. Phase 2 (first-boot mode wizard for
Client / Standalone) and Phase 3 (license hardening) are deferred.

See `docs/ONBOARDING.md` §19 for the design. This handoff is the next-session
operational primer.

## Branch / status

- Branch: `feature/installer`
- Backend: new `launcher/Launcher.java` (JavaFX shell), `common/config/
  SpaFallbackController.java`, `application-prod.yml`, SecurityConfig static
  permitAll, JavaFX `provided` deps + `<start-class>` in pom.
- Frontend: `.env.production` with empty `VITE_API_BASE_URL` (same-origin).
- New module: `ModernizeProData/installer/` — `build.ps1`, `make-ico.ps1`,
  `assets/` (icon staging).
- Documentation: ONBOARDING §19, this handoff.

## Verified

- `frontend/npx vite build` → green, dist 9 files.
- `backend/.mvnw -DskipTests package` → green, fat jar 178MB,
  manifest `Start-Class=Launcher` confirmed.
- Backend compile is green with the new Launcher + JavaFX provided deps.

## NOT yet verified (blocked on environment)

- `jpackage --type msi` step requires **WiX Toolset 3.14** installed and on
  PATH. Build PC currently has none. The script throws an actionable error
  message at step [0/7] if missing.
- Smoke test (install / launch / login) — needs the .msi.

## What the operator must do before the next build

1. Install WiX 3.14 from
   <https://github.com/wixtoolset/wix3/releases/tag/wix3141rtm> → run
   `wix314.exe`. Adds `C:\Program Files (x86)\WiX Toolset v3.14\bin` to PATH.
   Confirm with `light.exe -?` in a fresh PowerShell.
2. Ensure PostgreSQL 18 is running on `localhost:5433` with DB `mpd_meta`
   accessible by user `mpd` / password `mpd` (matches CLAUDE.md default and
   `application-prod.yml`).
3. `cd ModernizeProData\installer; .\build.ps1`. First run also downloads
   ~30MB JavaFX SDK 21.0.4 into `installer\cache\` — subsequent runs reuse.
4. Output: `installer\dist\ModernizeProData-1.0.0.msi`.

## Operational rules (read before touching)

1. **All `.ps1` files keep UTF-8 BOM.** PS 5.1 + Korean Windows reads
   BOM-less UTF-8 as CP949. `build.ps1` is currently ASCII-only output to
   avoid encoding regressions; if you add Korean text, save with explicit
   UTF-8 BOM via `[System.IO.File]::WriteAllText(..., $utf8Bom)`.
2. **Do not turn the installer staging deletes into a wholesale
   `target/dist` wipe.** Mirror issuer's pattern: only delete what the script
   writes (`staging/`, `dist/`). If we add per-user state to this folder in
   the future (license materials, captured certs), it MUST be preserved across
   rebuilds.
3. **JavaFX must be `provided` scope** — keeping it in the fat jar
   confuses Spring Boot Loader's classloader and gives split-module errors at
   launch. The runtime comes from JavaFX SDK + jpackage `--module-path`.
4. **Frontend build uses `npx vite build`, not `npm run build`.**
   `npm run build` includes `tsc -b` which fails when other feature branches
   on `dev` have in-progress TS errors (currently several in MappingPage /
   VersionsPage / SiteQuarantinePage). vite build alone still gives a working
   bundle.
5. **`mpd.gui.enabled` system property is the dev / installed switch.**
   jpackage launcher sets it via `--java-options "-Dmpd.gui.enabled=true"`.
   `mvn spring-boot:run` does not, so JavaFX never initializes during dev.
   Both code paths share the same `Launcher.main` entry.
6. **`<start-class>` in `backend/pom.xml` controls both the spring-boot-
   maven-plugin `run` goal AND the repackaged manifest's `Start-Class`.**
   Changing it changes dev behavior too. If you need dev to keep using
   `ModernizeProDataApplication`, override the plugin's `mainClass` separately
   for the `run` goal.

## Known gotchas

- **WiX 4 is incompatible with jpackage.** `build.ps1` checks for `light.exe`
  on PATH and prepends WiX 3.x install dirs if found. If only WiX 4 is
  installed, the build fails. Cannot have both side by side easily — pick 3.x.
- **JavaFX SDK download from Gluon CDN.** First-run only, but you need
  outbound network. For an air-gapped build PC, pre-populate
  `installer\cache\openjfx-21.0.4-sdk.zip` from a network-attached PC.
- **`open-in-view: false` in application-prod.yml** is stricter than dev.
  If you see new `LazyInitializationException` in prod that don't appear in
  dev, this is the cause — fix the JPA-side eager fetch, don't relax the
  prod setting.
- **fat jar is 178MB**, .msi will be ~130–160MB after compression + JRE +
  JavaFX. Acceptable, but watch for >200MB drift if dependencies bloat.
- **Spring Boot devtools auto-disabled** in prod profile (livereload +
  restart). If you're tracking why hot-reload doesn't work in installed
  mode — by design.

## Not done — pick up next session

- Run `build.ps1` end-to-end on a PC with WiX → produce the .msi.
- Smoke test on a clean Windows account (separate user profile is the easy
  alternative to a VM).
- Phase 2: first-boot mode wizard (Coordinator / Client / Standalone).
- Phase 3: license fingerprint + per-customer keypair.
- Multi-resolution `.ico` (currently single 256×256 PNG-embedded). Start
  Menu small icons may look slightly soft. Extend `make-ico.ps1` if it
  becomes a complaint.

## Files touched (high signal)

```
backend/
  pom.xml                                                              (JavaFX deps, start-class)
  src/main/java/.../launcher/Launcher.java                              (new)
  src/main/java/.../common/config/SpaFallbackController.java            (new)
  src/main/java/.../common/config/SecurityConfig.java                   (static permitAll)
  src/main/resources/application-prod.yml                               (new)

frontend/
  .env.production                                                       (new — empty VITE_API_BASE_URL)

installer/                                                              (new module)
  build.ps1
  make-ico.ps1
  assets/                                                               (mpd.ico generated here)
  cache/                                                                (JavaFX SDK cache, .gitignored)
  staging/                                                              (jpackage input, .gitignored)
  dist/                                                                 (output .msi, .gitignored)

.gitignore                                                              (installer artifacts + static/)
docs/ONBOARDING.md                                                       (new §19)
```
