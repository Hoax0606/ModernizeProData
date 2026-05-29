# 2026-05-26 — dashboard-rework (onda)

## What was done

- `DashboardPage.tsx`: per-project ダッシュボードを実データ駆動に. TO-BE 行クリック → Mapping
  画面の該当テーブルへ遷移 (`navigate('/mapping', { state: { focusTable: { internalName }}})`).
  MAPPING PROGRESS 列を 2-segment (緑=mapped, 赤=unmapped) + `m/n` の 1 列に統合
  (旧 COLUMN COVERAGE + ISSUES を撤去). RUN STATUS カードを `useExecutionPreflightStore`
  の `activeRun` 直結, ExecutionPage の StatusBadge と同じ色マッピング.
- `DashboardPage.tsx` SiteOverview (= AllProjects): KPI 3 タイルを `mappingImportApi.listRules`
  全プロジェクト並列 fetch で実値化 (READY tables / mapped columns). per-row Tables 列を
  `ready / total` 形式に. Preflight 列を完全削除. Phase mix 右パネルは 9 フェーズ全表示で,
  `test` / `rehearsal` のみ idle (色なし) → running (色付き) の 2 行構成. cutover は実行中
  専用フェーズなので 1 行 (色付き) のみ.
- `MappingPage.tsx`: Dashboard から渡される `location.state.focusTable` を受けて該当 TO-BE
  テーブルを `setSelected`. `consumedFocusKeyRef` + `routerNavigate(replace)` で多重発火防止
  (`window.history.replaceState` だけだと React Router の location.state が残って
  hydrationTick の度に再適用される).
- `AppShell.tsx`: グローバル active-run finisher を追加. ExecutionPage 内に閉じていた
  「elapsed >= TOTAL_RUN_MS で completed に推移」処理が, 他ページ滞在中は動かず project の
  `runStatus` がサイドバー色に反映されない問題を解消.

## What the next person should do

- Inspector 開閉の改善は別ブランチ (feature/mapping 系) でやる予定なので, このブランチでは
  触らない. 参考: `MappingPage.tsx:1332` 行クリックが `setActiveIdx` のみで
  `setInspectorOpen(true)` を呼んでいない問題.
- `mappingImportApi.listRules` を SiteOverview で N+1 fetch している. プロジェクト数が大きく
  なれば bulk endpoint (`/projects/{site}/mapping/rules`) を BE 側で生やすか, 既存
  `mapping/status` の戦略別 ruleCount を増やして対応する.
- Global active-run watcher は 500ms 固定ポーリング. WS イベント駆動に置き換えるなら
  `executionPreflight` store の subscribe + `setTimeout` で残り時間ジャストにスケジュールする
  パターンに変更可.

## Pitfalls / decision history

- `phaseChipColor(phase)` は test/rehearsal/cutover で `runStatus` 省略時に「色なし」を返す.
  Phase mix の colored 行で色を出すには明示的に `phaseChipColor(phase, 'running')` を渡す
  必要がある. 一度ハマった.
- SiteOverview の rules → DDL マッチは MappingPage と同じく qualified-first /
  short-fallback で揃えた. `rules.tobeSchema` が null・DDL 側に schemaName あり, のような
  片方欠落のケースで READY 数が under-count されるバグの原因だった.
- Dashboard の MAPPING PROGRESS bar は readiness 別の単色ではなく, mapped/unmapped を
  そのまま緑/赤に塗り分ける方針 (Mapping ページの `TobeCoverageBar` と同様).
- RUN STATUS カードは LAST RUN → ACTIVE RUN → RUN STATUS と二度リネームしている. 表示元は
  `useExecutionPreflightStore.byProject[id].activeRun` (フロントエンドモック state) であり,
  backend `runsApi.listByProject` ではない. backend と統合される際は src を差し替える.

## Intentionally not done

- MappingPage Inspector 開閉バグ (別ブランチ予定).
- 旧 i18n key `siteOverview.col.preflight` / `siteOverview.col.mappingRows` のクリーンアップ
  (使われなくなったが手で消すか自動 lint を待つか保留).
- バックエンドの bulk mapping-rules endpoint 追加.
