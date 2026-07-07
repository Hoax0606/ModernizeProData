package com.ksinfo.modernize_pro_data.coordinator.user;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.regex.Pattern;

/**
 * Worker (= UserRole.admin) 발급 시 메타 PG 에 동일 username/password 의 LOGIN role 도
 * 같이 만든다. 그 role 로 Worker process 가 메타 DB 에 직접 connect 한다.
 *
 * <p>설계 결정 (2026-05-29):
 * <ul>
 *   <li>admin user 1 개 = PG role 1 개. username/password 동일. 사용자가 외울 credential 1개.</li>
 *   <li>master/viewer 는 Worker 가 아니므로 PG role 미발급.</li>
 *   <li>role 변경 (admin ↔ 다른) 은 UserController 에서 별도 거절. promote 가 흔하지 않고
 *       PG role 신규 발급에 평문 password 가 필요해 운영 흐름이 복잡해지므로 PoC 1차 단순화.</li>
 *   <li>권한은 built-in {@code pg_read_all_data} + {@code pg_write_all_data} grant 로 일괄.
 *       schema 변경 (CREATE/ALTER/DROP TABLE, Flyway) 은 owner ({@code mpd}) 단독.</li>
 * </ul>
 *
 * <p>전제: 메타 PG 의 {@code mpd} 계정에 {@code CREATEROLE} attribute 가 부여되어 있어야 한다.
 * 부팅 시 {@link #ensureMasterCanCreateRoles()} 가 자기 자신에게 grant 시도하지만, 권한
 * 자체가 없으면 no-op (super user 가 별도 셋업).
 *
 * <p>SQL injection 방지: username 은 identifier 자리라 PreparedStatement 의 {@code ?} 가
 * 못 끼어든다. {@link #USERNAME_PATTERN} 으로 strict allow-list 검증 후 그대로 박는다.
 * password 는 literal 자리라 single-quote escape 만으로 충분 (PG dollar-quote 도 가능).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PgRoleService {

    /** Worker daemon login 가능한 PG role 의 username 패턴. 영문 lowercase 시작, 추가 [a-z0-9_], 2~63자. */
    public static final Pattern USERNAME_PATTERN = Pattern.compile("^[a-z][a-z0-9_]{1,62}$");

    private final JdbcTemplate jdbc;

    /**
     * 부팅 시 {@code mpd} 자신에게 CREATEROLE 권한이 있는지 확인. 없으면 경고 log.
     * super user 가 별도 grant 해야 동작.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void ensureMasterCanCreateRoles() {
        try {
            // super user 는 모든 권한 implicit 이므로 rolsuper / rolcreaterole 둘 중 하나만 true 면 OK.
            Boolean canCreate = jdbc.queryForObject(
                    "SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user",
                    Boolean.class);
            if (Boolean.FALSE.equals(canCreate)) {
                log.warn("Meta PG owner role lacks CREATEROLE attribute — admin user issuance will fail. "
                        + "Run: ALTER ROLE <owner> WITH CREATEROLE; as super user.");
            }
        } catch (DataAccessException e) {
            log.warn("Failed to check CREATEROLE attribute: {}", e.getMessage());
        }
    }

    /**
     * Worker 용 PG role 신규 생성. admin user 발급 시 호출.
     * 이미 존재하면 password 만 갱신 (idempotent).
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void createWorkerRole(String username, String plainPassword) {
        validateUsername(username);
        String quotedIdent = quoteIdentifier(username);
        String quotedLit   = quoteLiteral(plainPassword);

        // 존재 여부 검사 후 분기 — PG 가 CREATE ROLE IF NOT EXISTS 를 지원 안 해서 두 단계.
        // COUNT(*) = 항상 1 row 반환 (0 또는 1). SELECT 1 + queryForObject 면 0 row 시
        // EmptyResultDataAccessException throw → user create transaction 통째 롤백.
        Integer exists = jdbc.queryForObject(
                "SELECT COUNT(*) FROM pg_roles WHERE rolname = ?",
                Integer.class, username);
        if (exists != null && exists > 0) {
            jdbc.execute("ALTER ROLE " + quotedIdent + " WITH LOGIN PASSWORD " + quotedLit);
            log.info("PG role updated (existing): {}", username);
        } else {
            jdbc.execute("CREATE ROLE " + quotedIdent + " WITH LOGIN PASSWORD " + quotedLit);
            log.info("PG role created: {}", username);
        }
        grantWorkerPrivileges(quotedIdent);
    }

    /** 비번 변경. resetPassword / changeMyPassword 의 admin 케이스에서 호출. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void changeWorkerPassword(String username, String newPlainPassword) {
        validateUsername(username);
        String quotedIdent = quoteIdentifier(username);
        String quotedLit   = quoteLiteral(newPlainPassword);

        Integer exists = jdbc.queryForObject(
                "SELECT COUNT(*) FROM pg_roles WHERE rolname = ?",
                Integer.class, username);
        if (exists == null || exists == 0) {
            log.warn("PG role missing for admin user {} — re-creating", username);
            createWorkerRole(username, newPlainPassword);
            return;
        }
        jdbc.execute("ALTER ROLE " + quotedIdent + " WITH PASSWORD " + quotedLit);
        log.info("PG role password updated: {}", username);
    }

    /**
     * Worker role 삭제. admin user delete 시 호출.
     * REVOKE 먼저 (built-in role membership 만 회수, owned object 는 없음).
     * 해당 role 의 active session 은 PG 가 자동 종료하지 않으므로 호출자가 worker-side 처리 (heartbeat 401 → 자동 재로그인 실패).
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void dropWorkerRole(String username) {
        validateUsername(username);
        String quotedIdent = quoteIdentifier(username);
        Integer exists = jdbc.queryForObject(
                "SELECT COUNT(*) FROM pg_roles WHERE rolname = ?",
                Integer.class, username);
        if (exists == null || exists == 0) {
            log.info("PG role dropWorkerRole: {} does not exist — skipping", username);
            return;
        }
        // built-in role membership 만 회수. 객체 owner 가 아닌 단순 member 라 REASSIGN OWNED 불요.
        try {
            jdbc.execute("REVOKE pg_read_all_data, pg_write_all_data FROM " + quotedIdent);
        } catch (DataAccessException e) {
            log.debug("REVOKE before DROP for {} failed (likely already revoked): {}", username, e.getMessage());
        }
        jdbc.execute("DROP ROLE " + quotedIdent);
        log.info("PG role dropped: {}", username);
    }

    /* ── helpers ──────────────────────────────────────────────────────── */

    private void grantWorkerPrivileges(String quotedIdent) {
        // built-in role (PG 14+) — 모든 schema 의 모든 테이블 R/W. CREATE TABLE 같은 DDL 은 미포함.
        jdbc.execute("GRANT pg_read_all_data, pg_write_all_data TO " + quotedIdent);
    }

    private static void validateUsername(String username) {
        if (username == null || !USERNAME_PATTERN.matcher(username).matches()) {
            throw new IllegalArgumentException("invalid PG role name: " + username
                    + " (expected /^[a-z][a-z0-9_]{1,62}$/)");
        }
    }

    /** PG identifier 안전 인용 — allow-list 통과한 username 이라 추가 escape 불필요하지만 일관성 위해 quote. */
    private static String quoteIdentifier(String ident) {
        return "\"" + ident.replace("\"", "\"\"") + "\"";
    }

    /** PG string literal 안전 인용 — single-quote 만 escape. */
    private static String quoteLiteral(String s) {
        if (s == null) throw new IllegalArgumentException("password must not be null");
        return "'" + s.replace("'", "''") + "'";
    }
}
