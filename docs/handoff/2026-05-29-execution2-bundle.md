# 2026-05-29 — execution2-bundle (Hiroyuki)

`feature/execution2` 上の複数 UI / BE 改修をまとめてコミット + `dev` マージ。
8 機能 + 1 phase eligibility 修正 + dev merge。PR 1 本で出す想定。

## やったこと

- `feat(ddl)`: DDL **ReImport = Delete + Import** に統一。re-import が
  mapping_rules / bindings / code_maps を wipe する (`DdlImportService.importDdl`)。
  旧仕様の「軽い DDL 修正で mapping 保存」より silent inconsistency リスクを優先。
- `feat(versions)`: Request Review ゲートを **「全 TO-BE テーブルの最新 run = success」**
  に変更。新 `ProjectRunReadinessService` + `GET /api/v1/projects/{id}/run-readiness`。
  binding 単位の `stage_table_results` で per-table 判定 (partial failure 後も
  正常 table は success 維持)。
- `feat(history)`: Run History に **per-table drill-down** 追加 (`RunTableResultsService`
  + `GET /api/v1/runs/{id}/table-results`)。Tables 列を summary badge (3✓ 1✗) に、
  ms 精度 timestamp、Run ID 列追加、duration ツールチップ。LogViewerPage + SchedulerPage 両方。
- `fix(execution)`: ExecutionOverview の Progress 7-bar 桁ずれ修正。BE が per-stage
  `stages[]` を返し FE は共通 renderer (`buildStagesFromStageViews`) 通過。
- `feat(layout)`: AppShell sync を heavy (10s sites/snapshots/audit) と light (2s projects) に
  分離。phase badge の running 色が Execution の 2s progress と同周期で更新。
- `refactor(runs)`: **`/runs/all` siteId 必須化** (`StartAllRequest`)。複数 site
  ホスト Coordinator での PROD/TEST 同時発火事故防止。
- `feat(scheduler)`: SchedulerPage を **active site scope** に限定。curl 例 /
  project schedule / history すべて active site のみ。
- `refactor(scheduler)`: scheduler 自動 trigger を **sign-off + ready phase 限定** に。
  `resolveRunTypeFromPhase` の default = test を廃止して empty (REJECTED) に。
  両 phase とも snapshot Request Review 通過後なので、preflight 永続化なしで
  「mapping 検証済み」を phase 自体で暗黙保証。

## 次のひとがやること

- **動作確認**: BE 起動 → 各機能の golden path 検証 (Request Review ゲート / drill-down /
  scheduler 起動拒否 等)。Lint / format も未走らせ。
- **push + PR**: `origin/feature/execution2` から 11 commit 先行。PR title は
  「execution2: RunHistory drill-down + Request Review gate + scheduler hardening」 等。
- **orphan binding 対応**: 既存 project に DDL 不在の binding (`public.orders` /
  `public.employees` 等) が legacy 残骸として残るケース確認済。今回は意図的に
  cleanup 未実施 — 別ラウンドで FK 制約 or run-time filter 検討。
- **cutover lifecycle**: `ready → cutover` 自動遷移 / `cutover → hypercare`
  完了遷移は未実装のまま。scheduler が ready で cutover 起動できるところまで。

## 함정 / 決定 이력

- **preflight DB 永속화 vs scheduler phase 限定**: 当初は preflight 結果を DB
  永続化して run gate で参照する案を検討、`BackendPreflightService` /
  `preflight_runs` テーブル / `RunService.startRun` の 2 段 gate を一度実装 →
  「他ブランチで作業中」と聞いて全 revert → 結局 「scheduler を sign-off + ready
  限定にすれば phase 自体が preflight 通過の保証」 の方向で着地。code は本セッションで
  完全 revert 済。
- **dev merge conflict**: `LogViewerPage.tsx` の import 1 行のみ。両方 union で解決
  (snapshot store + formatTimeMs)。他 ファイル は 자동 마지。
- **phase 遷移ロジックの散在**: `DdlImportService` / `RunService.maybeAdvancePhase` /
  `ApprovalsPage` (FE!) の 3 箇所。snapshot approve の phase 遷移が FE 駆動なのは
  API client 経由の approve が phase 反映しない脆さ — 別ラウンドで BE 化。
- **`mapping_table_bindings` の orphan 構造的問題**: `tobe_table` が単なる
  denormalize string で FK 制約無し → snapshot restore 経路で再混入の可能性が
  残る。コスト無視なら `tobe_ddl_table_id` FK + cascade が本筋だが、PoC 期間は
  service 層 cascade のみで凌ぐ判断。

## 안 한 것 (의도적으로)

- preflight DB 永続化 (他ブランチ担当のはずだが、現状 dev / 他 branch にも未実装)
- 既存 orphan binding の cleanup (`public.orders` / `public.employees`)
- 3 mapping テーブルへの FK + cascade 構造的整合性 (PoC 後)
- `SnapshotController.setBaseline` の current DDL 互換性 ガード (orphan 再流入経路)
- cutover ライフサイクル (ready → cutover 自動進行 / hypercare 遷移)
- handoff 以外の docs (ONBOARDING / CLAUDE.md) はこの PR では触らず、別 update で
