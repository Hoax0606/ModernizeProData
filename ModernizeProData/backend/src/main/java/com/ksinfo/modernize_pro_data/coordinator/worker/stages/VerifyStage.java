package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageRunner;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * Verify stage — TO-BE DB row_count 검증, 샘플 row 비교.
 * 실 로직은 후속 단계에서 채움.
 */
@Service
@Slf4j
public class VerifyStage implements StageRunner {

    @Override
    public String stageKey() {
        return "verify";
    }

    @Override
    public void run(StageContext ctx, StageInstance stage) {
        log.info("[stub] VerifyStage runId={}", ctx.getRunHistory().getId());
    }
}
