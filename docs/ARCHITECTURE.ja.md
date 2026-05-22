# ModernizeProData — アーキテクチャドキュメント

作成日: 2026-05-12
対象: 開発チーム (BE: 임지영・배성민・오현호 / FE: 恩田・진수현)

---

## 1. 概要

### 1.1 ツール紹介

**ModernizeProData** は大型金融機関のデータベース移行(Migration)を支援するツール。AS-IS 運用システムのデータを TO-BE 新システムに正確かつ高速に移すことが目的。

### 1.2 データ移行の課題

- **大容量** — TB 単位を短いカットオーバーウィンドウで処理
- **複雑な変換** — 1:N, N:N のようなテーブル構造の再構成
- **正確性** — 1 行の漏れも運用事故
- **閉鎖網制約** — 外部サービス・ツール使用不可
- **協業** — N 人がマッピング・実行を分担

ModernizeProData は閉鎖網で単一インストールパッケージとして動作し、N 台の PC が協業して運用できるように設計。

### 1.3 1次目標

- **対象サイト**: 日本金融機関の特定顧客 (5月31日締切)
- **AS-IS DB**: Oracle
- **TO-BE DB**: PostgreSQL

今後の拡張: 多様な AS-IS・TO-BE RDBMS 対応 (Db2、Symfoware など)

### 1.4 主要前提

1. **閉鎖網運用** — 外部通信 0、LAN 内部のみで動作
2. **N 台 PC 分散** — 最小 2 台、上限なし。Coordinator 1 + Worker N
3. **当日単一実行** — 運用スケジュール協議領域は除外
4. **AS-IS 入手 = CSV ファイル** — ツールが運用 DB に直接接続しない
5. **Coordinator = Master** — マッピング・実行・運用・認証の単一拠点
6. **ログイン認証** — Coordinator 発行 ID/パスワード/ロールで各 Worker からログイン
7. **マッピング協業 = リアルタイム共有編集** — 自動ロック + master 管理ロック + 監査ログ
8. **技術スタック** — Java (Spring Boot + Spring Batch) + DuckDB + React + TypeScript

### 1.5 ドキュメント範囲

- 開発スケジュール
- 環境 (開発・配布)
- システム構成
- データフロー
- 機能 (マッピング・実行・検証・隔離・ユーザー管理など)
- 初回テストシナリオ
- 顧客との協議事項

---

## 2. 開発スケジュール

### 2.1 スケジュール概要

- **開始**: 2026-05-12
- **1次締切**: 2026-05-31
- **可用期間**: 約 19 日 (作業日 14 日)

### 2.2 前提条件

- **チーム人数**: 5 名
  - BE: 임지영, 배성민, 오현호
  - FE: 恩田, 진수현
- **5/31 目標**: PoC 可能レベルのツール完成
- **1次シナリオ**: Oracle → PostgreSQL
- **PoC シナリオ**: 顧客協議領域 (開発は一般想定で進行)
- **エンコーディング**: Shift JIS → UTF-8 (1次)

### 2.3 段階別マイルストーン

#### Week 1 (5/12 ~ 5/18) — 基盤構築
- Project skeleton (Spring Boot + Spring Batch + React + Vite + TypeScript)
- Multi-module 構造 (coordinator / worker / common / ui)
- 開発者ローカル DB 環境 (Docker またはローカルインストール)
- DuckDB 変換 prototype (Java 埋め込み動作確認)
- React UI セットアップ (現 prototype 移植)
- LAN REST + WebSocket 骨格
- エンコーディング変換 prototype (Shift JIS → UTF-8)
- Extract 変換 prototype (COMP → Numeric)

#### Week 2 (5/19 ~ 5/25) — コア機能
- マッピング定義管理 (CRUD + テーブルロック + 監査ログ)
- マッピングスナップショット (バージョン管理)
- ユーザー・ロール管理 + JWT ログイン
- Run 実行 (Spring Batch + DuckDB 呼び出し)
- スケジューラー (予約実行 — Quartz、cron ベース)
- TO-BE ロード (PostgreSQL JDBC + COPY FROM)
- 検証 (DuckDB cross-source SQL)
- 進行モニタリング UI (WebSocket リアルタイム)
- 通知システム基盤 (WebSocket push + メタ DB 保存)
- エンコーディング・Extract 変換の安定化

#### Week 3 (5/26 ~ 5/31) — 統合 + 初回テスト
- Coordinator + Worker 分離・通信の安定化
- 隔離(Quarantine) 処理 + UI
- ログビュー UI (フィルター・検索・export)
- 通知センター UI (フィルター・購読・既読管理)
- 成果物出力 (検証レポート / マッピングスナップショット export / 監査ログ export)
- 閉鎖網パッケージング (jpackage 単一インストーラー)
- ライセンス (.lic) 検証
- 初回 PoC テストシナリオ (一般想定ベース)
- バグ修正・安定化

### 2.4 リスク

- スケジュールが非常にタイト → 優先順位外の機能は後続
- 閉鎖網パッケージング初体験の負担
- PoC シナリオ情報不在 → 開発中は想定で進行

---

## 3. 環境

### 3.1 バックエンド開発環境

**基本:**
- JDK 21 (LTS)
- VSCode または Cursor
- Maven
- Git

**ローカル DB (開発用):**
- PostgreSQL (Docker またはローカルインストール) — TO-BE 模擬
- Oracle XE (Docker またはローカルインストール) — AS-IS 模擬

**ビルド・パッケージング:**
- jpackage (JRE 21 bundle 単一 native installer)

### 3.2 フロントエンド開発環境

**基本:**
- Node.js 20 (LTS)
- npm
- VSCode または Cursor

**フレームワーク・言語:**
- React 18+
- TypeScript 5+
- Vite (ビルド)

### 3.3 Front ↔ Back 通信

**REST API:**
- マッピング CRUD、run 実行、ユーザー認証、検証結果照会など
- JSON シリアライズ (Jackson)

**WebSocket:**
- リアルタイム進行状況 (ロード・変換 %)
- Lock 状態変更通知
- システム通知 (隔離・エラー)

**認証:**
- JWT トークン (ログイン時発行)
- 各リクエストに `Authorization: Bearer <token>` ヘッダー

### 3.4 サイト配布環境

**構成:**
- Coordinator 1 台 (Worker 1 台と兼用可)
- Worker N 台 (最小 2 台、上限なし)

**ハードウェア推奨 (Worker 基準):**
- CPU: 8 core 以上
- RAM: 16GB 以上
- ディスク: 作業データ + 余裕 (SSD 推奨)

**ネットワーク:**
- LAN 1Gbps 以上
- ファイアウォール: Coordinator port (例: 8080) の社内アクセス許可
- 外部インターネット 0

**OS:** Windows Server

**配布形態:**
- jpackage 成果物 `.exe` または `.msi` 単一インストーラー
- JRE 21 + JAR + JDBC driver + .lic 含む
- USB 運搬

### 3.5 必須ライブラリ

**バックエンド (Spring Boot):**
```
spring-boot-starter-web          REST API
spring-boot-starter-batch        chunk-oriented ETL
spring-boot-starter-websocket    リアルタイム通信
spring-boot-starter-security     JWT 認証
spring-boot-starter-data-jpa     または jdbc
spring-boot-starter-quartz       スケジューラー
duckdb_jdbc                      DuckDB 埋め込み
ojdbc11                          Oracle JDBC
postgresql                       PostgreSQL JDBC
slf4j + logback                  ログ
jackson                          JSON
```

**フロントエンド (npm):**
```
react@18, react-dom@18
typescript@5
vite + @vitejs/plugin-react
axios                            HTTP クライアント
@tanstack/react-query            server state
zustand                          client state (選択)
sockjs-client + stompjs          WebSocket (STOMP)
```

---

## 4. システム構成

### 4.1 全体構成図

```
[ サイト閉鎖網 LAN ]

  ┌──────────────────────────────────────────────────┐
  │ Coordinator PC (1 台)                             │
  │  ┌─────────────────────────────────────────────┐ │
  │  │ ModernizeProData.exe (ネイティブアプリ)       │ │
  │  │  - ネイティブ窓 + React UI (webview 内蔵)     │ │
  │  │  - Spring Boot (同一プロセス)                │ │
  │  │  - DuckDB (埋め込み)                         │ │
  │  │  - メタ DB (PostgreSQL 18, バンドル設置)     │ │
  │  │  - スケジューラー (Quartz、埋め込み)         │ │
  │  │  - .lic 検証                                │ │
  │  │                                              │ │
  │  │  master 役割: マッピング・ユーザー・進行管理、│ │
  │  │              タスク分配、予約実行管理        │ │
  │  │  worker 役割: 抽出・変換・ロード・検証 (並行) │ │
  │  └─────────────────────────────────────────────┘ │
  │                    │                             │
  │           LAN REST + WebSocket                   │
  │  ┌────────┬───────┴────┬────────┐                │
  │  │        │            │        │                │
  │ [W1]   [W2]         [W3]   ...                   │
  │  Worker PC (N-1 台)                              │
  │  - ModernizeProData.exe (同一アプリ、worker モード)│
  │  - Spring Boot + DuckDB 埋め込み                 │
  │  - 抽出・変換・ロード・検証                       │
  └──────────────────────────────────────────────────┘
                  │              │
        [ AS-IS CSV ファイル ]  [ TO-BE RDBMS ]
        (各 PC ディスク         (サイト別: 1次 PostgreSQL)
         または共有フォルダ)

  各 PC ディスク内部:
   - AS-IS CSV (入力)
   - Parquet 一時 (DuckDB 変換結果、ロード後削除可)
```

### 4.2 コンポーネント別責務

| コンポーネント | 責務 | 位置 |
|---|---|---|
| **Coordinator** | master 役割: マッピング・ユーザー・進行状況・ライセンス管理、UI ホスティング、タスク分配、予約実行管理 / worker 役割: 抽出・変換・ロード・検証 | LAN PC 1 台 |
| **Worker** | worker 役割のみ: 抽出・変換・ロード・検証 | LAN PC N-1 台 |
| **DuckDB** | 変換・検証 SQL エンジン | Coordinator + Worker 両方に埋め込み |
| **スケジューラー (Quartz)** | 予約実行 (一回性・繰り返し)、タスク時間トリガー | Coordinator 内に埋め込み |
| **メタ DB** | マッピング定義・監査ログ・ユーザー情報・スケジュール | Coordinator がバンドル設置する PostgreSQL 18 |
| **AS-IS CSV** | 入力データ | 各 PC ディスクまたは共有フォルダ |
| **Parquet (一時)** | DuckDB 変換結果、ロード後削除 | 各 Worker ディスク |
| **TO-BE RDBMS** | 最終ロード対象 | サイト別 (1次: PostgreSQL) |

### 4.3 通信

**アプリ内部 (UI ↔ ローカルバックエンド):**
- React UI ↔ 同一プロセスの Spring Boot (localhost)
- REST が主。WebSocket endpoint (`/ws`) は設置済だが PoC 1次では未使用 — 通知・進行状況は 10 秒 polling。

**Coordinator ↔ Worker (LAN):**
- REST API: Worker 登録・heartbeat、タスクキュー polling、結果報告、マッピング・設定照会。
- WebSocket: PoC 2次で実時間進行状況 push 用に導入予定。

**Worker ↔ DB:**
- AS-IS: ファイルシステム read (CSV)
- TO-BE: JDBC + COPY FROM (1次 PostgreSQL)

### 4.4 認証・権限

#### 4.4.1 ライセンス (.lic)
- Coordinator のみ使用。Worker は .lic 不要。
- 本社発行、Ed25519 署名、サイト ID バインディング。
- Coordinator 起動時に検証。

#### 4.4.2 JWT — 1 アカウント = 1 アクティブセッション
- アルゴリズム HS512、デフォルト 8 時間有効 (`modernize.jwt.expiration-hours`)。
- claims: `sub` (username)、`role` (master/admin/viewer)、`sid` (アクティブセッション UUID)、`iat`、`exp`。
- `sid` は `users.current_session_id` と一致するときのみ認証有効。別の場所で新規ログインすると sid が更新され、以前のトークンは自動失効。
- 各リクエストに `Authorization: Bearer <token>`。

#### 4.4.3 ロール

| ロール | 権限 |
|---|---|
| master | 全体管理。ユーザー作成・削除、ライセンス、マッピング管理、実行、全データ照会、他ユーザーセッションの強制終了 |
| admin | マッピング作成・実行、隔離処理、データ照会。ユーザー管理権限なし |
| viewer | 照会のみ (マッピング・進行・ログ) |

位置 (Coordinator/Worker) と無関 — 権限レベル。master ユーザーが Worker 席でログインしても同じ master 権限。

#### 4.4.4 ログインポリシー — confirm-to-evict

1 アカウントで 2 箇所で同時にログインすることはできない。2 回目のログイン試行時、backend がユーザーに確認を求める。

**正常フロー:**
```
1. ユーザーが ID・パスワード入力 → POST /api/v1/auth/login
2. Coordinator が BCrypt で検証
3. アクティブセッションがなければ新 sid (UUID) 発行 + JWT 返却 + LOGIN audit
4. クライアントがトークンを localStorage に保存
```

**競合フロー:**
```
1. ユーザーが別 PC で同じアカウントでログイン試行
2. Coordinator が users.current_session_expires_at が未来であることを検出
3. 409 AUTH_SESSION_ACTIVE_ELSEWHERE 応答 + LOGIN_REJECTED audit
4. フロントが confirm カード表示 —「切断してログイン / キャンセル」
5. 「切断してログイン」選択時 POST /api/v1/auth/force-self-logout (パスワード再認証)
   → 別の場所のセッション無効化 + FORCE_LOGOUT_SELF audit
6. フロントが自動で login 再試行 → 成功
```

既存 PC でログアウトせずブラウザを閉じても、別 PC からの明示的な確認で解除できる。

#### 4.4.5 トークン検証 — JwtAuthFilter

各リクエストごとに:
1. `Authorization: Bearer` ヘッダーをパース + 署名検証。
2. `findByUsername(sub)` でユーザー取得。
3. **token.sid ≠ user.current_session_id** なら明示的に `401` + `{code: AUTH_SESSION_INVALIDATED}` を返してフィルターチェーン中断。
4. 一致すれば SecurityContext に認証注入して通過。

フロントの axios interceptor が 401 を受け取ると `useAuthStore.logout()` を呼び出し → `ProtectedRoute` が `/login` にリダイレクト。最悪遅延 = AppShell polling 周期 (10 秒)。

#### 4.4.6 ログアウトの種類

| エンドポイント | 誰が | 効果 | audit |
|---|---|---|---|
| `POST /api/v1/auth/logout` | 本人 (トークン保持) | 自分のセッション無効化 | `LOGOUT` |
| `POST /api/v1/auth/force-self-logout` | 本人 (パスワード再認証) | 自分のセッション無効化 — 別の場所でログイン中の場合 | `FORCE_LOGOUT_SELF` |
| `POST /api/v1/users/{id}/force-logout` | master | 対象ユーザーのアクティブセッション強制終了 (盗難・緊急時) | `FORCE_LOGOUT` (actor 記録、target は details) |

#### 4.4.7 パスワード変更

| エンドポイント | 誰が | 備考 |
|---|---|---|
| `POST /api/v1/users/me/password` | 本人 | 現在のパスワード + 新パスワード。同一拒否。最小 4 文字 |
| `POST /api/v1/users/{id}/password` | master | 対象ユーザーのパスワード強制リセット。対象のアクティブセッションも同時に無効化 |

#### 4.4.8 Worker 登録
- Worker アプリ起動時に Coordinator URL に自動登録要求。
- Coordinator が worker 登録トークン発行 (ユーザー JWT とは別)。
- 各呼び出しにトークン使用。

#### 4.4.9 Audit log
認証関連のすべてのイベントが `audit_log` テーブルに記録 (site_id / project_id は NULL)。
- `LOGIN`、`LOGOUT`、`LOGIN_REJECTED`、`FORCE_LOGOUT_SELF`、`FORCE_LOGOUT`。

#### 4.4.10 意図的に未対応
- WebSocket push による即時強制ログアウト — polling で十分。
- Idle timeout (N 分無活動で自動ログアウト) — 顧客要求があれば。
- Refresh token — 8 時間有効で PoC には十分。
- Token blacklist — `sid` 比較で自動無効化されるため不要。

### 4.5 ドメインモデル — Site / Project

**Site (1 顧客サイトの 1 運用環境単位)**

| フィールド | 意味 |
|---|---|
| `name` | サイト名 (unique) |
| `asisEnv` / `tobeEnv` | AS-IS / TO-BE 環境ラベル (mainframe / midrange / cloud / on-prem / other) |
| `asisEncoding` / `tobeEncoding` | エンコーディング (shift_jis / euc-jp / utf-8 / ebcdic) |
| `csvPath` | AS-IS CSV ディレクトリパス |
| `asisDbType` / `asisDbVersion` | AS-IS 抽出元 DB 情報 (表示用 — ツールは外部 DB に直接接続しない) |
| `environment` | 現在のアクティブ運用ステージ (dev / test / staging / production) |
| `tobeDbByEnv` | ステージ別 TO-BE DB 接続情報 (jsonb) |
| `tobeDbLocks` | ステージ別 lock 状態 (保存時に自動 lock) |

**Site Settings の 2-step lock**
- per-stage **DB lock**: ステージ別 TO-BE DB 入力ロック。自動 or master トグル。
- site-wide **Edit lock**: サイト全体の編集ロック。Save は site lock 状態でのみ許可。site lock ガード — サイト名が空または現在 stage の DB lock が解除されていれば拒否。
- 保存時、データのある全 stage の DB lock が自動的に `true` に強制 — 再度モーダルを開くと全 DB stage が lock 状態でスタート。

**Project (Site 内の移行単位)**

| フィールド | 意味 |
|---|---|
| `name` | プロジェクト名 (site 内 unique) |
| `phase` | 9 段階 phase (§ 1.1 参照) |
| `assignee` | **開発/マッピング担当** — Site Overview のドロップダウンで指定 |
| `executionAssignee` | **実行 (run) 担当** — Execution Overview のドロップダウンで指定。assignee と独立 |
| `ddlFiles` | AS-IS / TO-BE DDL ファイルメタ |
| `cutover` | cutover 実行メタ (開始・中断・完了) |
| `runStatus` | test / rehearsal / cutover の sub-status |

**Read-only project**
- `master` 以外の worker が、自分が `assignee` でない project を開くと read-only。
- サイドバー project 行に錠アイコン chip + dim、ページ上部に amber バナー、ページ内のすべての変更アクション (save / phase change / DDL import / snapshot 等) を disabled。

---

## 5. データフロー

### 5.1 全体フロー

```
[ AS-IS 抽出データ ]
  (UTF-8 / Shift JIS / EUC-JP / EBCDIC / COMP など)
         │
         ↓ [選択] Java 前処理
         │   - 標準エンコーディング (Shift JIS など): 省略
         │   - 非標準 (EBCDIC, COMP/PACKED): Java 変換
         ↓
[ DuckDB-readable CSV ]
         │
         ↓ DuckDB SQL 変換 (マッピング定義ベース)
[ Parquet (UTF-8) ]
         │
         ↓ Java COPY FROM (JDBC + CopyManager)
         │   - Target エンコーディング (UTF-8/SJIS) 自動変換
[ TO-BE テーブル ]
         │
         ↓ DuckDB 検証 (cross-source SQL)
[ 検証 PASS / FAIL → Quarantine ]
```

### 5.2 ステップ概要

| ステップ | 入力 | 出力 | 処理ツール |
|---|---|---|---|
| 1. 入力受領 | (運用チーム抽出) | Raw データ | — |
| 2. 前処理 (選択) | Raw | DuckDB-readable CSV | Java (非標準エンコーディング・binary のみ) |
| 3. 変換 | CSV | Parquet (UTF-8) | DuckDB SQL |
| 4. ロード | Parquet | TO-BE テーブル | Java + JDBC COPY |
| 5. 検証 | CSV + TO-BE | PASS/FAIL レポート | DuckDB cross-source |
| 6. 隔離 | 失敗 row | Quarantine 保管 | Java + メタ DB |

### 5.3 ステップ別詳細

#### 5.3.1 入力受領
- 運用チームが AS-IS システムから抽出したデータを閉鎖網内のディスク (Worker ディスクまたは共有フォルダ) に置く。ツールは運用 DB に直接接続しない。
- **Source Reader SPI** で入力形式を抽象化 — 詳細実装は ONBOARDING § 7 参照:
  - CSV — DuckDB `read_csv` でその場でクエリ。Shift-JIS / EUC-JP / UTF-8 は `encodings` extension。
  - EBCDIC (IBM037 / IBM930 / JEF / KEIS) — 直接 COMP-3 unpack。
  - FixedWidth — column offset ベースのパース。
- Site の `asisDbType` / `asisDbVersion` で、どの運用 DB から出た CSV かのメタ情報を表示。

#### 5.3.2 前処理 (選択的)

マッピング定義の source encoding/形式に応じて分岐:

| ケース | 処理 |
|---|---|
| 標準テキストエンコーディング (UTF-8/SJIS/EUC-JP など) | 省略 — DuckDB が `encodings` extension で直接処理 |
| 非標準エンコーディング (EBCDIC variant — IBM037/IBM930/JEF/KEIS) | Java Charset で変換 |
| Binary フィールド (COMP/PACKED/ZONED) | Java parser で numeric 変換 |

#### 5.3.3 変換 (DuckDB SQL + Rule Engine)

- マッピング定義 = DuckDB SQL。DuckDB が CSV をその場でクエリ (エンコーディングオプション使用)。結果を常に Parquet として出力。
- **処理順序 (1 SQL 内)**: JOIN → transform → Quarantine。Validation track は transform と並列。
- **Rule Engine 3-tier ladder** (詳細定義は ONBOARDING § 4):
  - Tier 1 — 型ベース自動マッピング (Type matrix)。
  - Tier 2 — strategy library (2a シンプル戦略 / 2b 複合戦略)。
  - Tier 3 — 自由 SQL (`custom_expr`)。PoC 2 次に deferred。
- Snapshot が `compiled_expr` を凍結 — 同一入力 → 同一結果の再現性を保証。

```sql
COPY (
  SELECT a.id, a.name, b.amount
  FROM read_csv('asis_a.csv', encoding='shift_jis') a
  JOIN read_csv('asis_b.csv', encoding='shift_jis') b ON a.id = b.id
) TO 'output.parquet' (FORMAT PARQUET);
```

#### 5.3.4 ロード (Loader Adapter SPI)

- Java が Parquet を読み TO-BE にロード。**Loader Adapter SPI** が driverId ごとにアダプタを選択 (詳細実装は ONBOARDING § 8):
  - PostgreSQL — `PgCopyManager` (COPY FROM, binary)
  - Oracle — OCI bulk insert
  - MySQL — JDBC `rewriteBatchedStatements`
  - SQL Server — `SqlServerBulkCopy`
  - その他 — JDBC batch fallback
- JDBC ドライバ JAR は `data/drivers/` に配置。閉鎖網のため本社が USB で配送 → ツールが動的ロード。
- Target エンコーディング処理はアダプタの責務 (PG = `client_encoding`、Oracle = NLS_LANG 等)。
- Spring Batch chunk-oriented commit (例: 10000 row 単位)。
- ロード前のインデックス drop / 後に再生成 — PG COPY 限定の最適化。他のアダプタは独自戦略。

#### 5.3.5 検証 (DuckDB cross-source)

DuckDB が AS-IS CSV + TO-BE 両方を一つのクエリで比較:

```sql
-- 合計比較
SELECT
  (SELECT SUM(amount) FROM 'asis_clean.csv') AS asis_sum,
  (SELECT SUM(amount) FROM pg.tobe_table)    AS tobe_sum;

-- 不一致 row 検出
SELECT a.id, a.amount AS src, b.amount AS dst
FROM 'asis_clean.csv' a
JOIN pg.tobe_table b ON a.id = b.id
WHERE a.amount <> b.amount;
```

検証項目:
- 行数比較
- 主要カラム合計比較
- Sample row 1:1 比較
- エンコーディング round-trip 不可文字の検出

#### 5.3.6 隔離 (Quarantine)

- 検証失敗 row を Coordinator メタ DB の `run_quarantine` テーブルに保管。
- UI で運用者確認。
- マッピング修正 → 再変換・再ロード・再検証フロー。
- パイプラインの 2 つの checkpoint (CP1: transform 後、CP2: 検証後) を基準に部分再実行可能。restart matrix は ONBOARDING § 2 参照。

### 5.4 エンコーディング処理まとめ

| ケース | 処理 |
|---|---|
| 標準テキスト (UTF-8/SJIS/EUC-JP など) | DuckDB 直接 (encodings ext.) |
| Binary (COMP/PACKED/ZONED) | Java 前処理 |
| EBCDIC variant | Java 前処理 (Charset.forName) |
| Target SJIS | PostgreSQL DB encoding または JDBC client_encoding |
| Round-trip 不可文字 | Quarantine |

ツールがマッピング定義で source encoding + target encoding 両方を指定可能。

### 5.5 並列処理

**テーブル単位 (Worker 間並列):**
- Coordinator がテーブルリストを N 台 Worker に分配
- 各 Worker は自分に割り当てられたテーブルのみ処理

**チャンク単位 (一テーブル内並列):**
- Spring Batch chunk 単位 (例: 10000 row)
- ロード失敗時に最後の commit チャンクから再開

### 5.6 失敗処理

- **Worker ダウン**: Heartbeat 切断 → 未完了タスクを他 Worker に再割当。部分ロードは truncate / rollback
- **検証失敗**: 隔離記録 → 運用者確認 → マッピング修正 → 該当テーブルのみ再実行

---

## 6. 機能

各機能は UI + Backend API の両方を備える。権限 (ロール) によりアクセス制限。

### 6.1 マッピング管理

**マッピング定義:**
- CRUD (作成・照会・修正・削除)
- 状態管理: draft / review / approved
- エンコーディングオプション (source / target encoding)
- フィールド変換オプション (COMP → Numeric など)

**ロック機能:**
- PoC 1 次現在で適用されているロックは § 4.5 の Site Settings 2-step lock (per-stage DB lock + site-wide edit lock) のみ。マッピングテーブル単位ロックは PoC 2 次 (multi-user マッピング協業段階) に導入予定。

**スナップショット (バージョン管理):**
- 作成: master・admin (mapping snapshot / cutover snapshot の 2 種)
- Rollback: master・admin
- Approve (公式承認): master のみ
- Cutover snapshot は production 環境でのみ作成可 (§ 1.3 参照)

**権限まとめ:**

| 作業 | master | admin | viewer |
|---|---|---|---|
| マッピング CRUD | ✓ | ✓ | 照会のみ |
| スナップショット作成 | ✓ | ✓ | — |
| スナップショット rollback | ✓ | ✓ | — |
| スナップショット approve | ✓ | × | × |
| マッピング協業ロック | (PoC 2 次) | (PoC 2 次) | — |

### 6.2 Run 実行管理

- 即時実行 (UI ボタン)
- 予約実行 (スケジューラー — Quartz、cron ベース、一回性・繰り返し)
- 中断・再開 (一時停止・再開・中止)
- 部分再実行 (検証失敗テーブルのみ)

Run モード:
- 全体 (全マッピング済みテーブル)
- 単一テーブル (試行移行・デバッグ)
- 失敗テーブルのみ (隔離復旧)

権限: master/admin (実行)、viewer (照会)

### 6.3 進行モニタリング

- AppShell の定期 polling (10 秒) で site / project / snapshot / audit を同期。PoC 1 次では WebSocket push 未使用。
- Worker 状態 (alive / busy / idle / down)
- テーブル別進行 (待機 / 変換 / ロード / 検証 / 完了 / 失敗)
- 全体統計 (総 row、処理 row、速度、ETA)
- WebSocket 実時間 push は PoC 2 次 (大量 run + グラフ) に導入予定。

権限: 全 role 照会可能

### 6.4 隔離 (Quarantine) 管理

- 隔離 row 照会
- 隔離理由別グループ化
- Sample データ確認
- マッピングジャンプ — 隔離から該当 TO-BE テーブルのマッピング画面へ移動
- リトライ — マッピング修正後に該当テーブルのみ再実行

権限: master/admin (処理)、viewer (照会)

### 6.5 検証レポート

- テーブル別 PASS/FAIL
- 検証項目別詳細 (行数・合計・sample・チェックサム)
- 不一致 row リスト
- レポート export (PDF / CSV)

権限: 全 role 照会可能

### 6.6 ログ・成果物出力

**監査ログ:**
- Backend `audit_log` テーブル (Flyway `V20260521133513`) — すべての作業が server-side に記録 (誰が・いつ・何を・どこに)。
- サイト単位 fetch + AppShell 10 秒 polling で全アカウントが同じ audit を参照。通知パネルも audit の派生 (§ 6.10)。
- 認証 audit (LOGIN / LOGOUT / LOGIN_REJECTED / FORCE_LOGOUT / FORCE_LOGOUT_SELF) は site_id NULL で記録。
- フィルター・検索 (ユーザー別 / 作業種別 / 時間範囲)
- Export (CSV)

**成果物 export (USB 運搬用):**
- 検証レポート (PDF / CSV)
- マッピングスナップショット (YAML / JSON バックアップ)
- 監査ログ (CSV)
- Quarantine データ (CSV)

権限: master (全ログ)、admin (マッピング・実行ログ)、viewer (照会のみ)

### 6.7 ユーザー・ロール管理

PoC 1 次実装 (master のみ):
- ユーザー CRUD (ID・パスワード・ロール)。User Management モーダルで発行/削除/ロール変更。
- **パスワード強制リセット** — `POST /api/v1/users/{id}/password`。対象ユーザーのアクティブセッションも即時無効化。
- **本人パスワード変更** — Account profile の Change password。`POST /api/v1/users/me/password` (現在パスワード検証 + 最小 4 文字 + 同一拒否)。
- **強制ログアウト** — `POST /api/v1/users/{id}/force-logout`。盗難・緊急時に master が対象セッションを終了。

PoC 2 次 deferred: ID 有効期限の設定・延長。

権限: 上記すべて master のみ。

### 6.8 Worker 管理

- Worker 登録 (自動または手動)
- Worker 状態モニタリング (alive / busy / down)
- Worker 登録解除
- Worker トークン破棄

権限: master

### 6.9 システム管理

- ライセンス情報表示 (サイト ID・発行日・有効期限)
- メタ DB バックアップ・復元
- システム設定 (ポート・ログレベル・スケジューラー設定)
- ツールバージョン情報

権限: master

### 6.10 通知 (Notification)

**メカニズム:**
- Backend `audit_log` が source of truth — 専用の通知テーブル/エンティティは持たない。
- AppShell の 10 秒 polling でサイトの audit log を fetch → フロントがユーザー購読設定に従って通知パネル / toast に変換。
- 既読/未読状態は client-side (`localStorage`) — ユーザー別・端末別に独立。
- WebSocket 実時間 push は PoC 2 次 deferred。

**通知種別 (現行 events):**

| 分類 | event key | 発生する audit action |
|---|---|---|
| 実行 | `run.started` / `run.failed` / `run.finished` | `RUN_STARTED` / `RUN_FAILED` / `RUN_FINISHED` (実行エンジン接続後) |
| スナップショット | `snapshot.pending` / `snapshot.approved` / `snapshot.rejected` | `REVIEW_REQUESTED` / `APPROVED` / `REJECTED` |
| Cutover | (スナップショットと同じキーだが type=cutover) | `CUTOVER_SNAPSHOT_CREATED` 等 |

**UI:**
- ヘッダー bell icon + 未読通知数 badge
- 通知クリック時に関連画面へ deep link (`/versions?selectSnapshotId=...` 等)
- 通知パネル (全体照会・フィルター・既読表示・dismiss)
- 新規 audit 到着時に右下 toast 4 秒

**フィルター・購読:**
- ユーザー別 event 購読 ON/OFF (Project Settings > Notifications)。
- Scope: 全体 (Solution Settings) とプロジェクト別。'mine-only' / 'all-project'。
- 権限ベースの自動範囲:
  - master: 全通知
  - admin: 本人作業 + 隔離・検証
  - viewer: システム通知 (選択)

---

## 7. 初回テストシナリオ

### 7.1 目的

- ModernizeProData の end-to-end 動作検証
- 5/31 締切時点の合格基準確認

### 7.2 事前準備

**環境:**
- Coordinator PC 1 台
- Worker PC 4 台 (計 5 台)
- 全 PC: Windows、8 core / 16GB / SSD
- LAN 接続
- 全 PC に `ModernizeProData.exe` インストール
- Worker config に Coordinator URL 入力

**データ:**
- AS-IS: Oracle 形式のダミー CSV ファイルを直接生成
  - 5~10 テーブル
  - エンコーディング Shift JIS
  - 1:1 / 1:N / N:N 変換ケース含む
  - 数万~数十万 row 規模
  - Oracle DB の実起動は不要 (CSV のみ)
- TO-BE: ローカル PostgreSQL (Docker またはインストール)
  - 空 DB、エンコーディング UTF-8

**ツール・アカウント:**
- Coordinator に `.lic` 適用
- master 1 名
- master が admin 4 名のアカウント発行 (有効期限含む)
- viewer は今回の PoC では未発行

### 7.3 シナリオデータ例

| テーブル | row 数 | 変換タイプ |
|---|---|---|
| customer | 50,000 | 1:1 |
| order | 200,000 | 1:1 |
| order_detail | 800,000 | 1:N |
| product | 5,000 | 1:1 |
| account_summary | 20,000 | N:N (JOIN 3 つ) |

合計約 100 万 row。エンコーディング Shift JIS → UTF-8。

### 7.4 実行順序

**Step 1 — 環境準備:**
1. AS-IS Oracle 形式のダミー CSV 生成 (Shift JIS エンコーディング)
2. CSV を Worker ディスクまたは共有フォルダに配置

**Step 2 — ログイン・登録:**
1. Coordinator PC で `ModernizeProData.exe` 実行
2. master ログイン
3. Worker PC 4 台それぞれ実行 → Coordinator 自動登録確認
4. master が admin 4 名のアカウント発行 (有効期限指定)
5. 各 admin が Worker PC でログイン

**Step 3 — マッピング定義:**
1. master が AS-IS・TO-BE DDL をインポート
2. admin 4 名が並列でテーブル別マッピング作成 (自動ロック動作確認)
3. エンコーディングオプション (source: shift_jis, target: utf-8) 指定
4. 1:N・N:N マッピングは DuckDB SQL で作成
5. master がマッピング review・approve
6. マッピングスナップショット自動作成

**Step 4 — 実行:**
1. master が即時実行または予約実行
2. Coordinator が作業を Worker 4 台に分配
3. 各 Worker: CSV 読み込み → DuckDB 変換 → Parquet → Java COPY → PostgreSQL
4. リアルタイム進行モニタリング (WebSocket)
5. 通知受信確認

**Step 5 — 検証:**
1. DuckDB cross-source 検証 (行数・合計・sample)
2. 隔離 row 発生時に quarantine 画面確認
3. 隔離 → マッピング画面ジャンプ → マッピング修正 → 該当テーブルのみ再実行

**Step 6 — 成果物確認:**
1. 検証レポート export
2. マッピングスナップショット export
3. 監査ログ export
4. USB 運搬可能確認

### 7.5 合格基準

**機能:**
- 5 名 (master 1 + admin 4) 同時ログイン動作
- マッピング自動ロック動作 (衝突なし)
- master の管理ロック (テーブル・業務単位) 動作
- スナップショット作成・rollback (admin 可) / approve (master のみ) 動作
- Worker 自動登録・heartbeat 動作
- Worker 4 台並列処理動作
- エンコーディング変換 (Shift JIS → UTF-8) 正常
- 1:1・1:N・N:N マッピングすべて正常
- 検証通過 (行数・合計・sample 一致)
- 隔離処理 + マッピングジャンプ + 再実行動作
- 通知 push・既読処理動作
- スケジューラー予約実行動作
- 成果物 export 正常

**非機能:**
- 100 万 row 移行 30 分以内
- 5 名同時使用時に UI 応答 1 秒以内
- Worker ダウン時に自動再割当動作
- 閉鎖網環境で正常動作
- jpackage 単一インストーラーでインストール・実行可能

### 7.6 失敗時の処理

- 単位テーブル失敗 → quarantine 確認 → マッピング修正 → 部分再実行
- Worker ダウン → heartbeat 切断 → 他 Worker 再割当
- 全体失敗 → マッピングスナップショット rollback → 再試行

---

## 8. 顧客との協議事項

以下の項目は ModernizeProData ツール自体の決定ではなく、**顧客 (日本金融機関) と協議** して決める必要がある。

### 8.1 システム環境

| 項目 | 協議内容 |
|---|---|
| サイト PC 仕様 | Coordinator・Worker PC の CPU / RAM / ディスク仕様 |
| OS | Windows Server バージョン、権限 |
| LAN 環境 | 帯域幅、IP 割当、ファイアウォール方針 (Coordinator port 開放) |
| USB 運搬手順 | ツール・.lic・アップデート媒体の運搬方法、立会手順 |
| インターネット遮断レベル | 完全分離 vs 部分網連携 |

### 8.2 データ・移行対象

| 項目 | 協議内容 |
|---|---|
| AS-IS システム | Oracle バージョン (11g / 12c / 19c / 21c)、エンコーディング、データ量 |
| TO-BE システム | PostgreSQL バージョン、エンコーディング (UTF-8 / SJIS)、インフラ |
| データ規模 | テーブル数、総 row 数、総ディスクサイズ |
| インデックス方針 | 事前作成範囲、ロード中の drop 可否 |
| 非標準エンコーディング・フィールド | EBCDIC variant、COMP/PACKED/ZONED の実在有無 |

### 8.3 抽出・運用スケジュール

| 項目 | 協議内容 |
|---|---|
| AS-IS 抽出方法 | 運用チームの抽出方式・時点・形式 (CSV/dump) |
| データ受渡し | CSV 受渡し経路・頻度 |
| DDL freeze 期間 | マッピング開始 ~ 移行完了まで AS-IS DDL 変更禁止合意 |
| 移行スケジュール | 単一実行日、可用ウィンドウ、pre-load 可否 |
| Go-live | 新システムオープン日 |

### 8.4 マッピング

| 項目 | 協議内容 |
|---|---|
| マッピング定義作成者 | マッピング定義を作成する担当 |

### 8.5 検証・承認

| 項目 | 協議内容 |
|---|---|
| 検証項目 | 行数・合計・sample・チェックサムのうち必須項目 |
| Pass/Fail 基準 | 許容誤差、隔離 row の許容上限 |
| 隔離処理方針 | マッピング修正 / データ補正 / 運用影響判断 |
| 最終承認者 | 移行完了の承認権限者 |

### 8.6 障害・ロールバック

| 項目 | 協議内容 |
|---|---|
| 障害 escalation | ツール側・顧客側担当者、連絡手順 |
| ロールバック手順 | TO-BE truncate、AS-IS 復帰時点 |
| 部分失敗対応 | 一部テーブル失敗時の継続可否 |

### 8.7 運用・保守

| 項目 | 協議内容 |
|---|---|
| ハイパーケア期間 | 移行後のモニタリング期間 (1~2 週など) |
| ツールアップデート | パッチ配布手順 (USB 運搬) |
| 監査ログ保管 | 保管期間・削除方針 |
| 引き継ぎ | 運用マニュアル・教育スケジュール |

### 8.8 コンプライアンス

| 項目 | 協議内容 |
|---|---|
| FISC 安全基準 | 適用項目・証跡資料 |
| 個人情報 | データ分類・マスキング要否 |
| 監査要件 | 別途の監査証跡要求 |

---

ドキュメント終了。
