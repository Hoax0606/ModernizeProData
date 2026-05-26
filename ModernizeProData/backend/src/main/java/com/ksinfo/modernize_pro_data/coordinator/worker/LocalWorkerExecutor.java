package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * In-process sequential stage 실행기. PoC 1차 default.
 *
 * Spring 이 모든 StageRunner @Service bean 을 autowire 하고, stageKey() 로 registry 구성.
 * RunService.startRun 끝에 호출.
 *
 * Continue-on-error: 한 stage 가 throw 해도 다음 stage 진행. 단 stage 자체가
 * tables_failed>0 으로 fail 마킹되면 cutover 단계에선 후속 stage skip (추후 확장).
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class LocalWorkerExecutor implements WorkerExecutor {

    private final List<StageRunner> stageRunners;

    private Map<String, StageRunner> registry;

    @PostConstruct
    void init() {
        registry = stageRunners.stream()
                .collect(Collectors.toMap(StageRunner::stageKey, r -> r));
        log.info("LocalWorkerExecutor initialized with stage runners: {}", registry.keySet());
    }

    @Override
    public void execute(StageContext ctx) {
        log.info("Run execution started runId={} stages={}",
                ctx.getRunHistory().getId(),
                ctx.getStages().stream().map(StageInstance::getStageKey).toList());

        for (StageInstance stage : ctx.getStages()) {
            StageRunner runner = registry.get(stage.getStageKey());
            if (runner == null) {
                log.warn("No StageRunner registered for stageKey={}, skipping", stage.getStageKey());
                continue;
            }
            try {
                runner.run(ctx, stage);
            } catch (Exception e) {
                log.error("StageRunner {} threw unexpectedly — continuing to next stage",
                        stage.getStageKey(), e);
            }
        }

        log.info("Run execution finished runId={}", ctx.getRunHistory().getId());
    }
}
