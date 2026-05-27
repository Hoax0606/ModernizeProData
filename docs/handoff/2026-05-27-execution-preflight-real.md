# 2026-05-27 — execution-preflight-real (onda)

## What was done

- `lib/preflightValidation.ts` 新設. 7 チェックを mock 全 pass から **実データ判定**へ置換.
  per-table 化 + `aggregate / perTable` 形式. `tobe-bindings` / `unmapped-cols` は
  snapshot bindings / rules ベース, `unmapped-cols` は全カラム (`skip` rule は明示除外で OK),
  `asis-unmapped` は **per-AS-IS-table** 構造(TO-BE keyed だと AS-IS 側 Fix routing
  に渡せないため反転).
- `pages/ExecutionPage.tsx`: pin が無いと preflight / start 全部 disable. `runMode` を
  BE `RunService.resolveRunTypeFromPhase` と一致させて phase × env から導出
  (`ready` 以外も `test` 扱い, non-prod は `cutover/hypercare/done` 以外起動可).
  phase 自動進行は **forward-only**(test → planning に戻さない).
- `conn-tobe`: `tobeDbApi.testConnection` を **preflight 内で live 実行**, 結果を
  `runPreflight` に渡す. `csv-arrived`: 選択 TO-BE → bindings → AS-IS テーブル集合を
  抽出, `csvPreviewApi.forTable(siteId, asis, 1)` で per-AS-IS-table 存在チェック.
  per-table fix が project-wide 設定画面に集約される checks 用に
  `fixIsProjectWide` フラグを追加.
- `store/executionPreflight.ts`: `preflightResults` 撤去, `bySnapshot[snapshotId]` を
  唯一の真実に. `appendSnapshotResultCheck` で逐次 append. persist v4 → v5.
- `pages/VersionsPage.tsx`: Request Review ゲートを「**cache の selectedTables が
  DDL 全 TO-BE を網羅** + all-pass + cache 存在」3 条件 AND に強化. tobeDdl fetch も
  ここで発火. 部分選択 cache では disabled + tooltip 表示.
- `pages/MappingPage.tsx`: `fixTarget.table` matcher に `tt.short` (physical name)
  追加 — DDL に schemaName ありの環境で fix が default selection になる問題を解消.

## What the next person should do

- **BE `DuckDbService` の並列セーフ化** — 暫定で `startPreflight` の csv-preview 呼び出しを
  `for...of await` 直列に変えてあるが (`ExecutionPage.tsx:240`), 根本は BE 側で connection
  per-request か synchronized 化が必要. 並列で叩くと `Invalid Input Error: Attempting to
  execute an unsuccessful or closed pending query result` がランダムに 1 件出る.
- preflight 結果の BE 永続化 (現状 zustand persist のみ). 将来 BE で
  `stage_instances` に書く想定なら、そちらと統合.
- CSV 到着の本格判定: 現状 `csv-preview` で 1 行だけ読んで存在確認しているが、空ファイル /
  不正 CSV だと 500 で「missing」扱いになる. `CheckStage` / `ExtractStage` (dev マージで
  入ったがまだスタブ) の完了フラグ参照に移行するのが筋.

## Pitfalls / decision history

- TableSelector は **部分マイグレーション要件のため残す** (一見 dead に見えるが意図的).
  Execution startrun は部分選択 pass で OK, Request Review だけ全テーブル網羅必須.
- `csv-arrived` の per-table 行に Fix ボタンは出さない — どの AS-IS テーブルで fail でも
  飛び先は SiteSettings → CSV section の 1 ヶ所だから. `fixIsProjectWide: true` で制御.
- `displayedPhase` は store の `preflightPhase` 直読みでなく `cachedResults.length` から
  derive. pin 切替で「前 snapshot の結果が残る」問題を回避するため.
- React の `border` / `borderColor` shorthand 混在警告がコンソールに出ている. 機能に
  無関係なのでこのブランチでは無視. 別途クリーンアップ.

## Intentionally not done

- TableSelector の削除 (上記理由).
- `csv-arrived` の per-table 失敗詳細 (BE error message を出す) — ユーザ判断で保留.
- BE 側 `/sites/{id}/csv-status` bulk endpoint 追加 (Opt 2) — Opt 1 (per-table 並列→直列)
  で当面足りる.
- React style warning 修正.
