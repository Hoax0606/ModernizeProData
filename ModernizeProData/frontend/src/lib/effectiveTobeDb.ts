import type { Site, Project, TobeDbByEnv, TobeDbLocks } from '../store/workspace';

/**
 * Site.tobeDbScope 에 따라 어느 TO-BE DB 연결을 봐야 할지 결정한다.
 *
 *   scope === 'project' → Project.tobeDbByEnv (per-project),
 *   그 외(기본 'site') → Site.tobeDbByEnv (공유).
 *
 * project 가 null 이면 Site 의 것을 fallback — scope='project' 여도 활성 프로젝트가
 * 없으면 의미가 없으므로 안전한 기본을 돌려준다.
 */
export function effectiveTobeDb(
  site: Site | null,
  project: Project | null,
): TobeDbByEnv {
  if (!site) return {};
  if (site.tobeDbScope === 'project' && project) {
    return project.tobeDbByEnv ?? {};
  }
  // scope='site' 또는 scope='project' 인데 project 가 null 인 경우(AppShell 의 사이드바
  // 처럼 active 가 아닌 site chip) → Site 값을 보여준다. site→project 전환 시 backend
  // 가 Site 값을 모든 Project 로 복사하므로 dormant 값도 의미가 있다.
  return site.tobeDbByEnv ?? {};
}

/** effectiveTobeDb 와 동일 규칙의 lock 상태. */
export function effectiveTobeDbLocks(
  site: Site | null,
  project: Project | null,
): TobeDbLocks {
  if (!site) return {};
  if (site.tobeDbScope === 'project' && project) {
    return project.tobeDbLocks ?? {};
  }
  return site.tobeDbLocks ?? {};
}

/**
 * 현재 active environment 의 TO-BE DB 가 type/host/database/username 까지 채워졌는지.
 * Mapping/Execution/AppShell 등의 "DB 설정됨" chip 판단용 — 기존 siteDbConfigured 와
 * 동일한 기준을 scope 인지로 일원화.
 */
export function isTobeDbConfigured(
  site: Site | null,
  project: Project | null,
): boolean {
  if (!site || !site.environment) return false;
  const conn = effectiveTobeDb(site, project)[site.environment];
  if (!conn) return false;
  return !!(conn.type && conn.host && conn.database && conn.username);
}
