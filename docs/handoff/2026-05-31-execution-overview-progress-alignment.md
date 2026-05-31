# 2026-05-31 — Execution Overview 進捗バー / Running KPI / 列センター寄せ (Hiroyuki)

All projects → Execution overview 画面の細かい修正 3 点. ExecutionPage 本体は触らず,
Overview 側と BE の `ExecutionOverviewService` のみ.

## やったこと

- `fix(overview): pct formula align with derivePct`
  Per-row pipeline bar が Execution 画面の Pipeline Stages 表示とずれていた件.
  `ExecutionOverviewService.toSummary` が **running 時 `round(100*(ok+failed)/total)`** /
  **failed 時 `round(100*ok/total)`** だったのを,
  `StageController.derivePct` と完全に同じ
  `switch { pending=0, success=100, running|failed = floor(100*ok/total) }` に統一.
  例: 5 件中 success 3 / failed 1 / running 1 で Execution=60% / Overview=80% だったのが揃う.
- `fix(overview FE): pass ctx.stages into merged metric`
  上の BE 修正だけでは pinned snapshot 経路で直らなかった. `ExecutionOverviewPage` の
  `metrics` useMemo で `ctx.executionContext.stages` を `merged[p.id]` に渡し忘れていて,
  `buildStagesFromMetric` が fallback (progressPct 近似) に落ち, failed 段が **常に
  pct=100 で赤 full bar** として描画されていた. `stages: ctx.stages.map(...)` を追加して
  `ExecStageSummary` 形に正規化 (null→0) し, `buildStagesFromStageViews` 経路へ.
- `fix(overview): Running KPI use runStatus not phase`
  画面上部 KPI 「RUNNING」が `runningPhases.includes(p.phase)` (= phase ∈
  {cutover, rehearsal, hypercare, test}) ベースで, 実際に run が走っていなくても
  カウントされていた. 既に算出済みだった `runningRuns`
  (`metric.runStatus === 'running'` カウント) を使うように切替.
- `chore(overview): table column alignment cleanup`
  Project / Pinned (Version) 以外の列 (Phase / Username / Tables / Rows / Progress /
  Errors / Warnings) の th と td が揃っていなかった. Rows は th `align="right"` /
  td `textAlign:'right'` → 両方 `'center'`. Phase td と Username td に
  `textAlign:'center'` 追加 (th 側は既に center). 他は元から両側 center で touch なし.

## 次のひとがやること

- **動作確認**: BE 再起動 → Overview の pinned snapshot 行で 8 番目 (Validation) が
  failed の project を見て, バー幅が Execution 画面の Validation 段 (例: 2/3 = 66%) と
  一致するか確認. `aae` test project が典型.
- Running KPI が phase ではなく runStatus 基準に切り替わっているか
  (`cutover` phase だけど run idle な project はカウント外).
- 表の列が綺麗に揃っているか (特に Rows 列, 数字が右寄せから中央寄せに).

## 함정 / 決定 履歴

- **pct 不一致の真因は 2 ヶ所**: BE の `toSummary` 式違い + FE の merge で `stages`
  渡し忘れの 2 つが重なっていた. 最初 BE だけ直して画面確認したらまだ赤 full bar
  → FE 側 fallback に落ちる原因を追って merge ロジックを修正. **両方とも残すべき**:
  BE 修正 = live run (pinned 박제なし) 経路, FE 修正 = pinned snapshot 経路.
- **fallback 仕様自体は触らない**: `buildStagesFromMetric` 内の progressPct 近似
  fallback で「failed 状態は completed 段を pct=100 赤」と描画する仕様は元のまま.
  metric.stages が必ず populate されていれば fallback に落ちないので, 入力側で
  保証する形にした (出力側の fallback ロジックを直すと live run の挙動も変わるリスク).
- **`status.running` の戻り値は残置**: KPI 側で使わなくなったが `status` reducer
  自体は `status.done` でまだ使う. `running: a.running + 1` の枝だけ実は dead だが
  「ついでに refactor しない」原則 (CLAUDE.md) に従い触らず.
- **ctx.stages の null 正規化**: `StageSnapshot` 側は `tablesTotal`/`tablesSuccess`/
  `tablesFailed` が nullable だが `ExecStageSummary` は non-null. merge で `?? 0`
  で潰した. BE で frozen 時点で既に null 入る可能性は低いが型の境界として安全側に.

## 안 한 것 (의도적으로)

- Tables 列の表示を `tablesDone/tablesTotal` 化 (Execution 画面風) — 今回スコープ外.
  現状 `p.tableCount` (= DDL TO-BE 数) を表示しており, "Rows" 列のような run 反映は
  なし. ユーザー言及なし.
- 上部 Overall progress bar の式統一 — per-project avg-of-stage-pct で計算するように
  揃える件は手付かず. 現状は BE の `progressPct` (stage.size() 分母, success=1,
  running=partial 加算) を avg しており, Execution 画面の overall (8-stage 分母 fixed)
  とは桁が違う. ユーザーが「per-row Progress 列」を指していたと判断したため.
- ONBOARDING.md / CLAUDE.md 追記 — 今回は bug fix 範囲で構造的変更なし.

## 確認用キーポイント

- `aae` project (pinned + Validation failed 2/3) の Overview row 8 番目バー
  → 約 66% で停止 (旧: 100% full red).
- Overview 上部 RUNNING tile が cutover/rehearsal/hypercare phase 数ではなく
  実際に runStatus=running な run 数を表示.
- 全ての対象列で th テキストと td 内容が中央線で揃う.
