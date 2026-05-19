import { useState, useEffect, useRef, useMemo } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore, roleLabel } from '../store/auth';
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
import { useWorkspaceStore } from '../store/workspace';
import { useSnapshotsStore } from '../store/snapshots';
import { useT } from '../i18n';

/**
 * Prototype 의 메인 셸 (사이드바 + 탑바 + 탭바) 을 그대로 구현.
 * 데이터(프로젝트·사이트·알림)는 아직 없어 placeholder 로 채움.
 */
export function AppShell() {
  const navigate = useNavigate();
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const isMaster = user?.role === 'master';
  const logout = useAuthStore((s) => s.logout);
  const loadUsers = useUsersStore((s) => s.loadUsers);
  const resetUsers = useUsersStore((s) => s.reset);
  const allSnapshots = useSnapshotsStore((s) => s.snapshots);
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
  const [siteMenuOpen, setSiteMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
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

  // 모달이 열려있으면 polling 일시 중지 (편집 중 서버 데이터로 덮어쓰기 방지)
  const isEditing = siteSettingsOpen || createSiteOpen || createProjectOpen;
  const isEditingRef = useRef(isEditing);
  isEditingRef.current = isEditing;

  const fetchSnapshots = useSnapshotsStore((s) => s.fetchBySite);

  // 10초 간격으로 서버 동기화 (sites → projects → snapshots 순서 보장)
  useEffect(() => {
    const sync = async () => {
      if (isEditingRef.current) return;
      await fetchSites();
      const siteId = useWorkspaceStore.getState().activeSiteId;
      if (siteId) {
        await fetchProjects(siteId);
        await fetchSnapshots(siteId);
      }
    };
    void sync();
    const id = setInterval(() => void sync(), 10_000);
    return () => clearInterval(id);
  }, [fetchSites, fetchProjects, fetchSnapshots]);

  const activeSite = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);
  const activeProject = useMemo(() => allProjects.find((p) => p.id === activeProjectId) ?? null, [allProjects, activeProjectId]);
  const projects = useMemo(() => allProjects.filter((p) => p.siteId === activeSiteId), [allProjects, activeSiteId]);

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

  const handleLogout = () => {
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

  return (
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
                  <div style={styles.siteName}>{activeSite.name}</div>
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
                      <div style={styles.siteMenuItemName}>{s.name}</div>
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
            <input style={styles.searchInput} placeholder={t('shell.searchPlaceholder')} />
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
                {activeSite
                  ? <>{t('shell.projectsEmpty.withSite.before')}<code style={styles.kbd}>+</code>{t('shell.projectsEmpty.withSite.after')}</>
                  : <>{t('shell.projectsEmpty.noSite')}</>}
              </div>
            ) : (
              projects.map((p) => (
                <div
                  key={p.id}
                  onClick={() => setActiveProject(p.id)}
                  style={{
                    ...styles.projectRow,
                    ...(activeProject?.id === p.id ? styles.projectRowActive : {}),
                  }}
                >
                  <div style={styles.projectName}>{p.name}</div>
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
              ))
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
                  {activeProject.tableCount} tables
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

          {/* 알림 bell + popover — coordinator 에게 pending snapshot 표시 */}
          {(() => {
            const siteProjectIds = new Set(allProjects.filter((p) => p.siteId === activeSiteId).map((p) => p.id));
            const pendingSnapshots = allSnapshots.filter((s) => s.status === 'pending' && siteProjectIds.has(s.projectId));
            const pendingCount = isMaster ? pendingSnapshots.length : 0;
            return (
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
                  {pendingCount > 0 && (
                    <span style={styles.bellBadge}>{pendingCount}</span>
                  )}
                </button>
                {notifOpen && (
                  <div style={styles.notifPanel} onClick={(e) => e.stopPropagation()}>
                    <div style={styles.notifHeader}>
                      <span style={styles.notifHeaderTitle}>{t('notifications.title')}</span>
                    </div>
                    {pendingCount === 0 ? (
                      <div style={styles.notifEmpty}>
                        <div style={styles.notifEmptyIcon}>
                          <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                            <path d="M8 1.5a4 4 0 0 0-4 4v3l-1.5 2.5h11L12 8V5.5a4 4 0 0 0-4-4z" />
                            <path d="M6.5 12.5a1.5 1.5 0 0 0 3 0" />
                          </svg>
                        </div>
                        <div style={styles.notifEmptyTitle}>{t('notifications.empty.title')}</div>
                        <div style={styles.notifEmptyHint}>{t('notifications.empty.hint')}</div>
                      </div>
                    ) : (
                      <div style={styles.notifList}>
                        {pendingSnapshots.map((snap) => {
                          const proj = allProjects.find((p) => p.id === snap.projectId);
                          return (
                            <div key={snap.id} style={styles.notifItem} onClick={() => { setNotifOpen(false); navigate('/site/approvals'); }}>
                              <div style={styles.notifItemTitle}>
                                <span style={styles.notifTypeBadge}>{(snap.type ?? 'mapping') === 'cutover' ? 'CUTOVER' : 'MAPPING'}</span>
                                {snap.name}
                              </div>
                              <div style={styles.notifItemMeta}>
                                {proj?.name ?? '—'} · {snap.createdBy} · {new Date(snap.createdAt).toLocaleDateString()}
                              </div>
                            </div>
                          );
                        })}
                        <div style={styles.notifFooter} onClick={() => { setNotifOpen(false); navigate('/site/approvals'); }}>
                          {t('notifications.viewAll')}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* AS-IS / TO-BE 인디케이터 (placeholder) */}
          <button title="AS-IS status (placeholder)" style={styles.statusPill}>
            <span style={{ ...styles.dot, background: 'var(--text-4)' }} />
            <span>AS-IS</span>
          </button>
          <button title="TO-BE status (placeholder)" style={styles.statusPill}>
            <span style={{ ...styles.dot, background: 'var(--text-4)' }} />
            <span>TO-BE</span>
          </button>
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
            <Tab to="/site/approvals" label={t('tab.approvals')} />
            <Tab to="/site/export" label={t('tab.siteExport')} />
            <Tab to="/site/audit" label={t('tab.auditLog')} />
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
      <SiteSettingsModal open={siteSettingsOpen} onClose={() => setSiteSettingsOpen(false)} />
      <ClusterAdminModal open={clusterAdminOpen} onClose={() => setClusterAdminOpen(false)} />
      <CreateSiteModal open={createSiteOpen} onClose={() => setCreateSiteOpen(false)} />
      <CreateProjectModal open={createProjectOpen} onClose={() => setCreateProjectOpen(false)} />
      <SignOutModal
        open={signOutOpen}
        onCancel={() => setSignOutOpen(false)}
        onConfirm={() => { setSignOutOpen(false); handleLogout(); }}
      />
    </div>
  );
}

/** 사이트 이름을 2-3 자 모노그램으로 — 예: "KS Info System" → "KIS" */
function siteBadge(name: string): string {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase() || '?';
}

/** phase 별 의미색 (badge bg / border / text). 사이드바·탑바 phase badge 공통.
 *  test/rehearsal completed → 흰배경 + 검정글씨 + 검정테두리.
 *  test/rehearsal/cutover 는 running 중에만 고유색, idle 이면 표시 안 됨 (phase 자체가 바뀜). */
function phaseColors(phase: string, runStatus?: string): { bg: string; color: string; border: string } {
  if (runStatus === 'completed' && (phase === 'test' || phase === 'rehearsal')) {
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
  siteName: {
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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
  siteMenuItemName: {
    fontSize: 11.5,
    fontWeight: 600,
    color: 'var(--text)',
    lineHeight: 1.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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
  searchInput: {
    width: '100%',
    height: 24,
    padding: '0 8px 0 24px',
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
  topTitleSub: { fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

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
    width: 320,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    boxShadow: '0 8px 24px rgba(20,30,50,.12)',
    zIndex: 500,
    overflow: 'hidden',
  },
  notifHeader: {
    padding: '6px 10px 6px 12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderBottom: '1px solid var(--border)',
    background: 'var(--panel-2)',
  },
  notifHeaderTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text)',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
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
    padding: '28px 16px',
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
  notifList: { maxHeight: 280, overflow: 'auto' },
  notifItem: {
    padding: '9px 12px',
    borderBottom: '1px solid var(--border)',
    cursor: 'pointer',
  },
  notifItemTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  notifTypeBadge: {
    fontSize: 9,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    padding: '1px 5px',
    borderRadius: 2,
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    border: '1px solid var(--amber)',
    letterSpacing: 0.3,
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
