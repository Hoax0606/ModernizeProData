import { useAuthStore } from './auth';
import { useWorkspaceStore, type Project } from './workspace';

/**
 * 프로젝트가 현재 사용자에게 read-only 인지 판정.
 * - master 는 항상 false (모든 프로젝트 편집 가능)
 * - 그 외는 project.assignee === user.username 일 때만 false. unassigned 도 read-only.
 */
export function isProjectReadOnly(p: Project | null | undefined, user: { role?: string; username?: string } | null | undefined): boolean {
  if (!p) return false;
  if (!user) return true;
  if (user.role === 'master') return false;
  return p.assignee !== user.username;
}

/** 활성 프로젝트가 read-only 인지 — AppShell / 페이지들이 공유. */
export function useActiveProjectReadOnly(): boolean {
  const user = useAuthStore((s) => s.user);
  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  return isProjectReadOnly(project, user);
}
