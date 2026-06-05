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

    /** {base}/{projectId}/{runIndex}-{ts}/ */
    private Path outputDir;

    /** DuckDB 안 schema name (run 별 격리). 예: run_r-12345678 */
    private String duckdbSchema;

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
