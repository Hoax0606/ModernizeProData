package com.ksinfo.modernize_pro_data.coordinator.run;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 실행 중 run 의 in-memory 제어 플래그 (cancel).
 *
 * LocalWorkerExecutor 가 stage 경계마다 {@link #isCancelled} 를 체크해 cancelled 면
 * 즉시 break. abort / timeout endpoint 가 다른 thread 에서 플래그를 set.
 * (동기 실행이라 stage 중간엔 못 멈춤 — 다음 경계에서 반응.)
 *
 * 메타 DB 상태(run_history.status)와 별개로, 실행 thread 를 멈추기 위한 휘발성 신호.
 * 프로세스 재시작 시 사라짐 — run 도 같이 끝나므로 무방.
 *
 * 2026-05-29: pause/resume/awaitWhilePaused 제거. Stop + Retry (resume-from-failed-stage) 가
 * 기능 동치라 UI 단순화 결정. project_pause_removed 메모리 참조.
 */
@Component
@Slf4j
public class RunControlRegistry {

    private static final class Control {
        volatile boolean cancelled;
    }

    private final Map<String, Control> controls = new ConcurrentHashMap<>();

    /** run 시작 시 등록. */
    public void register(String runId) {
        controls.put(runId, new Control());
    }

    /** run 종료 시 제거. */
    public void remove(String runId) {
        controls.remove(runId);
    }

    /** abort / timeout 시 호출 — executor 가 다음 stage 경계에서 break. */
    public void cancel(String runId) {
        Control c = controls.get(runId);
        if (c != null) c.cancelled = true;
    }

    public boolean isCancelled(String runId) {
        Control c = controls.get(runId);
        return c != null && c.cancelled;
    }
}
