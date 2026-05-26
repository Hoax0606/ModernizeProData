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

    public Path parquet1Dir()  { return outputDir.resolve("parquet1"); }
    public Path parquet2Dir()  { return outputDir.resolve("parquet2"); }
    public Path quarantineDir(){ return outputDir.resolve("quarantine"); }

    public long nextLogSeq() { return ++logLineSeqCursor; }
}
