package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageRunner;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * Check stage — 입력 자산 (CSV / DDL / TO-BE DB 접속) 존재 검증.
 * 실 로직은 후속 단계에서 채움.
 */
@Service
@Slf4j
public class CheckStage implements StageRunner {

    @Override
    public String stageKey() {
        return "check";
    }

    @Override
    public void run(StageContext ctx, StageInstance stage) {
        log.info("[stub] CheckStage runId={} bindings={}",
                ctx.getRunHistory().getId(), ctx.getBindings().size());
    }
}
