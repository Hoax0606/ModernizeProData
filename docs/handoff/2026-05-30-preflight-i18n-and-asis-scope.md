# 2026-05-30 — preflight i18n live + asis-unmapped 全 AS-IS scope (Hiroyuki)

Execution プリフライトの 4 件まとめ. ExecutionPage 自体は触っていない —
`preflightValidation.ts` + `PreflightResultPanel.tsx` + `executionPreflight` store + i18n のみ.

## やったこと

- `refactor(asis-unmapped)`: scope を **「選択 TO-BE の bindings 経由 AS-IS」**
  から **「AS-IS DDL に登録された全テーブル」** に拡張. unused AS-IS カラムは
  project レベルの mapping coverage の話で、その run の selection と無関係に
  検査すべき、という方針合わせ. `preflightValidation.ts:checkAsisUnmapped`
  で `selectedTables` の bindings 集約を捨て `asisSchema.tables.map(...)` に.
  ready チェックも asisSchema 1 本に簡略化.
- `i18n(preflight)`: `asisUnmapped.title` を **「選択された / 선택된 / Selected」
  → 「全ての / 모든 / All」** に. KO は加えて `unmappedCols.title` /
  `asisUnmapped.title` を `unmapped 여부` form から `mapped` form に短縮
  (「모든 TO-BE 테이블의 컬럼 mapped」 / 「모든 AS-IS 테이블의 컬럼 mapped」).
- `refactor(preflight render)`: 言語切替や i18n 文言変更が cache 済み preflight
  結果にも即時反映するよう、`TableCheckResult.detail: string` を捨て
  **`detailKey: TranslationKey` + `detailVars?: Record<string, string|number>`**
  に変更. `PreflightResultPanel` は `t(detailKey, detailVars)` で render 時解決.
  title も同様に `titleKeyForId(check.id)` (`preflightValidation` から export) で
  render 時解決. 旧 cache の `bySnapshot` は形が違うので persist v6 → v7 で drop
  (1 回再 run が必要だが以降は不要).
- `fix(preflight Fix dedupe)`: per-table 行に Fix がある場合 aggregate 行の Fix
  は冗長なので非表示に. 具体的には aggregate Fix を表示する条件を
  `(check.scope === 'project' || check.fixIsProjectWide)` に絞った.
  - `tobe-bindings` / `unmapped-cols` / `asis-unmapped`: aggregate Fix **非表示**
  - `csv-arrived` (fixIsProjectWide=true): per-table Fix を元から隠す設計
    なので aggregate Fix は維持
  - `ddl-asis` / `ddl-tobe` / `conn-tobe`: project scope なので aggregate Fix のみ

## 次のひとがやること

- **動作確認**: BE+FE 起動 → preflight 1 回再 run (persist migration で
  bySnapshot が空になるため). 各 check の Fix ボタン表示が上記表通り
  になっているか + 言語切替で title/detail がリアルタイム更新されるか確認.
- **push + PR**: `feature/execution2` でコミット 1 本. user が git 操作する.

## 함정 / 決定 履歴

- **detail を key + vars に分解**: 当初は title のみ render 時解決にしたが、
  ユーザー指摘で detail も同じ問題 (cache に焼き込まれて言語切替に追従しない)
  だと判明 → schema 変更で対応. 全 check 関数 (`checkCsvArrived` 含む 7 つ) で
  `detail: t(...)` → `detailKey: ..., detailVars: ...` への置換が必要だった
  ため diff が広い.
- **persist v6 → v7 migrate**: 旧形式 `detail: string` を含む `bySnapshot` を
  render 側で読むと `t(undefined, undefined)` → key fallback で見苦しい表示
  になる. migrate で bySnapshot を空にし、isStale 等も初期化. selectedTables
  と activeRunId は保持 (ユーザーの選択状態は壊さない).
- **asis-unmapped の scope 変更**: scope が「project の全 AS-IS」 に変わった
  ため、selectedTables を変えても asis-unmapped の per-table 行は変わらない.
  以前は selection 変更で再走らせる必要があったが今は selection 非依存.
- **Fix dedupe の判定基準**: `fixIsProjectWide` フラグを残した. csv-arrived
  は per-table 失敗もすべて Site 設定 → CSV に飛ぶ前提なので、per-table
  Fix を隠して aggregate Fix だけ出す既存仕様を踏襲. このフラグ無しの
  per-table check (= 残り 3 件) では aggregate を非表示にして per-table のみ
  に絞る.

## 안 한 것 (의도적으로)

- ExecutionPage.tsx 内のハードコード i18n 漏れ (`<span>run </span>`, alert
  literal 3 件, `'Admin'` フォールバック) — 別ラウンド. 今回スコープは
  preflight panel のみ.
- BE 側 preflight 永続化 — `2026-05-29-execution2-bundle.md` 함정 노트で
  「P2 cleanup, scheduler の phase gate で代替済」 として deferred 確定.
- `fixIsProjectWide` フラグ自体の廃止 (per-table Fix を csv-arrived でも
  redundant に出す方向) — 現状の挙動が許容範囲との判断で touch せず.
- ONBOARDING.md §18 の更新は 18.2 (asis-unmapped scope note) /
  18.5 (live i18n note) / 18.6 (aggregate Fix visibility) の 3 箇所のみ.
  概念図 (BE/FE 配置, snapshot life-cycle 等) は touch せず.

## 確認用キーポイント

- KO で見ると asis-unmapped タイトル = 「모든 AS-IS 테이블의 컬럼 mapped」
- JA で見ると = 「全ての AS-IS テーブルのカラム unmapped 検査」 (元の JP 指示通り)
- EN で見ると = 「All AS-IS tables column unmapped check」
- 言語切替直後にタイトル+詳細が両方とも追従する (再 run なしで)
- tobe-bindings/unmapped-cols/asis-unmapped で aggregate 行の Fix ボタンが消えてる
- 各 per-table 行の Fix は引き続き表示 (csv-arrived 以外)
