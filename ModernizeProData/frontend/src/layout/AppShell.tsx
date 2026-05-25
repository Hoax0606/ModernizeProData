import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { Outlet, NavLink, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuthStore, roleLabel } from '../store/auth';
import { authApi } from '../api/auth';
import { useUsersStore } from '../store/users';
import { BrandName } from '../components/BrandName';
import { AboutModal } from '../components/AboutModal';
import { HelpModal } from '../components/HelpModal';
import { AccountProfileModal } from '../components/AccountProfileModal';
import { SolutionSettingsModal } from '../components/SolutionSettingsModal';
import { SiteSettingsModal } from '../components/SiteSettingsModal';
import { CreateSiteModal } from '../components/CreateSiteModal';
import { CreateProjectModal } from '../components/CreateProjectModal';
import { SignOutModal } from '../components/SignOutModal';
import { ClusterAdminModal } from '../components/ClusterAdminModal';
import { NotificationToast } from '../components/NotificationToast';
import { LicenseBanner } from '../components/LicenseBanner';
import { LockIcon } from '../components/LockIcon';
import { HourglassHalfIcon } from '../components/HourglassHalfIcon';
import { useLicenseStore } from '../store/license';
import { useWorkspaceStore } from '../store/workspace';
import { useUiStore } from '../store/ui';
import { isProjectReadOnly } from '../store/readOnly';
import { useSnapshotsStore } from '../store/snapshots';
import { useAsisDdlStore } from '../store/asisDdl';
import { useTobeDdlStore } from '../store/tobeDdl';
import {
  DEMO_ASIS_SCHEMA,
  DEMO_PROJECT,
  DEMO_PROJECT_ID,
  DEMO_SITE,
  DEMO_SITE_ID,
  DEMO_TOBE_SCHEMA,
} from '../lib/demoFixtures';
import { useDemoMode } from '../lib/useDemoMode';
import { useAuditLogStore } from '../store/auditLog';
import { useNotificationStore } from '../store/notifications';
import { useNotificationPrefsStore, isEventEnabled, actionToEventKey } from '../store/notificationPreferences';
import { useSettingsStore, type ProjectSort } from '../store/settings';
import { useT } from '../i18n';

/**
 * Prototype 의 메인 셸 (사이드바 + 탑바 + 탭바) 을 그대로 구현.
 * 데이터(프로젝트·사이트·알림)는 아직 없어 placeholder 로 채움.
 */
export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const t = useT();

  // `?demo=preflight` 진입 시 workspace + asisDdl + tobeDdl store 에 demo fixture 를
  // 한 번 inject 하고, demo 가 빠질 때 정확히 원복. demo flag 는 sessionStorage
  // 기반이라 URL 에서 query 가 빠져도 (다른 페이지로 navigate 해도) 유지된다.
  const { isDemo } = useDemoMode();

  // Pre-flight 의 csv-arrived / conn-tobe Fix 가 `?siteSettings=csv|tobe-db` 를 붙이면
  // SiteSettingsModal 을 자동 open + 해당 섹션을 1초 강조. URL 쿼리는 즉시 정리해서
  // 다음 navigate 시 또 트리거되지 않도록.
  //
  // 주의: highlight set + setSearchParams + setTimeout(reset) 을 한 effect 안에 두면
  // setSearchParams 가 deps(searchParams) 를 바꿔 effect 재실행 + cleanup 이 setTimeout
  // 을 취소 → highlight 가 영원히 reset 되지 않는다. 그래서 두 effect 로 분리한다.
  const [siteSettingsHighlight, setSiteSettingsHighlight] = useState<'csv' | 'tobe-db' | null>(null);
  useEffect(() => {
    const h = searchParams.get('siteSettings');
    if (h !== 'csv' && h !== 'tobe-db') return;
    setSiteSettingsOpen(true);
    setSiteSettingsHighlight(h);
    const next = new URLSearchParams(searchParams);
    next.delete('siteSettings');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  useEffect(() => {
    if (!siteSettingsHighlight) return;
    const id = window.setTimeout(() => setSiteSettingsHighlight(null), 1000);
    return () => window.clearTimeout(id);
  }, [siteSettingsHighlight]);
  useEffect(() => {
    if (!isDemo) return;
    /* 실 데이터 백업 — exit 시 정확히 복원하기 위함. demo 동안엔 sandbox 처럼 real 숨김. */
    const ws = useWorkspaceStore.getState();
    const prev = {
      sites: ws.sites,
      projects: ws.projects,
      activeSiteId: ws.activeSiteId,
      activeProjectId: ws.activeProjectId,
    };
    const asisPrev = useAsisDdlStore.getState().schemasByProject;
    const tobePrev = useTobeDdlStore.getState().schemasByProject;
    /* demo 동안엔 real 숨기고 demo 만 노출. */
    useWorkspaceStore.setState({
      sites: [DEMO_SITE],
      projects: [DEMO_PROJECT],
      activeSiteId: DEMO_SITE_ID,
      activeProjectId: DEMO_PROJECT_ID,
    });
    useAsisDdlStore.setState({ schemasByProject: { [DEMO_PROJECT_ID]: DEMO_ASIS_SCHEMA } });
    useTobeDdlStore.setState({ schemasByProject: { [DEMO_PROJECT_ID]: DEMO_TOBE_SCHEMA } });
    return () => {
      useWorkspaceStore.setState(prev);
      useAsisDdlStore.setState({ schemasByProject: asisPrev });
      useTobeDdlStore.setState({ schemasByProject: tobePrev });
    };
  }, [isDemo]);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const loadUsers = useUsersStore((s) => s.loadUsers);
  const resetUsers = useUsersStore((s) => s.reset);
  const allLogs = useAuditLogStore((s) => s.logs);
  const globalNotifEnabled = useSettingsStore((s) => s.notifications);
  const globalNotifScope   = useSettingsStore((s) => s.notificationScope);
  const notifPrefSubs   = useNotificationPrefsStore((s) => s.subs);
  const notifReadIdsByUser = useNotificationStore((s) => s.readIds);
  const notifDismissedIdsByUser = useNotificationStore((s) => s.dismissedIds);
  const markAllNotifRead = useNotificationStore((s) => s.markAllRead);
  const clearAllNotifs = useNotificationStore((s) => s.clearAll);
  // 현재 사용자에 해당하는 ID 만 추출. user.username 이 없으면 (비로그인 상태) 빈 배열.
  const notifReadIds = useMemo(
    () => (user?.username ? (notifReadIdsByUser[user.username] ?? []) : []),
    [notifReadIdsByUser, user?.username],
  );
  const notifDismissedIds = useMemo(
    () => (user?.username ? (notifDismissedIdsByUser[user.username] ?? []) : []),
    [notifDismissedIdsByUser, user?.username],
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [userOpen, setUserOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [solutionOpen, setSolutionOpen] = useState(false);
  const [createSiteOpen, setCreateSiteOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [clusterAdminOpen, setClusterAdminOpen] = useState(false);
  const [siteSettingsOpen, setSiteSettingsOpen] = useState(false);
  const [siteSettingsFocus, setSiteSettingsFocus] = useState<import('../store/ui').SiteSettingsFocus>(undefined);
  const [siteMenuOpen, setSiteMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifTab, setNotifTab] = useState<'all' | 'unread'>('all');
  const [signOutOpen, setSignOutOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);
  const siteRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  /* Workspace state — 원시 상태만 구독하고 derived 는 useMemo (re-render 무한 루프 방지) */
  const sites = useWorkspaceStore((s) => s.sites);
  const allProjects = useWorkspaceStore((s) => s.projects);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const setActiveSite = useWorkspaceStore((s) => s.setActiveSite);
  const fetchSites = useWorkspaceStore((s) => s.fetchSites);
  const fetchProjects = useWorkspaceStore((s) => s.fetchProjects);

  // 외부 페이지(MappingPage 등)에서 site settings 모달 open 요청 감지
  const siteSettingsRequest = useUiStore((s) => s.siteSettingsRequest);
  useEffect(() => {
    if (!siteSettingsRequest) return;
    setSiteSettingsFocus(siteSettingsRequest.focus);
    setSiteSettingsOpen(true);
    useUiStore.getState().consumeSiteSettingsRequest();
  }, [siteSettingsRequest]);

  // 모달이 열려있으면 polling 일시 중지 (편집 중 서버 데이터로 덮어쓰기 방지)
  const isEditing = siteSettingsOpen || createSiteOpen || createProjectOpen;
  const isEditingRef = useRef(isEditing);
  isEditingRef.current = isEditing;

  const fetchSnapshots = useSnapshotsStore((s) => s.fetchBySite);

  // 사이드바 project row 옆에 pending snapshot 모래시계 — Versions 에서 Request Review 한 직후 표시.
  const allSnapshots = useSnapshotsStore((s) => s.snapshots);
  const pendingProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of allSnapshots) {
      if (s.status === 'pending') ids.add(s.projectId);
    }
    return ids;
  }, [allSnapshots]);

  // navigate 시 location.state.activateProjectId 로 전달된 값을 setActiveProject 에 반영.
  // 알림 클릭처럼 라우트 전환 + 프로젝트 변경을 한 번에 해야 하는 경우, 핸들러에서 setActiveProject 를
  // 직접 호출하면 떠나는 사이트-레벨 페이지가 한 번 더 render 되며 redirect race 가 발생.
  //
  // useLayoutEffect 를 쓰는 이유: useEffect 면 destination 페이지(예: ApprovalsPage)의 redirect useEffect
  // 가 같은 phase 에 같이 발사되는데, child → parent 순서라서 destination redirect 가 먼저 발사돼서
  // navigate('/', { replace }) 로 destination 을 덮어쓰는 race 가 또 생김.
  // useLayoutEffect 는 useEffect 보다 먼저 발사 + 내부 state update 가 동기적으로 추가 commit 을 일으켜서
  // destination 의 useEffect 가 발사되기 전에 activeProjectId 가 정정됨.
  useLayoutEffect(() => {
    const st = location.state as { activateProjectId?: string | null } | null;
    if (!st || !('activateProjectId' in st)) return;
    setActiveProject(st.activateProjectId ?? null);
  }, [location.key, setActiveProject]);

  // 10초 간격으로 서버 동기화 (sites → projects → snapshots → audit logs 순서 보장).
  // demo 중엔 polling 전체 skip — 백업한 real data 를 서버 응답으로 덮어쓰지 않도록.
  const isDemoRef = useRef(isDemo);
  isDemoRef.current = isDemo;
  useEffect(() => {
    const sync = async () => {
      if (isDemoRef.current) return;
      if (isEditingRef.current) return;
      await fetchSites();
      const siteId = useWorkspaceStore.getState().activeSiteId;
      if (siteId) {
        await fetchProjects(siteId);
        await fetchSnapshots(siteId);
        await useAuditLogStore.getState().fetchBySite(siteId);
      }
    };
    void sync();
    const id = setInterval(() => void sync(), 10_000);
    return () => clearInterval(id);
  }, [fetchSites, fetchProjects, fetchSnapshots]);

  const activeSite = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);
  const activeProject = useMemo(() => allProjects.find((p) => p.id === activeProjectId) ?? null, [allProjects, activeProjectId]);
  const activeProjectReadOnly = isProjectReadOnly(activeProject, user);

  const siteDbConfigured = (s: typeof sites[number]) => {
    const db = s.tobeDbByEnv?.[s.environment] as Partial<{ type: string; host: string; database: string; username: string }> | undefined;
    return !!db
      && !!db.type?.trim()
      && !!db.host?.trim()
      && !!db.database?.trim()
      && !!db.username?.trim();
  };

  const STAGE_SHORT: Record<string, string> = {
    dev: 'DEV',
    test: 'TEST',
    staging: 'STG',
    production: 'PROD',
  };
  const stageShort = (env: string) => STAGE_SHORT[env] ?? env.slice(0, 4).toUpperCase();

  // site 의 raw DB type 을 짧은 라벨로. 알 수 없으면 빈 문자열.
  const dialectLabel = (raw: string | null | undefined): string => {
    if (!raw) return '';
    const s = raw.trim().toLowerCase();
    if (!s) return '';
    if (s.includes('postgres')) return 'PostgreSQL';
    if (s.includes('sql server') || s === 'mssql' || s.includes('microsoft')) return 'SQL Server';
    if (s.includes('mysql') || s.includes('mariadb')) return 'MySQL';
    if (s.includes('db2')) return 'DB2';
    if (s.includes('oracle')) return 'Oracle';
    return raw.trim();
  };
  const siteDialects = (s: typeof sites[number]) => {
    const tobeRaw = (s.tobeDbByEnv?.[s.environment] as { type?: string } | undefined)?.type;
    return { asis: dialectLabel(s.asisDbType), tobe: dialectLabel(tobeRaw) };
  };

  const projectSort = useSettingsStore((s) => s.projectSort);
  const setProjectSort = useSettingsStore((s) => s.setProjectSort);
  const [projectSearch, setProjectSearch] = useState('');
  const projects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    const list = allProjects
      .filter((p) => p.siteId === activeSiteId)
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .slice();
    list.sort((a, b) => {
      switch (projectSort) {
        case 'created-asc':  return a.createdAt.localeCompare(b.createdAt);
        case 'created-desc': return b.createdAt.localeCompare(a.createdAt);
        case 'name-asc':     return a.name.localeCompare(b.name);
        case 'name-desc':    return b.name.localeCompare(a.name);
        case 'tables-desc':  return b.tableCount - a.tableCount;
        default:             return 0;
      }
    });
    return list;
  }, [allProjects, activeSiteId, projectSort, projectSearch]);

  const notifItems = useMemo(() => {
    // Solution settings 에서 Enable notifications 가 OFF 면 모든 프로젝트의 알림 일괄 비활성.
    if (!globalNotifEnabled) return [];
    const siteProjs = allProjects.filter((p) => p.siteId === activeSiteId);
    const projMap = new Map(siteProjs.map((p) => [p.id, p.name]));
    const projIds = new Set(siteProjs.map((p) => p.id));
    const currentUserName = user?.username;
    // 알림은 audit log 만을 source of truth 로 사용.
    // Project Settings > Notifications 의 Event subscriptions / Scope 가 여기서 필터로 적용됨.
    return allLogs
      .filter((l) => projIds.has(l.projectId))
      .filter((l) => {
        // Event subscription: action → event key 매핑이 존재하면 OFF 시 제외.
        const eventKey = actionToEventKey(l.action);
        if (eventKey && !isEventEnabled(notifPrefSubs, l.projectId, eventKey)) return false;
        // Scope (글로벌): 'mine-only' 면 본인이 한 action 만.
        if (globalNotifScope === 'mine-only' && currentUserName && l.user !== currentUserName) return false;
        return true;
      })
      .slice(0, 50)
      .map((l) => {
        const a = l.action.toLowerCase();
        const type =
          a.includes('approval') || a.includes('request') ? 'pending'
          : a.includes('snapshot') ? 'snapshot'
          : a.includes('approved') ? 'approved'
          : a.includes('rejected') ? 'rejected'
          : a.includes('run') ? 'run-start'
          : 'info';
        const isCutover = l.snapshotType === 'cutover'
          || a.includes('cutover');
        const baseTitle = l.action.replace(/\b\w/g, (c) => c.toUpperCase());
        const title = l.snapshotName ? `${baseTitle} · ${l.snapshotName}` : baseTitle;
        return {
          id: `audit-${l.id}`,
          type,
          title,
          description: l.description.split('\n')[0],
          projectName: projMap.get(l.projectId) ?? '—',
          projectId: l.projectId,
          snapshotId: l.snapshotId,
          isCutover,
          timestamp: l.timestamp,
        };
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [allLogs, allProjects, activeSiteId, notifPrefSubs, globalNotifScope, user?.username, globalNotifEnabled]);

  const visibleNotifs = useMemo(
    () => notifItems.filter((n) => !notifDismissedIds.includes(n.id)),
    [notifItems, notifDismissedIds],
  );
  const unreadNotifs = useMemo(
    () => visibleNotifs.filter((n) => !notifReadIds.includes(n.id)),
    [visibleNotifs, notifReadIds],
  );
  const displayedNotifs = useMemo(
    () => (notifTab === 'unread' ? unreadNotifs : visibleNotifs),
    [notifTab, visibleNotifs, unreadNotifs],
  );

  useEffect(() => {
    if (!userOpen) return;
    const close = (e: MouseEvent) => {
      if (!userRef.current?.contains(e.target as Node)) setUserOpen(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [userOpen]);

  useEffect(() => {
    if (!siteMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (!siteRef.current?.contains(e.target as Node)) setSiteMenuOpen(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [siteMenuOpen]);

  useEffect(() => {
    if (!notifOpen) return;
    const close = (e: MouseEvent) => {
      if (!notifRef.current?.contains(e.target as Node)) setNotifOpen(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [notifOpen]);

  const handleLogout = async () => {
    // first-wins 정책: server-side 세션도 무효화해야 다음 로그인이 허용됨.
    // 네트워크 실패/토큰 만료 등은 swallow — 클라이언트 정리는 그래도 진행.
    try { await authApi.logout(); } catch { /* noop */ }
    logout();
    resetUsers();
    navigate('/login');
  };

  // master 로 로그인 했을 때 사용자 목록 자동 fetch (배정 dropdown 등에서 사용).
  useEffect(() => {
    if (user?.role === 'master') {
      void loadUsers();
    }
  }, [user?.role, user?.username, loadUsers]);

  // 라이선스 상태 — 마운트 시 + 30분마다 polling. banner / write 차단 hint 용.
  const refreshLicense = useLicenseStore((s) => s.refresh);
  useEffect(() => {
    void refreshLicense();
    const id = setInterval(() => void refreshLicense(), 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [refreshLicense]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <LicenseBanner />
      <div style={styles.wrap}>
      {sidebarOpen && (
        <aside style={styles.sidebar}>
          {/* 브랜드 */}
          <div style={styles.brandRow}>
            <img src="/mpd.png" alt="" width={18} height={18} style={{ display: 'block', flexShrink: 0 }} />
            <div style={styles.brand}><BrandName /></div>
          </div>

          {/* 사이트 selector */}
          <div ref={siteRef} style={{ position: 'relative' }}>
            {activeSite ? (
              <div
                style={{ ...styles.siteRow, ...(siteMenuOpen ? styles.siteRowOpen : {}) }}
                onClick={(e) => { e.stopPropagation(); setSiteMenuOpen((o) => !o); }}
              >
                <div style={styles.siteBadge}>{siteBadge(activeSite.name)}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={styles.siteNameRow}>
                    <span style={styles.siteName}>{activeSite.name}</span>
                    <span
                      style={siteDbConfigured(activeSite) ? styles.siteStageChip : styles.siteStageChipOff}
                      title={siteDbConfigured(activeSite) ? t('shell.site.dbConfigured') : t('shell.site.dbNotConfigured')}
                    >
                      {stageShort(activeSite.environment)}
                    </span>
                  </div>
                  <div style={styles.siteSub}>{activeSite.asisEnv} → {activeSite.tobeEnv} · {sites.length} {sites.length === 1 ? t('shell.siteCountSuffix') : t('shell.siteCountSuffixPlural')}</div>
                </div>
                <span style={{ ...styles.siteChevron, transform: siteMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>▼</span>
              </div>
            ) : (
              <div style={styles.siteRowEmpty} onClick={() => setCreateSiteOpen(true)}>
                <div style={styles.siteBadgeEmpty}>+</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={styles.siteNameEmpty}>{t('shell.siteEmpty.name')}</div>
                  <div style={styles.siteSubEmpty}>{t('shell.siteEmpty.sub')}</div>
                </div>
              </div>
            )}

            {/* 사이트 드롭다운 메뉴 */}
            {siteMenuOpen && activeSite && (
              <div style={styles.siteMenu} onClick={(e) => e.stopPropagation()}>
                <div style={styles.siteMenuHeader}>{t('shell.sites')}</div>
                {sites.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => { setActiveSite(s.id); setSiteMenuOpen(false); }}
                    style={{
                      ...styles.siteMenuItem,
                      ...(s.id === activeSite.id ? styles.siteMenuItemActive : {}),
                    }}
                  >
                    <div style={styles.siteMenuItemBadge}>{siteBadge(s.name)}</div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={styles.siteMenuItemNameRow}>
                        <span style={styles.siteMenuItemName}>{s.name}</span>
                        <span
                          style={siteDbConfigured(s) ? styles.siteStageChip : styles.siteStageChipOff}
                          title={siteDbConfigured(s) ? t('shell.site.dbConfigured') : t('shell.site.dbNotConfigured')}
                        >
                          {stageShort(s.environment)}
                        </span>
                      </div>
                      <div style={styles.siteMenuItemSub}>{s.asisEnv} → {s.tobeEnv}</div>
                    </div>
                    {s.id === activeSite.id && <span style={styles.siteMenuCheck}>✓</span>}
                  </button>
                ))}
                <div style={styles.siteMenuDivider} />
                <button
                  onClick={() => { setSiteMenuOpen(false); setCreateSiteOpen(true); }}
                  style={{ ...styles.siteMenuAction, color: 'var(--navy)' }}
                >
                  <span style={{ ...styles.siteMenuActionIcon, color: 'var(--navy)' }}>+</span>
                  {t('shell.menu.newSite')}
                </button>
                <button
                  onClick={() => { setSiteMenuOpen(false); setSiteSettingsOpen(true); }}
                  style={styles.siteMenuAction}
                >
                  <span style={styles.siteMenuActionIcon}>
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="7" cy="7" r="2.2" />
                      <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.5 2.5l1.1 1.1M10.4 10.4l1.1 1.1M2.5 11.5l1.1-1.1M10.4 3.6l1.1-1.1" />
                    </svg>
                  </span>
                  {t('shell.menu.siteSettings')}
                </button>
              </div>
            )}
          </div>

          {/* Search */}
          <div style={styles.searchWrap}>
            <span style={styles.searchIcon}>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="var(--navy)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="6" r="4.2" />
                <line x1="9.2" y1="9.2" x2="12" y2="12" />
              </svg>
            </span>
            <input
              style={styles.searchInput}
              placeholder={t('shell.searchPlaceholder')}
              value={projectSearch}
              onChange={(e) => setProjectSearch(e.target.value)}
            />
            {projectSearch && (
              <button
                type="button"
                onClick={() => setProjectSearch('')}
                style={styles.searchClear}
                aria-label="Clear search"
                title="Clear"
              >
                ×
              </button>
            )}
          </div>

          {/* All projects */}
          <div style={{ ...styles.allProjects, ...(activeProjectId === null && activeSiteId ? styles.allProjectsActive : {}) }} onClick={() => { setActiveProject(null); navigate('/'); }}>
            <div style={styles.allProjectsIcon}>
              <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
                <rect x="0" y="0" width="4" height="4" />
                <rect x="6" y="0" width="4" height="4" />
                <rect x="0" y="6" width="4" height="4" />
                <rect x="6" y="6" width="4" height="4" />
              </svg>
            </div>
            <span style={styles.allProjectsLabel}>{t('shell.allProjects')}</span>
            <div style={{ flex: 1 }} />
            <span style={styles.countMono}>{projects.length}</span>
          </div>

          {/* Projects section */}
          <div style={styles.sectionHeader}>
            <span>{t('shell.projects')} <span style={styles.muted}>{projects.length}</span></span>
            <div style={{ flex: 1 }} />
            <select
              value={projectSort}
              onChange={(e) => setProjectSort(e.target.value as ProjectSort)}
              title={t('shell.projects.sortTitle')}
              style={styles.sortSelect}
            >
              <option value="created-asc">{t('shell.projects.sort.createdAsc')}</option>
              <option value="created-desc">{t('shell.projects.sort.createdDesc')}</option>
              <option value="name-asc">{t('shell.projects.sort.nameAsc')}</option>
              <option value="name-desc">{t('shell.projects.sort.nameDesc')}</option>
              <option value="tables-desc">{t('shell.projects.sort.tables')}</option>
            </select>
            <button
              title={activeSite ? t('shell.newProject.title') : t('shell.newProject.noSite')}
              onClick={() => activeSite && setCreateProjectOpen(true)}
              disabled={!activeSite}
              style={{ ...styles.iconBtn, opacity: activeSite ? 1 : 0.4 }}
            >+</button>
          </div>

          <div style={styles.projectList}>
            {projects.length === 0 ? (
              <div style={styles.emptyState}>
                {projectSearch.trim()
                  ? t('shell.searchEmpty', { q: projectSearch.trim() })
                  : activeSite
                  ? <>{t('shell.projectsEmpty.withSite.before')}<code style={styles.kbd}>+</code>{t('shell.projectsEmpty.withSite.after')}</>
                  : <>{t('shell.projectsEmpty.noSite')}</>}
              </div>
            ) : (
              projects.map((p) => {
                const readOnly = isProjectReadOnly(p, user);
                return (
                  <div
                    key={p.id}
                    onClick={() => {
                      setActiveProject(p.id);
                      // 사이트-레벨 페이지에 있을 때만 project 페이지로 이동 — project-level 페이지면 그대로 두고 프로젝트만 전환.
                      if (location.pathname.startsWith('/site/')) {
                        navigate('/', { replace: true });
                      }
                    }}
                    style={{
                      ...styles.projectRow,
                      ...(activeProject?.id === p.id ? styles.projectRowActive : {}),
                      ...(readOnly ? styles.projectRowReadOnly : {}),
                    }}
                    title={readOnly ? t('shell.readOnly.projectTooltip') : undefined}
                  >
                    <div style={styles.projectNameRow}>
                      <span style={styles.projectName}>{p.name}</span>
                      {pendingProjectIds.has(p.id) && p.phase === 'test' && p.runStatus === 'completed' && (
                        <span
                          style={styles.projectPendingIcon}
                          title={t('siteOverview.pendingSnapshotIcon.title')}
                          aria-label={t('siteOverview.pendingSnapshotIcon.title')}
                        >
                          <HourglassHalfIcon size={11} color="var(--amber)" />
                        </span>
                      )}
                      {readOnly && (
                        <span style={styles.projectReadOnlyIcon} aria-label={t('shell.readOnly.projectTooltip')}>
                          <LockIcon open={false} color="var(--amber)" size={11} />
                        </span>
                      )}
                    </div>
                    <div style={styles.projectMeta}>
                      {(() => {
                        const c = phaseColors(p.phase, p.runStatus);
                        return (
                          <span style={{ ...styles.phaseBadge, background: c.bg, color: c.color, borderColor: c.border }}>
                            {p.phase}
                          </span>
                        );
                      })()}
                      <span style={styles.projectMetaDim}>{p.tableCount} tables</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* 사용자 메뉴 (하단) */}
          <div ref={userRef} style={styles.userArea}>
            {userOpen && (
              <div style={styles.userMenu}>
                <div style={styles.userMenuHeader}>
                  <div style={styles.userMenuName}>{user?.username}</div>
                  <div style={styles.userMenuSub}>{roleLabel(user?.role)}</div>
                </div>
                <MenuItem
                  icon={<IconProfile />}
                  label={t('menu.accountProfile')}
                  onClick={() => { setUserOpen(false); setProfileOpen(true); }}
                />
                {(user?.role === 'master' || user?.role === 'admin') && (
                  <MenuItem
                    icon={<IconGear />}
                    label={t('menu.solutionSettings')}
                    onClick={() => { setUserOpen(false); setSolutionOpen(true); }}
                  />
                )}
                {user?.role === 'master' && (
                  <MenuItem
                    icon={<IconUsers />}
                    label={t('menu.clusterAdmin')}
                    onClick={() => { setUserOpen(false); setClusterAdminOpen(true); }}
                  />
                )}
                <div style={styles.userMenuDivider} />
                <MenuItem
                  icon={<IconHelp />}
                  label={t('menu.help')}
                  onClick={() => { setUserOpen(false); setHelpOpen(true); }}
                />
                <MenuItem
                  icon={<IconAbout />}
                  label={<>{t('menu.about')} <BrandName /></>}
                  onClick={() => { setUserOpen(false); setAboutOpen(true); }}
                />
                <div style={styles.userMenuDivider} />
                <MenuItem
                  icon={<IconSignout />}
                  label={t('menu.signout')}
                  onClick={() => { setUserOpen(false); setSignOutOpen(true); }}
                />
              </div>
            )}
            <div
              onClick={(e) => { e.stopPropagation(); setUserOpen((o) => !o); }}
              style={{ ...styles.userRow, ...(userOpen ? styles.userRowActive : {}) }}
            >
              <div style={styles.avatar}>{user?.username?.[0]?.toUpperCase() ?? '?'}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={styles.userName}>{user?.username}</div>
                <div style={styles.userSub}>KS Info System</div>
              </div>
              <span style={styles.userChevron}>▾</span>
            </div>
          </div>
        </aside>
      )}

      <main style={styles.main}>
        {/* 탑바 */}
        <div style={styles.topbar}>
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            style={styles.collapseBtn}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="1.5" y="1.5" width="11" height="11" rx="1" />
              <line x1="5.5" y1="1.5" x2="5.5" y2="12.5" />
            </svg>
          </button>

          <div style={styles.topTitle}>
            {activeProject ? (
              <>
                <div style={styles.topTitleMain}>
                  {activeProject.name}
                  {(() => {
                    const c = phaseColors(activeProject.phase, activeProject.runStatus);
                    return (
                      <span style={{ ...styles.phaseBadgeTop, background: c.bg, color: c.color, borderColor: c.border }}>
                        {activeProject.phase}
                      </span>
                    );
                  })()}
                </div>
                <div style={styles.topTitleSub}>
                  {activeSite && (() => {
                    const d = siteDialects(activeSite);
                    if (!d.asis && !d.tobe) return null;
                    return (
                      <span style={styles.topDialectChip} title={`AS-IS: ${d.asis || '?'}  →  TO-BE: ${d.tobe || '?'}`}>
                        <span style={styles.topDialectName}>{d.asis || '?'}</span>
                        <span style={styles.topDialectArrow}>→</span>
                        <span style={styles.topDialectName}>{d.tobe || '?'}</span>
                      </span>
                    );
                  })()}
                  <span style={styles.topDialectSep}>·</span>
                  <span>{activeProject.tableCount} tables</span>
                </div>
              </>
            ) : activeSite ? (
              <div style={styles.topTitleMain}>{t('shell.allProjects')}</div>
            ) : (
              <>
                <div style={styles.topTitleMain}><BrandName /></div>
                <div style={styles.topTitleSub}>
                  {t('shell.top.noSite')}
                </div>
              </>
            )}
          </div>

          <div style={{ flex: 1 }} />

          {/* 알림 bell + popover */}
          <div ref={notifRef} style={{ position: 'relative' }}>
            <button
              title={t('notifications.title')}
              onClick={(e) => { e.stopPropagation(); setNotifOpen((o) => !o); }}
              style={{ ...styles.bellBtn, ...(notifOpen ? styles.bellBtnActive : {}) }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M8 1.5a4 4 0 0 0-4 4v3l-1.5 2.5h11L12 8V5.5a4 4 0 0 0-4-4z" />
                <path d="M6.5 12.5a1.5 1.5 0 0 0 3 0" />
              </svg>
              {unreadNotifs.length > 0 && (
                <span style={styles.bellBadge}>{unreadNotifs.length}</span>
              )}
            </button>
            {notifOpen && (
              <div style={styles.notifPanel} onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div style={styles.notifHeader}>
                  <div>
                    <div style={styles.notifHeaderTitle}>{t('notifications.title')}</div>
                    <div style={styles.notifHeaderSub}>{visibleNotifs.length} total · {unreadNotifs.length} unread</div>
                  </div>
                  <div style={styles.notifTabs}>
                    <button
                      onClick={() => setNotifTab('all')}
                      style={{ ...styles.notifTabBtn, ...(notifTab === 'all' ? styles.notifTabActive : {}) }}
                    >All</button>
                    <button
                      onClick={() => setNotifTab('unread')}
                      style={{ ...styles.notifTabBtn, ...(notifTab === 'unread' ? styles.notifTabActive : {}) }}
                    >Unread</button>
                  </div>
                </div>
                {/* Items */}
                {displayedNotifs.length === 0 ? (
                  <div style={styles.notifEmpty}>
                    <div style={styles.notifEmptyIcon}>
                      <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                        <path d="M8 1.5a4 4 0 0 0-4 4v3l-1.5 2.5h11L12 8V5.5a4 4 0 0 0-4-4z" />
                        <path d="M6.5 12.5a1.5 1.5 0 0 0 3 0" />
                      </svg>
                    </div>
                    <div style={styles.notifEmptyTitle}>
                      {notifTab === 'unread' ? t('notifications.empty.unread') : t('notifications.empty.title')}
                    </div>
                  </div>
                ) : (
                  <div style={styles.notifList}>
                    {displayedNotifs.map((item) => {
                      const isRead = notifReadIds.includes(item.id);
                      const color = notifTypeColor(item.type);
                      return (
                        <div
                          key={item.id}
                          style={{
                            ...styles.notifItem,
                            borderLeft: `3px solid ${color}`,
                            background: isRead ? 'transparent' : 'var(--navy-50)',
                          }}
                          onClick={() => {
                            if (user?.username) markAllNotifRead(user.username, [item.id]);
                            setNotifOpen(false);
                            // 라우트 전환 중 activeProjectId 가 바뀌면 떠나는 사이트-레벨 페이지의 redirect useEffect 가
                            // 발사돼서 destination 을 / 로 덮어쓰는 race 가 있음. 그래서 setActiveProject 는 여기서
                            // 직접 호출하지 않고 location.state.activateProjectId 로 destination 에 위임.
                            if (item.type === 'pending') {
                              navigate('/site/approvals', { state: { activateProjectId: null } });
                              return;
                            }
                            if (item.type === 'run-start' && item.projectId) {
                              navigate('/execution', { state: { activateProjectId: item.projectId } });
                              return;
                            }
                            if (item.projectId) {
                              navigate('/versions', {
                                state: {
                                  activateProjectId: item.projectId,
                                  selectSnapshotId: item.snapshotId ?? null,
                                },
                              });
                            } else {
                              navigate('/', { state: { activateProjectId: null } });
                            }
                          }}
                        >
                          <div style={styles.notifItemTop}>
                            <span style={styles.notifItemTitle}>{item.title}</span>
                            <span style={styles.notifItemDate}>{formatNotifDate(item.timestamp)}</span>
                          </div>
                          <div style={styles.notifItemDesc}>{item.description}</div>
                          <div style={styles.notifItemTags}>
                            <span style={styles.notifProjBadge}>{item.projectName}</span>
                            <span style={{ ...styles.notifTypeBadge, color, borderColor: color }}>
                              {item.type}
                            </span>
                            {item.isCutover && (
                              <span style={styles.notifCutoverBadge}>Cutover snapshot</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Footer */}
                {visibleNotifs.length > 0 && (
                  <div style={styles.notifFooterRow}>
                    <button
                      style={styles.notifFooterBtn}
                      onClick={() => { if (user?.username) markAllNotifRead(user.username, visibleNotifs.map((n) => n.id)); }}
                    >Mark all read</button>
                    <button
                      style={styles.notifFooterBtnRight}
                      onClick={() => { if (user?.username) clearAllNotifs(user.username, visibleNotifs.map((n) => n.id)); }}
                    >Clear all</button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* AS-IS / TO-BE 인포트 상태 램프 — 클릭하면 Settings 의 해당 섹션 + amber pulse. */}
          {activeProject && (
            <>
              <button
                title={activeProject.tableCount > 0 ? t('shell.lamp.asis.imported') : t('shell.lamp.asis.notImported')}
                onClick={() => navigate('/settings', { state: { highlightSide: 'asis' } })}
                style={styles.statusPill}
              >
                <span style={{
                  ...styles.dot,
                  background: activeProject.tableCount > 0 ? 'var(--green)' : 'var(--red)',
                }} />
                <span>AS-IS</span>
              </button>
              <button
                title={activeProject.tobeTableCount > 0 ? t('shell.lamp.tobe.imported') : t('shell.lamp.tobe.notImported')}
                onClick={() => navigate('/settings', { state: { highlightSide: 'tobe' } })}
                style={styles.statusPill}
              >
                <span style={{
                  ...styles.dot,
                  background: activeProject.tobeTableCount > 0 ? 'var(--green)' : 'var(--red)',
                }} />
                <span>TO-BE</span>
              </button>
            </>
          )}
        </div>

        {/* 탭바 — 사이트만 있고 프로젝트 없을 땐 site tab, 프로젝트 활성 시 project tab */}
        {activeSite && activeProject && (
          <div style={styles.tabbar}>
            <Tab to="/" end label={t('tab.dashboard')} />
            <Tab to="/mapping" label={t('tab.mapping')} />
            <Tab to="/versions" label={t('tab.versions')} />
            <Tab to="/execution" label={t('tab.execution')} />
            <Tab to="/artifacts" label={t('tab.artifacts')} />
            <Tab to="/logs" label={t('tab.logs')} />
            <Tab to="/settings" label={t('tab.settings')} />
          </div>
        )}
        {activeSite && !activeProject && projects.length > 0 && (
          <div style={styles.tabbar}>
            <Tab to="/" end label={t('tab.siteOverview')} />
            <Tab to="/site/execution" label={t('tab.executionOverview')} />
            <Tab to="/site/quarantine" label={t('tab.siteQuarantine')} />
            <Tab to="/site/approvals" label={t('tab.approvals')} />
            <Tab to="/site/export" label={t('tab.siteExport')} />
            <Tab to="/site/audit" label={t('tab.auditLog')} />
            {user?.role === 'master' && (
              <Tab to="/site/scheduler" label={t('tab.scheduler')} />
            )}
          </div>
        )}

        {activeProject && activeProjectReadOnly && (
          <div style={styles.readOnlyBanner} role="status" aria-live="polite">
            <LockIcon open={false} color="var(--amber)" size={13} />
            <span style={styles.readOnlyBannerText}>
              {activeProject.assignee
                ? t('shell.readOnly.banner', { assignee: activeProject.assignee })
                : t('shell.readOnly.bannerUnassigned')}
            </span>
          </div>
        )}

        <div style={styles.content}>
          <Outlet />
        </div>
      </main>

      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <AccountProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      <SolutionSettingsModal open={solutionOpen} onClose={() => setSolutionOpen(false)} />
      <SiteSettingsModal open={siteSettingsOpen} onClose={() => setSiteSettingsOpen(false)} highlight={siteSettingsHighlight} />
      <ClusterAdminModal open={clusterAdminOpen} onClose={() => setClusterAdminOpen(false)} />
      <CreateSiteModal open={createSiteOpen} onClose={() => setCreateSiteOpen(false)} />
      <CreateProjectModal open={createProjectOpen} onClose={() => setCreateProjectOpen(false)} />
      <SignOutModal
        open={signOutOpen}
        onCancel={() => setSignOutOpen(false)}
        onConfirm={() => { setSignOutOpen(false); handleLogout(); }}
      />
      <NotificationToast />
      </div>
    </div>
  );
}

function notifTypeColor(type: string): string {
  switch (type) {
    case 'pending':       return 'var(--amber)';            // 황토색
    case 'snapshot':      return 'var(--snapshot)';         // royal blue — snapshot 전용 (phase-analysis 와 구분)
    case 'approved':      return 'var(--green)';            // 상세 페이지 approved 배지와 동일
    case 'rejected':      return 'var(--red)';
    case 'run-start':     return 'var(--gray)';
    case 'quarantine':    return 'var(--amber)';
    case 'conn-failed':   return 'var(--red)';
    default:              return 'var(--text-4)';
  }
}

function formatNotifDate(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day} ${h}:${m}`;
}

/** 사이트 이름을 2-3 자 모노그램으로 — 예: "KS Info System" → "KIS" */
function siteBadge(name: string): string {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase() || '?';
}

/** phase 별 의미색 (badge bg / border / text). 사이드바·탑바 phase badge 공통.
 *  test/rehearsal/cutover 는 running 중에만 고유색 — paused/completed/failed/aborted/idle 은 모두 흰색.
 *  그 외 phase (planning/analysis/sign-off/ready/hypercare/done) 는 항상 고유색. */
function phaseColors(phase: string, runStatus?: string): { bg: string; color: string; border: string } {
  const activePhase = phase === 'test' || phase === 'rehearsal' || phase === 'cutover';
  if (activePhase && runStatus !== 'running') {
    return {
      bg:     'var(--panel)',
      color:  'var(--text)',
      border: 'var(--border-strong)',
    };
  }
  const map: Record<string, string> = {
    'planning':  'planning',
    'analysis':  'analysis',
    'test':      'test',
    'rehearsal': 'rehearsal',
    'sign-off':  'signoff',
    'ready':     'ready',
    'cutover':   'cutover',
    'hypercare': 'hypercare',
    'done':      'done',
  };
  const slug = map[phase] ?? 'done';
  return {
    bg:     `var(--phase-${slug}-50)`,
    color:  `var(--phase-${slug})`,
    border: `var(--phase-${slug})`,
  };
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={styles.userMenuItem}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--panel-2)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={styles.userMenuIcon}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/* ─── Menu icons (inline SVG) ──────────────────────── */
function IconProfile() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#6d4ec2" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="4.5" r="2.5" />
      <path d="M2.5 12.5c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4" />
    </svg>
  );
}
function IconGear() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--navy)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="2.2" />
      <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.5 2.5l1.1 1.1M10.4 10.4l1.1 1.1M2.5 11.5l1.1-1.1M10.4 3.6l1.1-1.1" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--navy)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="4.5" r="2" />
      <path d="M1 12c0-2 1.8-3.5 4-3.5s4 1.5 4 3.5" />
      <circle cx="10.2" cy="5" r="1.6" />
      <path d="M9 11.8c.2-1.6 1.5-2.6 3-2.6 1 0 1.8.4 1.8.4" />
    </svg>
  );
}
function IconHelp() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--text-2)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="5.5" />
      <path d="M5.3 5.3a1.7 1.7 0 0 1 3.4.2c0 1.2-1.7 1.4-1.7 2.5" />
      <circle cx="7" cy="10.3" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconAbout() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--text-2)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 6v4M7 4v.1" />
    </svg>
  );
}
function IconSignout() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--red)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 3V2a1 1 0 0 0-1-1H2.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-1" />
      <path d="M6 7h6.5M10.5 4.5 13 7l-2.5 2.5" />
    </svg>
  );
}

function Tab({ to, end, label }: { to: string; end?: boolean; label: string }) {
  return (
    <NavLink
      to={to}
      end={end}
      style={({ isActive }) => ({
        position: 'relative',
        padding: '0 13px',
        height: '100%',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        cursor: 'pointer',
        color: isActive ? 'var(--navy)' : 'var(--text-2)',
        fontWeight: isActive ? 600 : 500,
        fontSize: 12,
        whiteSpace: 'nowrap',
        textDecoration: 'none',
        transition: 'color .08s',
        boxShadow: isActive ? 'inset 0 -2px 0 var(--navy)' : 'none',
      })}
    >
      {label}
    </NavLink>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    height: '100vh',
    background: 'var(--bg)',
    color: 'var(--text)',
  },

  /* ── Sidebar ─────────────────────────────────── */
  sidebar: {
    width: 270,
    minWidth: 270,
    background: 'var(--panel)',
    borderRight: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  brandRow: {
    height: 38,
    padding: '0 14px',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    borderBottom: '1px solid var(--border)',
  },
  brand: {
    fontWeight: 600,
    fontSize: 13,
    letterSpacing: 0.1,
  },
  siteRow: {
    padding: '8px 12px',
    background: 'var(--panel-2)',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
  },
  siteBadge: {
    width: 22,
    height: 22,
    borderRadius: 3,
    background: 'var(--navy)',
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    fontSize: 9,
    fontFamily: 'var(--mono)',
    fontWeight: 700,
    letterSpacing: 0.4,
    flexShrink: 0,
  },
  siteNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
    lineHeight: 1.2,
  },
  siteName: {
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: '0 1 auto',
    minWidth: 0,
  },
  siteSub: {
    fontSize: 10,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
  },
  siteChevron: { color: 'var(--text-3)', fontSize: 9 },
  siteRowOpen: { background: 'var(--navy-50)' },

  /* 사이트 드롭다운 메뉴 */
  siteMenu: {
    position: 'absolute',
    left: 6,
    right: 6,
    top: '100%',
    marginTop: 2,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    boxShadow: '0 8px 24px rgba(20,30,50,.12)',
    zIndex: 500,
    padding: '4px 0',
  },
  siteMenuHeader: {
    padding: '6px 12px',
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontWeight: 600,
  },
  siteMenuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '6px 10px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
  },
  siteMenuItemActive: { background: 'var(--navy-50)' },
  siteMenuItemBadge: {
    width: 18,
    height: 18,
    borderRadius: 3,
    background: 'var(--navy)',
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    fontSize: 8,
    fontFamily: 'var(--mono)',
    fontWeight: 700,
    letterSpacing: 0.4,
    flexShrink: 0,
  },
  siteMenuItemNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
    lineHeight: 1.2,
  },
  siteMenuItemName: {
    fontSize: 11.5,
    fontWeight: 600,
    color: 'var(--text)',
    lineHeight: 1.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: '0 1 auto',
    minWidth: 0,
  },
  siteMenuItemSub: { fontSize: 9.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  siteMenuCheck: { color: 'var(--navy)', fontSize: 11, marginLeft: 4 },
  siteMenuDivider: { height: 1, margin: '4px 0', background: 'var(--border)' },
  siteMenuAction: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '7px 12px',
    border: 'none',
    background: 'transparent',
    color: 'var(--text)',
    fontSize: 11.5,
    fontWeight: 500,
    cursor: 'pointer',
    textAlign: 'left',
  },
  siteMenuActionIcon: {
    width: 14,
    color: 'var(--text-3)',
    fontSize: 14,
    fontWeight: 700,
    display: 'inline-flex',
    justifyContent: 'center',
  },

  /* 사이트 없을 때 */
  siteRowEmpty: {
    padding: '8px 12px',
    background: 'var(--navy-50)',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    transition: 'background .08s',
  },
  siteBadgeEmpty: {
    width: 22,
    height: 22,
    borderRadius: 3,
    background: 'var(--navy)',
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    fontSize: 14,
    fontWeight: 700,
    flexShrink: 0,
  },
  siteNameEmpty: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--navy)',
  },
  siteSubEmpty: {
    fontSize: 10,
    color: 'var(--navy)',
    opacity: 0.7,
    fontFamily: 'var(--mono)',
  },

  /* 프��젝트 row */
  projectRow: {
    padding: '6px 10px',
    margin: '1px 0',
    borderRadius: 3,
    cursor: 'pointer',
  },
  projectRowReadOnly: {
    opacity: 0.65,
  },
  projectNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
  },
  projectReadOnlyIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  projectPendingIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    // flex 기하 중심 → 텍스트 caps 옵티컬 중심 보정 (1px 위)
    transform: 'translateY(-1px)',
  },
  readOnlyBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 14px',
    background: 'var(--amber-50)',
    borderBottom: '1px solid var(--amber)',
    color: 'var(--amber)',
    fontSize: 11.5,
    fontFamily: 'var(--mono)',
    lineHeight: 1.4,
  },
  readOnlyBannerText: { fontWeight: 600 },
  projectRowActive: {
    background: 'var(--green-50)',
    boxShadow: 'inset 3px 0 0 var(--green)',
  },
  projectName: {
    fontSize: 11.5,
    fontWeight: 500,
    color: 'var(--text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: '0 1 auto',
    minWidth: 0,
  },
  projectMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  projectMetaDim: { fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  phaseBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 64,
    padding: '1px 0',
    fontSize: 9,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    background: 'var(--panel-2)',
    color: 'var(--text-2)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    textAlign: 'center',
    flexShrink: 0,
  },
  phaseBadgeTop: {
    marginLeft: 8,
    padding: '1px 7px',
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },

  searchWrap: {
    padding: '8px 10px',
    borderBottom: '1px solid var(--border)',
    position: 'relative',
  },
  searchIcon: {
    position: 'absolute',
    left: 18,
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  searchClear: {
    position: 'absolute',
    right: 14,
    top: '50%',
    transform: 'translateY(-50%)',
    width: 16,
    height: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
  },
  searchInput: {
    width: '100%',
    height: 24,
    padding: '0 22px 0 24px',
    border: '1px solid var(--border)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 11.5,
    outline: 'none',
  },

  allProjects: {
    padding: '7px 14px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    borderBottom: '1px solid var(--border)',
  },
  allProjectsActive: {
    background: 'var(--green-50)',
    boxShadow: 'inset 3px 0 0 var(--green)',
  },
  allProjectsIcon: {
    width: 18,
    height: 18,
    borderRadius: 3,
    background: 'var(--border-strong)',
    color: 'var(--text-2)',
    display: 'grid',
    placeItems: 'center',
  },
  allProjectsLabel: { fontSize: 11.5, fontWeight: 500, color: 'var(--text)' },
  countMono: { fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-3)' },

  topDialectChip: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    whiteSpace: 'nowrap',
  },
  topDialectName: {
    fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 500,
    color: 'var(--text-4)', letterSpacing: 0.2,
  },
  topDialectArrow: {
    fontSize: 9, color: 'var(--text-4)', fontFamily: 'var(--mono)',
  },

  sectionHeader: {
    padding: '8px 14px 4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    fontWeight: 600,
  },
  muted: { color: 'var(--text-4)' },
  siteStageChip: {
    display: 'inline-block',
    padding: '1px 5px',
    fontSize: 9,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    letterSpacing: 0.4,
    color: 'var(--green)',
    background: 'var(--green-50)',
    border: '1px solid var(--green)',
    borderRadius: 3,
    lineHeight: 1.3,
    flexShrink: 0,
  },
  siteStageChipOff: {
    display: 'inline-block',
    padding: '1px 5px',
    fontSize: 9,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    letterSpacing: 0.4,
    color: 'var(--red)',
    background: 'var(--red-50)',
    border: '1px solid var(--red)',
    borderRadius: 3,
    lineHeight: 1.3,
    flexShrink: 0,
  },
  sortSelect: {
    height: 20,
    padding: '0 4px',
    marginRight: 4,
    border: '1px solid var(--border)',
    borderRadius: 3,
    background: 'var(--panel)',
    color: 'var(--text-2)',
    fontSize: 10,
    fontFamily: 'var(--mono)',
    cursor: 'pointer',
    textTransform: 'none',
    letterSpacing: 0,
    maxWidth: 110,
  },
  iconBtn: {
    width: 18,
    height: 18,
    borderRadius: 3,
    border: '1px solid var(--border)',
    background: 'var(--panel)',
    color: 'var(--text-2)',
    cursor: 'pointer',
    display: 'grid',
    placeItems: 'center',
    fontSize: 12,
    lineHeight: 1,
    padding: 0,
  },

  projectList: { flex: 1, overflow: 'auto', padding: '0 4px 8px' },
  emptyState: {
    padding: '16px 14px',
    fontSize: 11,
    color: 'var(--text-3)',
    lineHeight: 1.55,
  },
  kbd: {
    fontFamily: 'var(--mono)',
    background: 'var(--panel-2)',
    padding: '0 4px',
    borderRadius: 2,
    fontSize: 10,
  },

  /* User area (sidebar bottom) */
  userArea: {
    position: 'relative',
    borderTop: '1px solid var(--border)',
    background: 'var(--panel)',
  },
  userRow: {
    padding: '10px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    cursor: 'pointer',
  },
  userRowActive: { background: 'var(--panel-2)' },
  avatar: {
    width: 26,
    height: 26,
    borderRadius: '50%',
    background: 'var(--navy)',
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
  },
  userName: { fontSize: 12, fontWeight: 600, color: 'var(--text)' },
  userSub: { fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  userRole: {
    fontSize: 9,
    color: 'var(--navy)',
    padding: '1px 5px',
    background: 'var(--navy-50)',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    fontFamily: 'var(--mono)',
    fontWeight: 700,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },

  userMenu: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: '100%',
    marginBottom: 4,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    boxShadow: '0 8px 24px rgba(20,30,50,.12)',
    padding: '4px 0',
    zIndex: 500,
  },
  userMenuHeader: {
    padding: '8px 12px 10px',
    borderBottom: '1px solid var(--border)',
    marginBottom: 4,
  },
  userMenuName: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text)',
    lineHeight: 1.2,
  },
  userMenuSub: {
    fontSize: 10.5,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    marginTop: 2,
  },
  userMenuItem: {
    width: '100%',
    padding: '7px 11px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text)',
    textAlign: 'left',
    fontSize: 12,
    display: 'flex',
    gap: 9,
    alignItems: 'center',
    cursor: 'pointer',
  },
  userMenuIcon: {
    width: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  userMenuDivider: {
    height: 1,
    margin: '3px 0',
    background: 'var(--border)',
  },
  userChevron: {
    color: 'var(--text-3)',
    fontSize: 9,
    marginLeft: 4,
  },

  /* ── Main ───────────────────────────────────── */
  main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },

  topbar: {
    height: 48,
    padding: '0 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel)',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  collapseBtn: {
    width: 26,
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid transparent',
    borderRadius: 4,
    background: 'transparent',
    color: 'var(--text-2)',
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
  },
  topTitle: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  topTitleMain: { fontSize: 13, fontWeight: 600, letterSpacing: -0.1 },
  topTitleSub: {
    fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)',
    display: 'flex', alignItems: 'center', gap: 6,
  },
  topDialectSep: { color: 'var(--text-4)' },

  bellBtn: {
    position: 'relative',
    width: 28,
    height: 28,
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 4,
    color: 'var(--text-2)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  bellBtnActive: {
    background: 'var(--panel-2)',
    borderColor: 'var(--border)',
    color: 'var(--navy)',
  },
  bellBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    background: 'var(--red)',
    color: '#fff',
    fontSize: 9,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 3px',
    lineHeight: 1,
  },
  notifPanel: {
    position: 'absolute',
    right: 0,
    top: '100%',
    marginTop: 6,
    width: 480,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    boxShadow: '0 8px 28px rgba(20,30,50,.14)',
    zIndex: 500,
    overflow: 'hidden',
  },
  notifHeader: {
    padding: '10px 14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel)',
  },
  notifHeaderTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text)',
    lineHeight: 1.2,
  },
  notifHeaderSub: {
    fontSize: 11,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    marginTop: 2,
  },
  notifTabs: {
    display: 'flex',
    border: '1px solid var(--border-strong)',
    borderRadius: 5,
    overflow: 'hidden',
  },
  notifTabBtn: {
    padding: '4px 14px',
    fontSize: 11.5,
    fontWeight: 500,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontFamily: 'var(--sans)',
  },
  notifTabActive: {
    background: 'var(--panel-2)',
    color: 'var(--text)',
    fontWeight: 600,
  },
  notifHeaderActions: { display: 'flex', gap: 4 },
  notifAction: {
    padding: '3px 8px',
    fontSize: 10.5,
    border: '1px solid var(--border-strong)',
    background: 'var(--panel)',
    color: 'var(--text-2)',
    borderRadius: 3,
    cursor: 'pointer',
    fontFamily: 'var(--sans)',
  },
  notifActionDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  notifEmpty: {
    padding: '32px 16px',
    textAlign: 'center',
  },
  notifEmptyIcon: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    background: 'var(--panel-2)',
    color: 'var(--text-4)',
    display: 'inline-grid',
    placeItems: 'center',
    marginBottom: 10,
  },
  notifEmptyTitle: {
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--text-3)',
    marginBottom: 4,
  },
  notifEmptyHint: {
    fontSize: 11,
    color: 'var(--text-4)',
    fontFamily: 'var(--mono)',
    lineHeight: 1.5,
  },
  notifList: { maxHeight: 400, overflow: 'auto' },
  notifItem: {
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
    cursor: 'pointer',
    transition: 'background 0.1s',
  },
  notifItemTop: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 3,
  },
  notifItemTitle: {
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--text)',
    lineHeight: 1.3,
  },
  notifItemDate: {
    fontSize: 10.5,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    lineHeight: 1.6,
  },
  notifItemDesc: {
    fontSize: 11.5,
    color: 'var(--text-2)',
    lineHeight: 1.4,
    marginBottom: 7,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  notifItemTags: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  notifProjBadge: {
    display: 'inline-block',
    padding: '1px 7px',
    background: 'var(--navy)',
    color: '#fff',
    borderRadius: 3,
    fontSize: 10,
    fontWeight: 600,
    fontFamily: 'var(--mono)',
    letterSpacing: 0.2,
  },
  notifTypeBadge: {
    display: 'inline-block',
    padding: '1px 7px',
    fontSize: 10,
    fontWeight: 600,
    fontFamily: 'var(--mono)',
    border: '1px solid',
    borderRadius: 3,
    letterSpacing: 0.2,
  },
  notifCutoverBadge: {
    display: 'inline-block',
    padding: '1px 7px',
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    background: 'var(--red-50, #fef2f2)',
    color: 'var(--red, #dc2626)',
    border: '1px solid var(--red, #dc2626)',
    borderRadius: 3,
    letterSpacing: 0.2,
  },
  notifItemMeta: {
    fontSize: 10.5,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    marginTop: 3,
  },
  notifFooter: {
    padding: '8px 12px',
    fontSize: 11.5,
    fontWeight: 600,
    color: 'var(--navy)',
    textAlign: 'center',
    cursor: 'pointer',
    borderTop: '1px solid var(--border)',
  },
  notifFooterRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 14px',
    borderTop: '1px solid var(--border)',
    background: 'var(--panel)',
  },
  notifFooterBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--navy)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    padding: '2px 0',
    fontFamily: 'var(--sans)',
  },
  notifFooterBtnRight: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    padding: '2px 0',
    fontFamily: 'var(--sans)',
  },
  statusPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 9px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    cursor: 'pointer',
    fontSize: 10.5,
    color: 'var(--text-2)',
    fontFamily: 'var(--mono)',
  },
  dot: { width: 5, height: 5, borderRadius: '50%' },

  tabbar: {
    display: 'flex',
    alignItems: 'stretch',
    padding: '0 12px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel)',
    height: 30,
  },

  content: {
    flex: 1,
    minHeight: 0,
    overflowX: 'auto',
    overflowY: 'auto',
    background: 'var(--bg)',
    padding: 18,
  },
};
