package com.ksinfo.modernize_pro_data.coordinator.run;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.sql.Statement;
import java.util.Map;
import java.util.Set;
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
        /** 현재 이 run 에서 실행 중인 long-running JDBC Statement 들. cancel 시 interrupt 대상. */
        final Set<Statement> activeStatements = ConcurrentHashMap.newKeySet();
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

    /**
     * abort / timeout 시 호출 — (1) cancelled 플래그 set → executor 가 stage 경계/loop 에서 break,
     * (2) 현재 실행 중인 긴 DuckDB statement 를 {@link Statement#cancel()} 로 즉시 interrupt
     *     → CREATE TABLE AS read_csv / transform 같은 단일 대형 쿼리도 stage 경계까지 안 기다리고 멈춘다.
     *
     * statement.cancel() 은 다른 thread(이 abort thread)에서 호출 — JDBC cancel 의 정상 용법.
     * DuckDB JDBC(1.5.3.0)는 connection 단위 interrupt 라 run-scoped connection 에만 영향.
     * 미지원/이미 종료 등으로 throw 해도 무시(graceful) — 그 경우 기존처럼 다음 경계에서 반응.
     */
    public void cancel(String runId) {
        Control c = controls.get(runId);
        if (c == null) return;
        c.cancelled = true;
        for (Statement st : c.activeStatements) {
            try {
                st.cancel();
            } catch (Throwable t) {
                log.debug("statement.cancel() skipped (unsupported/closed) runId={}: {}", runId, t.toString());
            }
        }
    }

    public boolean isCancelled(String runId) {
        Control c = controls.get(runId);
        return c != null && c.cancelled;
    }

    /** 현재 이 프로세스에서 실행 중(register~remove 사이)인 run 수. adaptive memory_limit 산정용. */
    public int activeCount() {
        return controls.size();
    }

    /** 긴 쿼리 실행 직전 등록 — abort 시 interrupt 대상에 포함. {@link #unregisterStatement} 와 짝. */
    public void registerStatement(String runId, Statement st) {
        Control c = controls.get(runId);
        if (c != null && st != null) c.activeStatements.add(st);
    }

    /** 쿼리 종료 후 해제 (leak 방지). */
    public void unregisterStatement(String runId, Statement st) {
        Control c = controls.get(runId);
        if (c != null && st != null) c.activeStatements.remove(st);
    }
}
