package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.auth.AuthService;
import com.ksinfo.modernize_pro_data.coordinator.user.PgRoleService;
import com.ksinfo.modernize_pro_data.coordinator.user.User;
import com.ksinfo.modernize_pro_data.coordinator.user.UserRepository;
import com.ksinfo.modernize_pro_data.coordinator.user.UserRole;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 사용자 관리 API — Coordinator (master) 만 사용 가능.
 *
 * GET    /api/v1/users           — 전체 목록
 * POST   /api/v1/users           — 사용자 발급 (master only)
 * DELETE /api/v1/users/{id}      — 삭제 (master only, self-delete 금지)
 * PATCH  /api/v1/users/{id}/role — 역할 변경 (master only, self-demotion 금지)
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/users")
@RequiredArgsConstructor
public class UserController {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final AuthService authService;
    private final PgRoleService pgRoleService;

    /* ── DTOs ─────────────────────────────────────────────────────── */

    public record UserDto(
            String id,
            String username,
            UserRole role,
            String siteId,
            OffsetDateTime createdAt,
            OffsetDateTime lastSignInAt,
            boolean hasActiveSession
    ) {
        static UserDto from(User u) {
            boolean active = u.getCurrentSessionId() != null
                    && u.getCurrentSessionExpiresAt() != null
                    && u.getCurrentSessionExpiresAt().isAfter(OffsetDateTime.now());
            return new UserDto(u.getId(), u.getUsername(), u.getRole(),
                    u.getSiteId(),
                    u.getCreatedAt(), u.getLastSignInAt(), active);
        }
    }

    public record CreateUserRequest(
            @NotBlank @Size(min = 2, max = 64) String username,
            @NotBlank @Size(min = 4, max = 128) String password,
            @NotNull UserRole role,
            /** Optional. Required (by app logic) when role=admin so worker_node
             *  rows know which site this admin belongs to. */
            String siteId
    ) {}

    public record UpdateRoleRequest(@NotNull UserRole role) {}

    public record ChangePasswordRequest(
            @NotBlank String currentPassword,
            @NotBlank @Size(min = 4, max = 128) String newPassword
    ) {}

    public record ResetPasswordRequest(
            @NotBlank @Size(min = 4, max = 128) String newPassword
    ) {}

    /* ── Endpoints ─────────────────────────────────────────────────── */

    @GetMapping
    @PreAuthorize("hasRole('MASTER')")
    public ApiResponse<List<UserDto>> list() {
        var users = userRepository.findAll().stream().map(UserDto::from).toList();
        return ApiResponse.ok(users);
    }

    @PostMapping
    @PreAuthorize("hasRole('MASTER')")
    @Transactional
    public ApiResponse<UserDto> create(@Valid @RequestBody CreateUserRequest req) {
        if (userRepository.existsByUsername(req.username())) {
            throw new ApiException(
                    "USER_ALREADY_EXISTS",
                    "이미 존재하는 사용자명입니다",
                    HttpStatus.CONFLICT);
        }
        User u = User.create(
                req.username(),
                passwordEncoder.encode(req.password()),
                req.role()
        );
        if (req.siteId() != null && !req.siteId().isBlank()) {
            u.setSiteId(req.siteId());
        }
        userRepository.save(u);
        log.info("User created: {} ({})", u.getUsername(), u.getRole());

        // admin = Worker daemon login 계정. 같은 username/password 로 메타 PG role 도 발급해서
        // Worker process 가 메타 DB 에 분리 계정으로 직접 connect 할 수 있게 한다.
        if (req.role() == UserRole.admin) {
            try {
                pgRoleService.createWorkerRole(u.getUsername(), req.password());
            } catch (IllegalArgumentException e) {
                throw new ApiException("USER_INVALID_USERNAME_FOR_PG_ROLE",
                        e.getMessage(), HttpStatus.BAD_REQUEST);
            }
        }
        return ApiResponse.ok(UserDto.from(u));
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('MASTER')")
    @Transactional
    public ApiResponse<Void> delete(
            @PathVariable String id,
            org.springframework.security.core.Authentication auth
    ) {
        User target = userRepository.findById(id)
                .orElseThrow(() -> new ApiException(
                        "USER_NOT_FOUND", "사용자를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        if (auth != null && target.getUsername().equals(auth.getName())) {
            throw new ApiException(
                    "USER_SELF_DELETE",
                    "자기 자신은 삭제할 수 없습니다",
                    HttpStatus.BAD_REQUEST);
        }
        boolean wasAdmin = target.getRole() == UserRole.admin;
        String username = target.getUsername();
        userRepository.delete(target);
        log.info("User deleted: {} ({})", username, target.getRole());

        // Worker 였다면 메타 PG role 도 같이 정리. 운영 중 worker session 은 자체 종료 안 되지만
        // 다음 heartbeat 시 PG 인증 실패하면서 자연 종료.
        if (wasAdmin) {
            pgRoleService.dropWorkerRole(username);
        }
        return ApiResponse.ok(null);
    }

    @PostMapping("/me/password")
    @Transactional
    public ApiResponse<Void> changeMyPassword(
            @Valid @RequestBody ChangePasswordRequest req,
            org.springframework.security.core.Authentication auth
    ) {
        if (auth == null || auth.getName() == null) {
            throw new ApiException("UNAUTHORIZED", "로그인이 필요합니다", HttpStatus.UNAUTHORIZED);
        }
        User u = userRepository.findByUsername(auth.getName())
                .orElseThrow(() -> new ApiException(
                        "USER_NOT_FOUND", "사용자를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        if (!passwordEncoder.matches(req.currentPassword(), u.getPasswordHash())) {
            throw new ApiException(
                    "CURRENT_PASSWORD_INVALID",
                    "현재 비밀번호가 일치하지 않습니다",
                    HttpStatus.BAD_REQUEST);
        }
        if (req.currentPassword().equals(req.newPassword())) {
            throw new ApiException(
                    "PASSWORD_SAME",
                    "새 비밀번호가 기존과 동일합니다",
                    HttpStatus.BAD_REQUEST);
        }
        u.setPasswordHash(passwordEncoder.encode(req.newPassword()));
        userRepository.save(u);
        log.info("Password changed: {}", u.getUsername());

        // admin = Worker. app password 와 PG role password 를 동일하게 유지.
        if (u.getRole() == UserRole.admin) {
            pgRoleService.changeWorkerPassword(u.getUsername(), req.newPassword());
        }
        return ApiResponse.ok(null);
    }

    @PostMapping("/{id}/password")
    @PreAuthorize("hasRole('MASTER')")
    @Transactional
    public ApiResponse<Void> resetPassword(
            @PathVariable String id,
            @Valid @RequestBody ResetPasswordRequest req,
            org.springframework.security.core.Authentication auth
    ) {
        User target = userRepository.findById(id)
                .orElseThrow(() -> new ApiException(
                        "USER_NOT_FOUND", "사용자를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        // 자기 자신 reset 은 me/password 사용 (current password 검증 위해)
        if (auth != null && target.getUsername().equals(auth.getName())) {
            throw new ApiException(
                    "PASSWORD_SELF_RESET",
                    "자기 자신의 비밀번호는 Account profile 에서 변경하세요",
                    HttpStatus.BAD_REQUEST);
        }

        target.setPasswordHash(passwordEncoder.encode(req.newPassword()));
        // 보안: 비번 강제 변경되었으므로 대상 user 의 활성 세션 무효화 (다음 요청에서 401).
        target.setCurrentSessionId(null);
        target.setCurrentSessionIssuedAt(null);
        target.setCurrentSessionExpiresAt(null);
        userRepository.save(target);

        log.info("Password reset by admin: {} (by {})", target.getUsername(),
                auth != null ? auth.getName() : "system");

        // admin = Worker. PG role password 도 같이 갱신.
        if (target.getRole() == UserRole.admin) {
            pgRoleService.changeWorkerPassword(target.getUsername(), req.newPassword());
        }
        return ApiResponse.ok(null);
    }

    @PostMapping("/{id}/force-logout")
    @PreAuthorize("hasRole('MASTER')")
    @Transactional
    public ApiResponse<Void> forceLogout(
            @PathVariable String id,
            org.springframework.security.core.Authentication auth
    ) {
        User target = userRepository.findById(id)
                .orElseThrow(() -> new ApiException(
                        "USER_NOT_FOUND", "사용자를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        if (auth != null && target.getUsername().equals(auth.getName())) {
            throw new ApiException(
                    "FORCE_LOGOUT_SELF",
                    "자기 자신의 세션은 강제 종료할 수 없습니다. Sign out 으로 종료하세요.",
                    HttpStatus.BAD_REQUEST);
        }
        authService.forceLogout(target.getUsername(), auth != null ? auth.getName() : "system");
        return ApiResponse.ok(null);
    }

    @PatchMapping("/{id}/role")
    @PreAuthorize("hasRole('MASTER')")
    @Transactional
    public ApiResponse<UserDto> updateRole(
            @PathVariable String id,
            @Valid @RequestBody UpdateRoleRequest req,
            org.springframework.security.core.Authentication auth
    ) {
        User target = userRepository.findById(id)
                .orElseThrow(() -> new ApiException(
                        "USER_NOT_FOUND", "사용자를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        if (auth != null && target.getUsername().equals(auth.getName())
                && target.getRole() == UserRole.master && req.role() != UserRole.master) {
            throw new ApiException(
                    "USER_SELF_DEMOTE",
                    "자기 자신의 master 권한을 해제할 수 없습니다",
                    HttpStatus.BAD_REQUEST);
        }

        // admin ↔ 다른 role 변경 거절. admin promote 시 PG role 신규 발급에 평문 password 가
        // 필요하고, demote 시 worker daemon 의 PG 접속이 끊겨야 한다. 운영 흐름이 복잡해서
        // PoC 1차에는 신규 user 발급 + 기존 삭제 로 처리하도록 닫는다.
        boolean adminInvolved = target.getRole() == UserRole.admin || req.role() == UserRole.admin;
        if (adminInvolved && target.getRole() != req.role()) {
            throw new ApiException(
                    "USER_ROLE_CHANGE_NOT_SUPPORTED",
                    "admin (Worker) 권한은 발급/삭제로만 관리합니다. 신규 user 를 만들고 기존을 삭제하세요.",
                    HttpStatus.BAD_REQUEST);
        }

        target.setRole(req.role());
        userRepository.save(target);
        log.info("User role updated: {} → {}", target.getUsername(), req.role());
        return ApiResponse.ok(UserDto.from(target));
    }
}
