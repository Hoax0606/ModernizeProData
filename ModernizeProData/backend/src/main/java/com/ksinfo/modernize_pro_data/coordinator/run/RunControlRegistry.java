package com.ksinfo.modernize_pro_data.coordinator.run;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 실행 중 run 의 in-memory 제어 플래그 (pause / cancel).
 *
 * LocalWorkerExecutor 가 stage 경계마다 {@link #awaitWhilePaused} 를 호출해 paused 동안 대기하고,
 * cancelled 면 즉시 빠져나온다. pause/resume/abort endpoint 가 다른 thread 에서 플래그를 set.
 * (동기 실행이라 stage 중간엔 못 멈춤 — 다음 경계에서 반응.)
 *
 * 메타 DB 상태(run_history.status)와 별개로, 실행 thread 를 깨우/멈추기 위한 휘발성 신호.
 * 프로세스 재시작 시 사라짐 — run 도 같이 끝나므로 무방.
 */
@Component
@Slf4j
public class RunControlRegistry {

    private static final long POLL_MS = 500;

    private static final class Control {
        volatile boolean paused;
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

    public void pause(String runId) {
        Control c = controls.get(runId);
        if (c != null) c.paused = true;
    }

    public void resume(String runId) {
        Control c = controls.get(runId);
        if (c != null) c.paused = false;
    }

    /** abort/timeout 시 호출 — paused 로 대기 중인 executor 를 깨워 중단시킨다. */
    public void cancel(String runId) {
        Control c = controls.get(runId);
        if (c != null) c.cancelled = true;
    }

    public boolean isCancelled(String runId) {
        Control c = controls.get(runId);
        return c != null && c.cancelled;
    }

    /** paused 동안 대기 (poll). cancelled 되면 즉시 반환. 미등록이면 즉시 반환. */
    public void awaitWhilePaused(String runId) {
        Control c = controls.get(runId);
        if (c == null) return;
        while (c.paused && !c.cancelled) {
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }
}
