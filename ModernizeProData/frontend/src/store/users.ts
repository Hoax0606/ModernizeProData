import { create } from 'zustand';
import type { UserRole } from './auth';
import { usersApi, type ManagedUserDto } from '../api/users';

export interface ManagedUser {
  id: string;
  username: string;
  role: UserRole;
  siteId?: string | null;
  createdAt: string;
  lastSignInAt?: string;
}

interface UsersState {
  users: ManagedUser[];
  loading: boolean;
  error: string | null;

  loadUsers: () => Promise<void>;
  addUser: (data: { username: string; password: string; role: UserRole; siteId?: string | null }) => Promise<ManagedUser>;
  updateUserRole: (id: string, role: UserRole) => Promise<void>;
  deleteUser: (id: string) => Promise<void>;
  reset: () => void;
}

const toManaged = (dto: ManagedUserDto): ManagedUser => ({
  id: dto.id,
  username: dto.username,
  role: dto.role,
  siteId: dto.siteId ?? null,
  createdAt: dto.createdAt,
  lastSignInAt: dto.lastSignInAt,
});

/**
 * 사용자 계정 목록 store.
 * 백엔드 (PostgreSQL) 가 source of truth. localStorage 영속 X — 매 로그인 시 fresh fetch.
 * master 권한이 있을 때만 GET 가능 (백엔드 @PreAuthorize 가 게이트).
 */
export const useUsersStore = create<UsersState>()((set) => ({
  users: [],
  loading: false,
  error: null,

  loadUsers: async () => {
    set({ loading: true, error: null });
    try {
      const dtos = await usersApi.list();
      set({ users: dtos.map(toManaged), loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  addUser: async (data) => {
    const dto = await usersApi.create(data);
    const u = toManaged(dto);
    set((s) => ({ users: [...s.users, u] }));
    return u;
  },

  updateUserRole: async (id, role) => {
    const dto = await usersApi.updateRole(id, role);
    const u = toManaged(dto);
    set((s) => ({ users: s.users.map((x) => (x.id === id ? u : x)) }));
  },

  deleteUser: async (id) => {
    await usersApi.delete(id);
    set((s) => ({ users: s.users.filter((u) => u.id !== id) }));
  },

  reset: () => set({ users: [], loading: false, error: null }),
}));
