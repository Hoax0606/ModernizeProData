# 2026-05-27 — S1-execution-rewiring-done (Hiroyuki)

S1 ストリーム (Execution Pipeline 表示 → 実 BE 連動) 完了。S2 (Run lifecycle)
は別担当で並行進行中。

## やったこと

- `frontend/src/api/runs.ts`: `stages(runId)` / `abort(runId, reason)` 追加、
  `start` に部分実行用 `tables` 引数追加。`StageView` / `TableResultView` 型定義。
- `frontend/src/hooks/usePipelineProgress.ts` 新規。react-query で
  `GET /runs/{id}` と `GET /runs/{id}/stages` を 2 秒 polling。`isTerminal(status)`
  で `success/failed/aborted/timed_out` 検知して `refetchInterval` を false に
  戻し自動停止。
- `frontend/src/lib/pipelineStages.ts`: `buildStagesFromStageViews(StageView[])`
  追加。BE 返却の `status` を tone (`pending→idle`/`running`/`success→ok`/
  `failed→err`) にマップ、pct/rate/eta を BE 計算値ベースで描画。既存
  `buildStagesFromActiveRun` (mock) は demo 専用で残置。
- `frontend/src/pages/ExecutionPage.tsx`: `activeRunId` state + polling 結果から
  `realActiveRun` を `useMemo` で合成 (BE polling データを既存 `ActiveRunState`
  シェイプに詰める). `isDemo` で全 6 handler (Start/Stop/Retry/Discard/
  PauseToggle/TriggerFail) を分岐. Pause ボタンは real モード時に非表示
  (BE 未対応). 実行履歴は `runsApi.listByProject` で fetch.

## 動作確認

dev サーバで 1 回 Start 実行確認済。BE polling → stage 表示 → terminal で停止
まで動く (handoff 末尾の log 参照)。BE 側に複数の設定/データ不備があり 7 stage
全てが failed で返るが、FE 側は BE 返却をそのまま描画している。**FE rewiring 観点では完了**。

## 次のひとがやること

- **BE 側**: `env=on-prem` の TO-BE DB 接続設定 (Check/Load/Verify で
  `tobe DB config not set for env=on-prem` エラー)
- **データ**: AS-IS CSV 配置 (`EMPLOYEES.csv`/`APPLICANTS.csv` 不足) または
  mapping AS-IS テーブル名修正
- **S5 (Transform)**: SqlComposer alias バグ — 生成 SQL が `a./c./m./s./t./e.`
  等の独自エイリアスで列参照するが FROM 句は `AS "asis"` で固定 → Binder Error
- **S2 (Run lifecycle)**: stage gate 未実装。仕様では Check 全テーブル失敗
  すれば downstream は `pending` のはずだが、現状 7 stage 全て走り failed 返却。
- `abort` / `pause` / `resume` endpoint S2 push 待ち。FE はすでに呼び出し用
  コード完了, 4xx は silent fallback。
- Pipeline 表示の hybrid 表現 — gate 中断時 downstream を grey 表示する分岐は
  `buildStagesFromStageViews` で `status='pending'` 専用 path を用意済。
  BE が gate 実装すれば追加修正なしで効くはず。

## 函정 / 決定

- **hooks の順序問題**: `useMemo(realActiveRun)` / `useQuery(runHistory)` を
  `if (!project || !site) return` の **後** に置くと初回 render で hook 数が
  変わって React error. 必ず early return 前にまとめる (CLAUDE.md とは別。
  これは React 一般則だが S1 実装中に踏んだので明記)。
- **runStatus 二重更新を回避**: BE が project.runStatus を server-side で
  更新する前提で FE は触らない。Sidebar の phase chip は `AppShell` の
  10 秒 polling で同期。
- **`realActiveRun` 合成**: BE polling 結果を既存 mock 用 `ActiveRunState`
  シェイプに詰める方針 (RunHeader 等の既存 UI コードを refactor せず再利用)。
- **Forward-compat**: BE が `tables` 引数未対応の期間は body 無視されるだけ、
  `abort` 未 push の期間は 4xx + console.warn で続行。

## 안 한 것 (의도적으로)

- BE 側の env=on-prem TO-BE DB 設定 / CSV 配置 / SqlComposer alias 修正
  (S5 / S6 / 運用設定の別タスク)
- pause / resume の FE UI (BE が S2 後半 → それまでボタン非表示)
- WebSocket 化 (現在 2 秒 polling, 将来 BE が WS push 始めたら refetchInterval
  → onMessage に置換)
- Pipeline カードの per-table breakdown 表示 (tables[] は受信しているが現状
  集計値のみ表示。詳細パネルは別タスク)
