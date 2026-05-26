package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageRunner;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * Load stage — parquet2 → TO-BE PostgreSQL COPY.
 * 실 로직은 후속 단계 (PgCopyManager 와 함께) 에서 채움.
 */
@Service
@Slf4j
public class LoadStage implements StageRunner {

    @Override
    public String stageKey() {
        return "load";
    }

    @Override
    public void run(StageContext ctx, StageInstance stage) {
        log.info("[stub] LoadStage runId={}", ctx.getRunHistory().getId());
    }
}
