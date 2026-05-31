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

---

## ラウンド 2 — KPI label / Errors・Warnings 정의 통일 (午後同セッション)

ユーザーから 「Columns 8」 KPI の表示と実装が乖離している (ラベル "Columns" だが
中身は行数), Errors KPI が pinned 有無で異なる定義 (quarantine 件数 vs tablesFailed
合計) になっている指摘を受けて, 両方を直す追加修正.

### やったこと

- `chore(i18n): kpi.rows label Columns → Rows (ko/ja/en × siteOverview/executionOverview)`
  全 4 言語×2 ページの計 6 ヶ所を `'Columns' → 'Rows'`. 背景は per-row table 列 (`col.rows`)
  と BE 필드 (`rows`) / FE 変수 (`totalRows`, `metric.rows`) / データソース (load stage
  rowCount 合계) が全て row 基準で揃っているのに KPI ラベルだけ "Columns" だった件.
- `feat(snapshot): freeze quarantine counts into executionContext`
  `SnapshotExecutionContext` record に `errorCount` / `warningCount` (Long, nullable)
  を追加. `SnapshotExecutionContextService.recordExecutionContext` の終端 (전 stage 박제
  완료 직후) で `quarantineEntryRepository.countByRunIdAndSeverity(rh.getId(), error/warning)`
  를 query 해 ctx 에 같이 freeze. 박제 storage 자체는 `snapshots.execution_context` JSONB
  컬럼이라 DB migration 불필요 (旧 ctx 는 키 없음 → deserialize 시 null).
- `fix(overview FE): use ctx.errorCount/warningCount in pinned merge`
  `ExecutionOverviewPage` 의 `metrics` useMemo 에서 pinned 경로의 errorCount 산출을
  `ctx.stages.reduce(tablesFailed)` 에서 `ctx.errorCount ?? 0` 으로 교체. warningCount 도
  `apiMetrics fallback` 에서 `ctx.warningCount ?? 0` 으로 교체. live run 경로 (apiMetrics)
  と pinned 경로で같은 정의 (quarantineRepo 카운트) 로 통일.

### 次のひとがやること

- **再 run で 박제 확인**: 旧 박제는 `errorCount`/`warningCount` 가 undefined → 0 표시
  됩니다. 한 번 같은 snapshot 으로 새 run 을 돌리면 ctx 가 새 형식으로 덮어쓰여 정확한
  카운트가 KPI 에 반영됨. 旧 박제 row 의 backfill 은 안 함 (사용자 한 번만 재 run 하면
  되는 비용 vs 데이터 부정확 1 회뿐, trade-off 로 backfill 생략).
- **`status.running` 데드 코드**: 라운드 1 で Running KPI 가 `runningRuns` 로 옮겨가
  `status.running` 분기는 unused 가 됐지만 「同セッション内では touch しない」 원칙으로
  남겨뒀음. 별 round 에서 정리 추천 (`status` reducer 를 `done` 만 카운트로 simplify).

### 함정 / 결정 履歴

- **freeze 시점**: `recordExecutionContext` 내부 (stage 박제 직후) 에 quarantine count
  query 추가. `RunService.finishRun` 본체에서 분리한 이유는 ctx 박제 실패 swallow 의
  scope 안에 두기 위함 (quarantine query 실패 → ctx 박제 fail → warn 후 run 종료 정상
  진행, RunHistory 자체는 영향 없음).
- **fields nullable Long**: 旧 박제 row 와의 JSON 호환성. `errorCount: Long` 으로 박제
  도입 후의 row 만 값이 있고, 그 이전 row 는 키 부재 → Jackson 이 null deserialize.
  FE 에서는 `?? 0` 으로 0 표시. primitive `long` 으로 하면 deserialize 시 default 0 이
  되어 「박제 도입 전인지 / 0 건이었는지」 구별 불가. Long 으로 명시.
- **siteOverview 도 변경**: 사용자는 executionOverview 만 언급했지만 siteOverview 도
  같은 inconsistency 가 있었기에 두 곳 모두 직접. 분리해서 차후 round 에 한다면 「같은
  버그 2 회 fix」 가 되어 비효율적 + 일관성 깨짐 기간 발생.

### 안 한 것 (의도적으로)

- 旧 박제 backfill 마이그레이션 — 위 trade-off 대로.
- `tablesFailed` 의 의미 자체 정리 — `tablesFailed` 는 stage 실행 결과 (stage 단위 실패
  테이블 수) 용도로 남고, KPI 정의에서만 분리됨. per-stage progress bar 의 데이터원은
  그대로.
- ExecutionOverviewService BE 측 fetch 대체 — pinned 시에 한해 ctx 사용으로 충분.
  non-pinned 는 그대로 BE 의 latest run quarantine count.
