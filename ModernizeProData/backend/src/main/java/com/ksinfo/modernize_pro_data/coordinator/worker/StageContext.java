package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.run.RunControlRegistry;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistory;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import lombok.Builder;
import lombok.Getter;
import lombok.Setter;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Run 1회분의 stage 실행 동안 공유되는 컨텍스트.
 *
 * Stage runner 들이 같은 ctx 를 통해:
 *   - 어느 run 인지 (runHistory)
 *   - 어느 project / site (project, site)
 *   - 처리 대상 binding 들 (bindings)
 *   - 출력 디렉토리 (outputDir, parquet1/parquet2/quarantine/...)
 *   - DuckDB 안에서 사용할 schema name (duckdbSchema) — run 별로 분리
 *
 * 를 공유.
 *
 * 자세한 mutable runtime state (각 stage 의 logLineSeqCursor 등) 도 여기에 둔다.
 */
@Getter
@Setter
@Builder
public class StageContext {

    private RunHistory runHistory;
    private Project project;
    private Site site;
    private List<MappingTableBinding> bindings;
    private List<StageInstance> stages;

    /**
     * Cancel 신호 체크용 — abort/timeout 신호를 stage runner 가 table loop 마다 확인.
     * RunExecutionListener 가 ctx 빌드 시 주입. null 이면 cancel 체크 비활성 (단위 테스트 등).
     */
    private RunControlRegistry runControlRegistry;

    /**
     * Stage runner 가 table loop 마다 호출 — cancel 신호 set 됐으면 즉시 throw.
     * LocalWorkerExecutor 가 그것을 catch 해서 현재 stage 의 status 를 failed 로 마킹.
     * registry 없으면 (테스트 환경) 아무것도 안 함.
     */
    public void throwIfCancelled() {
        if (runControlRegistry != null && runHistory != null
                && runControlRegistry.isCancelled(runHistory.getId())) {
            throw new RunCancelledException("Run cancelled — runId=" + runHistory.getId());
        }
    }

    /** runCancellable 에 넘기는 SQL 동작 (Exception 던질 수 있음). */
    @FunctionalInterface
    public interface SqlAction {
        void run() throws Exception;
    }

    /**
     * 긴 단일 쿼리(예: CREATE TABLE AS read_csv, transform)를 실행하는 동안 {@code st} 를
     * RunControlRegistry 에 등록해, abort/timeout 시 {@link java.sql.Statement#cancel()} 로
     * 쿼리 진행 중에도 즉시 interrupt 되게 한다. throwIfCancelled 가 쿼리 <em>직전</em>에만
     * 잡던 갭(긴 쿼리 도중엔 stage 끝까지 대기)을 메운다.
     *
     * <p>interrupt 로 인해 action 이 예외를 던지고 그 시점 run 이 cancelled 상태면, 일반 실패가
     * 아니라 {@link RunCancelledException} 으로 전환해 던진다(호출부가 cancel 을 그대로 전파하도록).
     */
    public void runCancellable(java.sql.Statement st, SqlAction action) throws Exception {
        String runId = runHistory != null ? runHistory.getId() : null;
        boolean registered = false;
        if (runControlRegistry != null && runId != null && st != null) {
            runControlRegistry.registerStatement(runId, st);
            registered = true;
        }
        try {
            action.run();
        } catch (Exception e) {
            if (runControlRegistry != null && runId != null && runControlRegistry.isCancelled(runId)) {
                throw new RunCancelledException("Run cancelled (statement interrupted) — runId=" + runId);
            }
            throw e;
        } finally {
            if (registered) runControlRegistry.unregisterStatement(runId, st);
        }
    }

    /** {base}/{projectId}/{runIndex}-{ts}/ */
    private Path outputDir;

    /** DuckDB 안 schema name (run 별 격리). 예: run_r-12345678 */
    private String duckdbSchema;

    /**
     * 이 run 의 DuckDB connection (RunExecutionListener 가 bind 직후 주입).
     * LoadStage 의 병렬 Future thread 는 ThreadLocal(runScoped)을 못 보므로, run connection 을
     * ctx 로 받아 duplicate 해야 run 전용 인스턴스의 데이터를 조회할 수 있다. memory-mode 가
     * 아니거나 bind 실패면 null → duplicateOf 가 공유 base 폴백.
     */
    private java.sql.Connection duckConnection;

    /** RunLog ingest 의 line seq cursor. stage runner 가 ingest 후 update. */
    private long logLineSeqCursor;

    /**
     * ExtractStage 가 채우는 binding 별 AS-IS CSV 메타데이터(mtime+size). key = binding.getId().
     * Validation 의 WARN ack carry-over fingerprint 매칭(정책 3·6)에 사용 — 같은 CSV 일 때만
     * 이전 ack 가 carry-over 되도록.
     */
    @Builder.Default
    private final Map<String, CsvFingerprint> csvFingerprintByBinding = new ConcurrentHashMap<>();

    /** AS-IS CSV fingerprint — 한 binding 의 모든 source CSV 를 합산(size 합 / mtime 최댓값). */
    public record CsvFingerprint(long mtimeMs, long size) {}

    public void putCsvFingerprint(String bindingId, long mtimeMs, long size) {
        csvFingerprintByBinding.put(bindingId, new CsvFingerprint(mtimeMs, size));
    }

    /** binding 의 CSV fingerprint. ExtractStage 미실행/미저장 시 null (= carry-over 비활성). */
    public CsvFingerprint getCsvFingerprint(String bindingId) {
        return csvFingerprintByBinding.get(bindingId);
    }

    public Path parquet1Dir()  { return outputDir.resolve("parquet1"); }
    public Path parquet2Dir()  { return outputDir.resolve("parquet2"); }
    public Path quarantineDir(){ return outputDir.resolve("quarantine"); }

    /** 병렬 적재(Load) 에서 여러 thread 가 동시에 호출 → synchronized 로 seq race 방지. */
    public synchronized long nextLogSeq() { return ++logLineSeqCursor; }
}
