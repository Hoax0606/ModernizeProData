package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
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

    /* ── DTOs ─────────────────────────────────────────────────────── */

    public record UserDto(
            String id,
            String username,
            UserRole role,
            OffsetDateTime createdAt,
            OffsetDateTime lastSignInAt
    ) {
        static UserDto from(User u) {
            return new UserDto(u.getId(), u.getUsername(), u.getRole(),
                    u.getCreatedAt(), u.getLastSignInAt());
        }
    }

    public record CreateUserRequest(
            @NotBlank @Size(min = 2, max = 64) String username,
            @NotBlank @Size(min = 4, max = 128) String password,
            @NotNull UserRole role
    ) {}

    public record UpdateRoleRequest(@NotNull UserRole role) {}

    public record ChangePasswordRequest(
            @NotBlank String currentPassword,
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
        userRepository.save(u);
        log.info("User created: {} ({})", u.getUsername(), u.getRole());
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
        userRepository.delete(target);
        log.info("User deleted: {} ({})", target.getUsername(), target.getRole());
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
        target.setRole(req.role());
        userRepository.save(target);
        log.info("User role updated: {} → {}", target.getUsername(), req.role());
        return ApiResponse.ok(UserDto.from(target));
    }
}
