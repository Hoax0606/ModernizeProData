package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
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
