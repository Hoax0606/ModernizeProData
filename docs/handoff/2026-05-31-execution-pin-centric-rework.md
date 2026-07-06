# 2026-05-31 — Execution 画面 / Overview の pin 중심 通一 + Discard 재설계 (Onda)

午後同日に取り込んだ `fix/execution-overview` (per-stage pct 統一) を超えて、Execution 画面と Overview
が **構造的に同じ run / 同じ stage_instances** を見るように pin 中心へ寄せた一連の修正。

## やったこと

### A. ExecutionPage (FE)

- **Discard 復活 + LAST RUN ヘッダー化**:
  - halted (success/failed/aborted) 時に Discard ボタン残存. failed/aborted は Discard + ↻ Retry,
    completed は Discard のみ. ▶ Start run はヘッダーから外し、Discard 押下後の no-active ブランチでのみ.
  - no-active ブランチで `pinLastRunId` (= `pinnedSnapshot.executionContext.runId`) から run を引いて
    LAST RUN として描画. pin 박제なしなら NO ACTIVE RUN + `no history yet`.
- **pin 切替 effect の巻き戻りバグ修正** (`prevPinIdRef`):
  - 初回マウント時: persisted `activeRunId` が **現在の pin と紐づく run** (= run.snapshotId === pin.id)
    なら尊重 (running 中の救済). 紐づかなければ `pin.executionContext.runId` で initialize.
  - 「running 중 → ページ遷移 → 戻る」で新 run id が古い박제に巻き戻る現象を防ぐ.
- **selectedTables 자동 동기を pin id 変更時のみに限定** (`prevSelectionPinIdRef`):
  - 旧仕様は `executionContext.runId` 変更でも同期 → run finish 後 success table のみで上書きされ起動時の選択が失われていた.
  - 新仕様: pin 切替時のみ新 pin の executionContext.stages から success table 同期. 同じ pin で run finish
    では何もしない → 起動時の選択を持続.
- **`controlsLocked` を旧仕様復帰**: `displayedActiveRun !== null || !hasPinnedSnapshot`. Discard 押下まで
  TableSelector / Preflight ロック.
- **Start run 직후 history 즉시 refetch**: `queryClient.invalidateQueries(['run-history', project.id])` を
  start API 成功直後に. `#N` 表示の最大 5 秒ラグを解消.

### B. preflight `asisSkips` 考慮 (FE)

- `lib/preflightValidation.ts:checkAsisUnmapped` で `ctx.snapshotData.asisSkips` を Set 化, 明示的 skip
  컬럼은 unmapped 判定から除外.
- `store/snapshots.ts:SnapshotData` 인터페이스에 `asisSkips?: FrozenAsisSkip[]` 추가. BE 측은 이미
  `SnapshotData.asisSkips` 로 동결하고 있었으나 FE 형 + `ensureSnapshotData` normalize 에서 누락.

### C. executionPreflight store (FE)

- `syncSelectedFromExecution` 추가: 자동 동기 전용. 집합 diff check + `isStale` 안 건드림.
- `setSelected` 에 집합 diff check 추가: 같은 set 이면 노 ops. 사용자 조작과 자동 동기를 호출처에서 분리.

### D. Overview pin 중심 통일

- **BE** `ExecutionOverviewService.metricsFor` 가 **baseline (pinned) snapshot 으로 기동된 최신 run** 을
  반환. pin 박제 없으면 project 전체 latest run fallback. running 중도 잡힘.
- **BE** `RunHistoryRepository.findFirstByProjectIdAndSnapshotIdOrderByStartedAtDesc` 추가.
- **FE** `ExecutionOverviewPage.metrics` derive 를 `const metrics = apiMetrics;` 한 줄로 단순화.
  pin.executionContext 경유의 上書き 폐지. BE 가 이미 pin 의 최신 run 을 반환하므로 중복 + 박제 stale 문제.
- **결과**: Execution 화면 (stage_instances live polling via `runsApi.stages`) 과 Overview (apiMetrics
  via `metricsFor`) 가 **구조적으로 같은 run / 같은 stage_instances** 를 본다. 표시가 자동으로 일치.
- **time travel 사용 사례 유지**: pin 을 옛 snapshot 으로 옮기면 BE 가 그 snapshot 의 최신 run 으로
  자동 전환. 별 처리 불요.

## 次のひとがやること

- **Stop の挙動 (의도적으로 손대지 않음)**: StageRunner 가 내부 ループ에서 `isCancelled()` 를 보지 않아
  Stage 진행 중에 Stop 눌러도 그 stage 는 완주해버린다. `LocalWorkerExecutor` 는 stage 경계에서만 break.
  사용자 결정으로 그대로 둔다 (partial commit safety 등 trade-off 있음). 즉시 정지가 필요해지면
  Load 같은 무거운 stage 의 per-table 루프에 `isCancelled()` 추가가 최소 변경.
- **finishRun 시 stage_instances 잔여 update**: abort 시 finishRun → recordExecutionContext 가 stage
  runner 완료를 기다리지 않고 즉시 박제하기 때문에 `pin.executionContext.stages` 가 항상 古い. 위
  D 항으로 Overview 는 영향 없게 됐지만 박제 자체는 古いまま残る (Versions / Artifacts 등 박제만
  보는 화면에 영향). 박제를 stage runner 완료 후로 미루는 옵션은 BE 락 문제로 보류.
- **`(project_id, snapshot_id, started_at desc)` 복합 인덱스**: 새 query 가 자주 돈다면 추가 검토.
- **legacy snapshot 의 `asisSkips` 누락**: 박제 도입 전 snapshot 은 빈 list. 사용자 측에서 한 번 재
  snapshot 작성하면 채워짐. backfill 안 한다.

## 함정 / 결정 履歴

- **pin.executionContext 경유 표시는 더 이상 쓰지 않는다 (Overview)**: 박제는 finishRun 시점 고정.
  Stop 직후의 finishRun 은 stage runner 가 還 走行中이라도 즉시 走るので, 박제는 「stage N = running,
  N+1 이후 pending」으로 굳어진다. 직후 stage runner 가 완주해 stage_instances 가 success 로 update
  되도 박제는 그대로. 이게 「리로드 시 一瞬正しい → 1 ゲージ少なくなる」 현상의 정체였다.
- **Discard 의 역할 = TableSelector 언락 + 헤더 정리** (재확인). controlsLocked 緩和 + Discard 폐지
  안을 한 번 도입했지만 「Discard 안 눌러도 테이블 선택 가능」 UX 모순을 사용자 지적, 旧仕様 복귀.
- **selectedTables 自動 동기의 발화 조건**: 「pin id 가 실제로 바뀐 순간」만. 같은 pin 으로 run finish
  → executionContext.runId 변경에는 반응 안 함. 起動 時선택 유지 = 사용자 명시 요청.
- **#N 표시 지연 해소는 React Query invalidate 만으로 충분**: BE 의 `runsApi.start` 가 동기 commit
  된 `RunHistory` 를 즉시 반환하므로 invalidate → 직후 refetch 로 history 에 새 run 이 들어온다.
- **pin 切替 effect 의 三状態 (initial / pinChanged / その他)**: 세 가지를 명확히 구분 안 하면
  「ページ 재방문 시 巻き戻り」 「pin 切替 시 동기 안 됨」 「Discard 후 재주입」 어딘가 깨진다.
  `prevPinIdRef` + runHistoryData 조회로 「persisted activeRunId 가 현 pin 의 run 인가」 판정.

## 안 한 것 (意図的으로)

- StageRunner 내부의 cancel check (Stop 즉시화). 위와 같이 사용자 판단.
- Quarantine warning 카운트의 자동 생성. enum / schema / UI 는 warning 을 가질 전제로 짜였지만 「무엇을
  warning 으로 할지」 의 판정 로직이 미구현. 별건으로 잔치.
- `pin.executionContext` 자체의 제거. Versions / Artifacts 등 「과거 박제만 보는」 화면은 여전히 박제를
  source 로 쓰므로 인터페이스는 유지. Overview 측 사용만 끊었음.
- ExecutionOverviewPage 에서 `pinnedByProject` 의 fetch (`fetchBySite`) 추가. dev 에서 처리됐는지 확인
  없이 일단 두고, 「리로드 시 VERSION 列이 — 가 되는」 현상이 재발하면 그 때.

## 確認用キーポイント

- Execution 화면 (Pipeline Stages 6 success + 2 pending) 과 Overview (per-row bar 緑 6 + 灰 2) 가 일치.
- Stop 누른 직후 / 리로드 직후 「一瞬正しい → 1 ゲージ少なくなる」 현상이 사라짐.
- failed run 의 헤더에 Discard + ↻ Retry 의 2 버튼. completed 는 Discard 만. running 은 Stop 만.
- Discard 직후 LAST RUN 헤더 표시 (`p-xxx · #N · status badge` + run id 줄). TableSelector / Preflight
  도 언락되어 다음 run 준비 가능.
- pin 을 별 snapshot 에 동인 + 戻し 로 Overview 의 bar 가 변하면 time travel 유지 확인.
- BE 재기동 필수: 새 repository method + service 분기.
