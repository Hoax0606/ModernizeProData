import { api, unwrap, type ApiResponse } from './client';
import type { UserRole } from '../store/auth';

export interface ManagedUserDto {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  lastSignInAt?: string;
  hasActiveSession?: boolean;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  role: UserRole;
}

export interface UpdateRoleRequest {
  role: UserRole;
}

export const usersApi = {
  list: () =>
    unwrap(api.get<ApiResponse<ManagedUserDto[]>>('/api/v1/users')),

  create: (req: CreateUserRequest) =>
    unwrap(api.post<ApiResponse<ManagedUserDto>>('/api/v1/users', req)),

  delete: (id: string) =>
    unwrap(api.delete<ApiResponse<null>>(`/api/v1/users/${id}`)),

  updateRole: (id: string, role: UserRole) =>
    unwrap(api.patch<ApiResponse<ManagedUserDto>>(`/api/v1/users/${id}/role`, { role } satisfies UpdateRoleRequest)),

  changeMyPassword: (currentPassword: string, newPassword: string) =>
    unwrap(api.post<ApiResponse<null>>(`/api/v1/users/me/password`, { currentPassword, newPassword })),

  resetPassword: (id: string, newPassword: string) =>
    unwrap(api.post<ApiResponse<null>>(`/api/v1/users/${id}/password`, { newPassword })),

  /** master 가 다른 사용자의 활성 세션 강제 종료. */
  forceLogout: (id: string) =>
    unwrap(api.post<ApiResponse<null>>(`/api/v1/users/${id}/force-logout`)),
};
