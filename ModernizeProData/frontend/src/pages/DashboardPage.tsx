import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { healthApi, type HealthInfo } from '../api/auth';
import { useWorkspaceStore, type Project } from '../store/workspace';
import { useUsersStore } from '../store/users';
import { useAuthStore } from '../store/auth';
import { CreateSiteModal } from '../components/CreateSiteModal';
import { CreateProjectModal } from '../components/CreateProjectModal';
import { DdlImportButton } from '../components/DdlImportButton';
import { Toast } from '../components/Toast';
import { useT } from '../i18n';

/**
 * Migration readiness dashboard.
 *
 * 3 단계 empty state:
 *  1. 사이트 없음    → 사이트 만들기 CTA
 *  2. 프로젝트 없음 → 프로젝트 만들기 CTA
 *  3. 프로젝트 있음 → 정상 stat row + 테이블
 */
export function DashboardPage() {
  const t = useT();
  const sites = useWorkspaceStore((s) => s.sites);
  const projects = useWorkspaceStore((s) => s.projects);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);

  const site = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);
  const project = useMemo(() => projects.find((p) => p.id === activeProjectId) ?? null, [projects, activeProjectId]);
  const siteProjects = useMemo(() => projects.filter((p) => p.siteId === activeSiteId), [projects, activeSiteId]);

  // 생성 직후 토스트 — sites/projects 수가 늘었을 때만 (삭제·전환 시엔 무음)
  const prevSitesCount = useRef(sites.length);
  const prevProjectsCount = useRef(projects.length);
  const prevTableCount = useRef(project?.tableCount ?? 0);
  const [toast, setToast] = useState<{ msg: string } | null>(null);

  useEffect(() => {
    if (sites.length > prevSitesCount.current && site) {
      setToast({ msg: `${t('dashboard.toast.siteCreated')} · ${site.name}` });
    }
    prevSitesCount.current = sites.length;
  }, [sites.length, site, t]);

  useEffect(() => {
    if (projects.length > prevProjectsCount.current && project) {
      setToast({ msg: `${t('dashboard.toast.projectCreated')} · ${project.name}` });
    }
    prevProjectsCount.current = projects.length;
  }, [projects.length, project, t]);

  // AS-IS DDL 인포트 성공 토스트 — tableCount 가 0 → 양수로 바뀐 순간 한 번만.
  useEffect(() => {
    const current = project?.tableCount ?? 0;
    if (prevTableCount.current === 0 && current > 0) {
      setToast({ msg: `${t('asisDdl.toast.success')} · ${current} tables` });
    }
    prevTableCount.current = current;
  }, [project?.tableCount, t]);

  return (
    <>
      {!site ? <SiteOnboarding />
        : siteProjects.length === 0 ? <ProjectOnboarding siteName={site.name} />
        : !project ? <SiteOverview siteName={site.name} projects={siteProjects} />
        : (project.tableCount === 0 || project.tobeTableCount === 0)
          ? <MappingOnboarding project={project} />
        : <ProjectDashboard project={project} />}
      <Toast
        visible={!!toast}
        message={toast?.msg ?? ''}
        onHide={() => setToast(null)}
      />
    </>
  );
}

/* ─── 1단계: 사이트 없음 ─────────────────────────────────── */

function SiteOnboarding() {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div style={styles.welcomeCard}>
        <div style={styles.welcomeIconWrap}><img src="/mpd.png" alt="" width={48} height={48} /></div>
        <h1 style={styles.welcomeTitle}>{t('onboarding.welcomeTitle')}</h1>
        <p style={styles.welcomeDesc}>{t('onboarding.welcomeDesc')}</p>

        <div style={styles.steps}>
          <Step n={1} title={t('onboarding.step.site')} active />
          <Step n={2} title={t('onboarding.step.project')} />
          <Step n={3} title={t('onboarding.step.mapping')} />
        </div>

        <button style={styles.btnPrimary} onClick={() => setOpen(true)}>
          {t('onboarding.siteCta')}
        </button>
      </div>

      <CreateSiteModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/* ─── 2단계: 사이트는 있고 프로젝트 없음 ────────────────── */

function ProjectOnboarding({ siteName }: { siteName: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div style={styles.welcomeCard}>
        <div style={styles.welcomeIconWrap}><img src="/mpd.png" alt="" width={48} height={48} /></div>
        <h1 style={styles.welcomeTitle}>{siteName} {t('onboarding.projectTitle')}</h1>
        <p style={styles.welcomeDesc}>{t('onboarding.projectDesc')}</p>

        <div style={styles.steps}>
          <Step n={1} title={t('onboarding.step.site')} done />
          <Step n={2} title={t('onboarding.step.project')} active />
          <Step n={3} title={t('onboarding.step.mapping')} />
        </div>

        <button style={styles.btnPrimary} onClick={() => setOpen(true)}>
          {t('onboarding.projectCta')}
        </button>
      </div>

      <CreateProjectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/* ─── 3단계: 프로젝트 생성 직후 — DDL · 매핑 안내 ─────── */

function MappingOnboarding({ project }: { project: Project }) {
  const t = useT();
  const asisDone = project.tableCount > 0;
  const tobeDone = project.tobeTableCount > 0;
  return (
    <div style={styles.welcomeCard}>
      <div style={styles.welcomeIconWrap}><img src="/mpd.png" alt="" width={48} height={48} /></div>
      <h1 style={styles.welcomeTitle}>{project.name} {t('onboarding.mappingTitle')}</h1>
      <p style={styles.welcomeDesc}>{t('onboarding.mappingDesc')}</p>

      <div style={styles.steps}>
        <Step n={1} title={t('onboarding.step.site')} done />
        <Step n={2} title={t('onboarding.step.project')} done />
        <Step n={3} title={t('onboarding.step.mapping')} active />
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <DdlImportButton
          projectId={project.id}
          siteId={project.siteId}
          side="asis"
          disabled={asisDone}
          label={asisDone ? t('asisDdl.button.imported') : undefined}
        />
        <DdlImportButton
          projectId={project.id}
          siteId={project.siteId}
          side="tobe"
          disabled={tobeDone}
          label={tobeDone ? t('tobeDdl.button.imported') : undefined}
        />
      </div>
    </div>
  );
}

/* ─── 4단계: 정상 Dashboard ──────────────────────────────── */

function ProjectDashboard({ project }: { project: import('../store/workspace').Project }) {
  const t = useT();
  const [info, setInfo] = useState<HealthInfo | null>(null);
  const [filter, setFilter] = useState<'all' | 'ready' | 'review' | 'unbound'>('all');

  useEffect(() => {
    healthApi.info().then(setInfo).catch(() => {});
  }, []);

  return (
    <div>
      {/* Stat row */}
      <div style={styles.statRow}>
        <Stat label="TO-BE TABLES" value={String(project.tableCount)} />
        <Stat label="READY" value="0" sub="all checks pass" subColor="var(--green)" />
        <Stat label="REVIEW" value="0" sub="errs / pending approval" subColor="var(--red)" />
        <Stat label="UNBOUND" value="0" sub="no source assigned" subColor="var(--amber)" />
        <Stat label="SNAPSHOT" value="—" sub="no snapshot" mono />
        <Stat label="LAST RUN" value="—" sub="no run yet" mono />
      </div>

      {/* Filter + actions */}
      <div style={styles.toolbar}>
        <div style={styles.filterGroup}>
          <FilterPill active={filter === 'all'} onClick={() => setFilter('all')}>All <Cnt>0</Cnt></FilterPill>
          <FilterPill active={filter === 'ready'} onClick={() => setFilter('ready')}>Ready <Cnt>0</Cnt></FilterPill>
          <FilterPill active={filter === 'review'} onClick={() => setFilter('review')}>Review <Cnt>0</Cnt></FilterPill>
          <FilterPill active={filter === 'unbound'} onClick={() => setFilter('unbound')}>Unbound <Cnt>0</Cnt></FilterPill>
        </div>
        <div style={{ flex: 1 }} />
        <button style={styles.btnSecondary} disabled>Open Versions</button>
        <button style={styles.btnPrimary2} disabled>Go to Execution</button>
      </div>

      {/* Table */}
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <Th>TO-BE TABLE</Th>
              <Th>AS-IS SOURCE(S)</Th>
              <Th>COLUMN COVERAGE</Th>
              <Th align="right">ISSUES</Th>
              <Th>APPROVAL</Th>
              <Th>READINESS</Th>
              <Th width={20} />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={7} style={styles.emptyRow}>
                <div style={styles.emptyTitle}>{t('dashboard.empty.title')}</div>
                <div style={styles.emptyHint}>
                  {t('dashboard.empty.hint')}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={styles.statusbar}>
        <div>{project.tableCount} of {project.tableCount} tables · sort: name asc</div>
        <div style={{ flex: 1 }} />
        <div style={styles.dim}>
          click a row → Mapping tab · click approval chip → Versions tab
        </div>
      </div>

      {/* 개발 검증용 — 도구 정보 */}
      {info && (
        <div style={{ marginTop: 18 }}>
          <div style={styles.devCard}>
            <div style={styles.devCardHeader}>{t('dashboard.devCard.title')}</div>
            <div style={styles.devCardBody}>
              <div style={styles.devGrid}>
                <Kv k="Name" v={info.name} />
                <Kv k="Mode" v={info.mode} badge />
                <Kv k="Java" v={info.javaVersion} mono />
                <Kv k="OS" v={info.osName} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Sub-components ─────────────────────────────────── */

function Step({ n, title, active, done }: { n: number; title: string; active?: boolean; done?: boolean }) {
  const state: 'active' | 'done' | 'idle' = done ? 'done' : active ? 'active' : 'idle';
  return (
    <div style={styles.step}>
      <div style={{
        ...styles.stepNum,
        ...(state === 'active' ? styles.stepNumActive : state === 'done' ? styles.stepNumDone : {}),
      }}>
        {state === 'done' ? '✓' : n}
      </div>
      <div style={{
        ...styles.stepTitle,
        ...(state === 'active' ? { color: 'var(--navy)', fontWeight: 600 } : {}),
      }}>{title}</div>
    </div>
  );
}

function Stat({ label, value, sub, subColor, mono }: { label: string; value: string; sub?: string; subColor?: string; mono?: boolean }) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, ...(mono ? { fontFamily: 'var(--mono)' } : {}) }}>{value}</div>
      {sub && <div style={{ ...styles.statSub, ...(subColor ? { color: subColor } : {}) }}>{sub}</div>}
    </div>
  );
}

function FilterPill({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 10px',
      background: active ? 'var(--navy-50)' : 'var(--panel)',
      border: '1px solid ' + (active ? 'var(--navy)' : 'var(--border)'),
      color: active ? 'var(--navy)' : 'var(--text-2)',
      borderRadius: 4,
      fontSize: 12,
      fontWeight: active ? 600 : 500,
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
    }}>
      {children}
    </button>
  );
}

function Cnt({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)' }}>{children}</span>;
}

function Th({ children, align, width }: { children?: React.ReactNode; align?: 'left' | 'right'; width?: number }) {
  return (
    <th style={{
      padding: '6px 12px',
      textAlign: align ?? 'left',
      width,
      fontWeight: 500,
      color: 'var(--text-3)',
      fontSize: 10.5,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      background: 'var(--panel-2)',
      borderBottom: '1px solid var(--border)',
    }}>{children}</th>
  );
}

function Kv({ k, v, mono, badge }: { k: string; v: string; mono?: boolean; badge?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '4px 0' }}>
      <span style={{ fontSize: 10.5, color: 'var(--text-3)', width: 70, textTransform: 'uppercase', letterSpacing: 0.4 }}>{k}</span>
      <span style={{ fontSize: 12, color: 'var(--text)', ...(mono ? { fontFamily: 'var(--mono)' } : {}) }}>
        {badge ? <span style={styles.modeBadge}>{v}</span> : v}
      </span>
    </div>
  );
}

/* ─── Site overview: All projects (사이트 선택, 프로젝트 미선택) ── */

const PHASES: Project['phase'][] = ['planning', 'analysis', 'test', 'sign-off', 'rehearsal', 'ready', 'cutover', 'hypercare', 'done'];

function SiteOverview({ siteName, projects }: { siteName: string; projects: Project[] }) {
  const t = useT();
  const navigate = useNavigate();
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const setProjectAssignee = useWorkspaceStore((s) => s.setProjectAssignee);
  const user = useAuthStore((s) => s.user);
  const isMaster = user?.role === 'master';
  const users = useUsersStore((s) => s.users);

  // 필터 — 그리드 위에 표시. KPI · phase mix 는 전체 기준.
  const [phaseFilter, setPhaseFilter] = useState<string>('');
  const [userFilter, setUserFilter] = useState<string>('');
  const filteredProjects = projects.filter((p) => {
    if (phaseFilter && p.phase !== phaseFilter) return false;
    if (userFilter === '__unassigned') return !p.assignee;
    if (userFilter && p.assignee !== userFilter) return false;
    return true;
  });

  // phase 분포 — 우측 Phase mix 패널에 사용 (전체 기준)
  const phaseCounts: Record<string, number> = {};
  for (const p of projects) phaseCounts[p.phase] = (phaseCounts[p.phase] ?? 0) + 1;

  // KPI — placeholder (mapping UI 연결 전): tableCount 는 실데이터, mapped 는 0.
  const doneProjects = projects.filter((p) => p.phase === 'done').length;
  const totalTables = projects.reduce((a, p) => a + p.tableCount, 0);
  const mappedTables = 0;
  const totalRows = 0;
  const mappedRows = 0;
  const overallPct = totalRows > 0 ? (mappedRows / totalRows) * 100 : 0;

  const openProject = (id: string) => {
    setActiveProject(id);
    navigate('/');
  };

  return (
    <div>
      <div style={styles.overviewWrap}>
        {/* Left column — KPI · Overall progress · Filter · Table */}
        <div style={styles.overviewLeft}>
          {/* KPI strip — 3 타일 (Projects done/total · Tables mapped/total · Rows mapped/total) */}
          <div style={styles.kpiRow}>
            <KpiTile label={t('siteOverview.kpi.projects')} value={`${doneProjects} / ${projects.length}`} tone="info" />
            <KpiTile label={t('siteOverview.kpi.tables')}   value={`${mappedTables} / ${totalTables}`} />
            <KpiTile label={t('siteOverview.kpi.rows')}     value={`${mappedRows.toLocaleString()} / ${totalRows.toLocaleString()}`} />
          </div>

          {/* Overall mapping progress — Execution overview 와 같은 크기 */}
          <div style={styles.overallProgressBox}>
            <div style={styles.overallProgressHeader}>
              <span style={styles.overallProgressLabel}>{t('siteOverview.kpi.overall')}</span>
              <span style={styles.overallProgressPct}>{overallPct.toFixed(1)}%</span>
              <div style={{ flex: 1 }} />
              <span style={styles.overallProgressDim}>{t('siteOverview.noRunYet')}</span>
            </div>
            <div style={styles.overallProgressOuter}>
              <div style={{ ...styles.overallProgressInner, width: `${overallPct}%` }} />
            </div>
          </div>

          {/* Filter bar */}
          <div style={styles.filterBar}>
            <label style={styles.filterLabel}>
              <span style={styles.filterLabelText}>{t('filter.phase')}</span>
              <select value={phaseFilter} onChange={(e) => setPhaseFilter(e.target.value)} style={styles.filterSelect}>
                <option value="">{t('filter.all')}</option>
                {PHASES.map((ph) => <option key={ph} value={ph}>{ph}</option>)}
              </select>
            </label>
            <label style={styles.filterLabel}>
              <span style={styles.filterLabelText}>{t('filter.username')}</span>
              <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} style={styles.filterSelect}>
                <option value="">{t('filter.all')}</option>
                <option value="__unassigned">— {t('siteOverview.unassigned')} —</option>
                {users.map((u) => <option key={u.id} value={u.username}>{u.username}</option>)}
              </select>
            </label>
            <div style={{ flex: 1 }} />
            <span style={styles.filterCount}>
              {t('filter.count', { shown: filteredProjects.length, total: projects.length })}
            </span>
          </div>

          {/* Projects table — 매핑 진행률 + Username dropdown */}
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <Th>{t('siteOverview.col.project')}</Th>
                  <Th>{t('siteOverview.col.phase')}</Th>
                  <Th>{t('siteOverview.col.username')}</Th>
                  <Th align="right">{t('siteOverview.col.tables')}</Th>
                  <Th align="right">{t('siteOverview.col.mappingRows')}</Th>
                  <Th>{t('siteOverview.col.mapping')}</Th>
                  <Th align="right">{t('siteOverview.col.preflight')}</Th>
                </tr>
              </thead>
              <tbody>
                {filteredProjects.length === 0 ? (
                  <tr><td colSpan={7} style={styles.emptyRow}>{t('siteOverview.empty')}</td></tr>
                ) : (
                  filteredProjects.map((p, i) => {
                    const rowTotal = 0;   // placeholder — 매핑 UI 연결 전
                    const rowMapped = 0;
                    const pct = rowTotal > 0 ? (rowMapped / rowTotal) * 100 : 0;
                    const pf = preflightStatus(p);
                    return (
                      <tr
                        key={p.id}
                        onClick={() => openProject(p.id)}
                        style={{
                          background: i % 2 ? 'var(--zebra)' : 'transparent',
                          borderBottom: '1px solid var(--border)',
                          cursor: 'pointer',
                        }}
                      >
                        <td style={styles.td}>
                          <span style={{ ...styles.statusDot, ...statusDotColor(p.phase) }} />
                          <span style={{ fontWeight: 500, marginLeft: 7 }}>{p.name}</span>
                        </td>
                        <td style={styles.td}>
                          <span style={{ ...styles.phaseChip, ...phaseChipColor(p.phase, p.runStatus) }}>{p.phase}</span>
                        </td>
                        <td style={styles.td} onClick={(e) => e.stopPropagation()}>
                          {isMaster ? (
                            <select
                              value={p.assignee ?? ''}
                              onChange={(e) => setProjectAssignee(p.id, e.target.value || undefined)}
                              style={styles.assigneeSelect}
                            >
                              <option value="">— {t('siteOverview.unassigned')} —</option>
                              {users.map((u) => (
                                <option key={u.id} value={u.username}>{u.username}</option>
                              ))}
                            </select>
                          ) : (
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: p.assignee ? 'var(--text)' : 'var(--text-4)' }}>
                              {p.assignee ?? t('siteOverview.unassigned')}
                            </span>
                          )}
                        </td>
                        <td style={{ ...styles.td, textAlign: 'right', fontFamily: 'var(--mono)' }}>{p.tableCount}</td>
                        <td style={{ ...styles.td, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-4)' }}>
                          {rowMapped.toLocaleString()} / {rowTotal.toLocaleString()}
                        </td>
                        <td style={styles.td}>
                          <div style={styles.mappingProgressOuter}>
                            <div style={{ ...styles.mappingProgressInner, width: `${pct}%` }} />
                          </div>
                          <span style={styles.mappingProgressLabel}>{pct.toFixed(0)}%</span>
                        </td>
                        <td style={{ ...styles.td, textAlign: 'right' }}>
                          <span style={{
                            fontFamily: 'var(--mono)',
                            fontSize: 11.5,
                            fontWeight: 700,
                            color: `var(--${pf.tone})`,
                          }}>
                            {pf.passed} / {pf.total}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right column — Phase mix only */}
        <div style={styles.overviewRight}>
          <Panel title={t('siteOverview.panel.phaseMix')} last>
            {projects.length === 0
              ? <div style={styles.feedEmpty}>—</div>
              : <PhaseList counts={phaseCounts} total={projects.length} />}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function KpiTile({ label, value, tone }: { label: string; value: string | number; tone?: 'info' | 'ok' | 'err' | 'warn' }) {
  const color = tone === 'ok'   ? 'var(--green)'
              : tone === 'err'  ? 'var(--red)'
              : tone === 'warn' ? 'var(--amber)'
              : tone === 'info' ? 'var(--navy)'
              : 'var(--text)';
  return (
    <div style={styles.kpiTile}>
      <div style={styles.kpiLabel}>{label}</div>
      <div style={{ ...styles.kpiValue, color }}>{value}</div>
    </div>
  );
}

function Panel({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ ...styles.panel, ...(last ? { borderBottom: 'none' } : {}) }}>
      <div style={styles.panelTitle}>{title}</div>
      {children}
    </div>
  );
}

function PhaseList({ counts, total }: { counts: Record<string, number>; total: number }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <div style={styles.feedEmpty}>—</div>;
  return (
    <div>
      {rows.map(([ph, n]) => (
        <div key={ph} style={styles.mixRow}>
          <span style={{ ...styles.phaseChip, ...phaseChipColor(ph) }}>{ph}</span>
          <div style={styles.mixBarOuter}>
            <div style={{ ...styles.mixBarInner, width: `${total > 0 ? (n / total) * 100 : 0}%`, background: `var(--phase-${phaseSlug(ph)})` }} />
          </div>
          <span style={styles.mixCount}>{n}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 프로젝트별 preflight 체크 통과 현황 (placeholder).
 * - 다 통과 → green
 * - 일부 미통과지만 runnable (rehearsal·cutover) → amber
 * - 못 돌리는 상태 → red
 * 실제 preflight 데이터 연결 전이라 phase 기반 휴리스틱.
 */
function preflightStatus(p: Project): { passed: number; total: number; tone: 'green' | 'amber' | 'red' } {
  // placeholder total — 실제는 백엔드 preflight check 개수.
  const total = 6;
  if (p.phase === 'done' || p.phase === 'hypercare') {
    return { passed: total, total, tone: 'green' };
  }
  if (p.phase === 'rehearsal' || p.phase === 'cutover') {
    // 돌릴 수 있지만 미통과 항목 존재한다고 가정.
    return { passed: Math.max(total - 2, 0), total, tone: 'amber' };
  }
  // planning · analysis · sign-off — 아직 실행 불가
  return { passed: 0, total, tone: 'red' };
}

function phaseSlug(phase: string): string {
  const slugMap: Record<string, string> = {
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
  return slugMap[phase] ?? 'done';
}

function statusDotColor(phase: string): React.CSSProperties {
  return { background: `var(--phase-${phaseSlug(phase)})` };
}

function phaseChipColor(phase: string, runStatus?: string): React.CSSProperties {
  if (runStatus === 'completed' && (phase === 'test' || phase === 'rehearsal')) {
    return {
      background: 'var(--panel)',
      color:      'var(--text)',
      borderColor:'var(--border-strong)',
    };
  }
  const slug = phaseSlug(phase);
  return {
    background: `var(--phase-${slug}-50)`,
    color:      `var(--phase-${slug})`,
    borderColor:`var(--phase-${slug})`,
  };
}

const styles: Record<string, React.CSSProperties> = {
  /* Welcome (onboarding) */
  welcomeCard: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '40px 32px',
    textAlign: 'center',
    maxWidth: 640,
    margin: '40px auto',
  },
  welcomeIcon: { fontSize: 40, marginBottom: 14 },
  welcomeIconWrap: {
    margin: '0 auto 14px',
    display: 'grid',
    placeItems: 'center',
  },
  welcomeTitle: {
    margin: '0 0 8px',
    fontSize: 19,
    fontWeight: 700,
    color: 'var(--text)',
    letterSpacing: -0.3,
  },
  welcomeDesc: {
    margin: '0 0 24px',
    fontSize: 13,
    color: 'var(--text-2)',
    lineHeight: 1.6,
  },
  steps: {
    display: 'flex',
    justifyContent: 'space-around',
    gap: 8,
    marginBottom: 26,
    padding: '0 8px',
  },
  step: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: 'var(--panel-2)',
    color: 'var(--text-4)',
    display: 'grid',
    placeItems: 'center',
    fontSize: 12,
    fontWeight: 700,
    border: '1px solid var(--border)',
  },
  stepNumActive: {
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
  },
  stepNumDone: {
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    border: '1px solid var(--navy)',
  },
  stepTitle: { fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap' },

  /* Buttons */
  btnPrimary: {
    padding: '10px 24px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnPrimary2: {
    padding: '6px 12px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnSecondary: {
    padding: '6px 12px',
    background: 'var(--panel)',
    color: 'var(--text)',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },

  /* Stat row */
  statRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, 1fr)',
    gap: 1,
    background: 'var(--border)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 14,
  },
  stat: { background: 'var(--panel)', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4 },
  statLabel: { fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 },
  statValue: { fontSize: 24, fontWeight: 700, color: 'var(--text)', letterSpacing: -0.5, lineHeight: 1 },
  statSub: { fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

  /* Toolbar */
  toolbar: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 },
  filterGroup: { display: 'flex', gap: 4 },

  /* Table */
  tableWrap: { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  td: { padding: '8px 12px' },
  emptyRow: { padding: '60px 20px', textAlign: 'center', background: 'var(--zebra)' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6 },
  emptyHint: { fontSize: 11, color: 'var(--text-4)', fontFamily: 'var(--mono)' },

  /* Username dropdown / mapping progress */
  assigneeSelect: {
    padding: '4px 8px', border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel)', color: 'var(--text)', fontSize: 12,
    outline: 'none', fontFamily: 'var(--mono)', minWidth: 110,
  },
  mappingProgressOuter: {
    width: 140, height: 6, background: 'var(--panel-2)',
    border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden',
    display: 'inline-block', verticalAlign: 'middle',
  },
  mappingProgressInner: { height: '100%', background: 'var(--navy)' },
  mappingProgressLabel: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginLeft: 8 },

  /* Site overview */
  overviewWrap: {
    display: 'grid',
    gridTemplateColumns: '1fr 300px',
    gap: 14,
    alignItems: 'stretch',
  },
  overviewLeft: { display: 'flex', flexDirection: 'column', gap: 12 },
  overviewRight: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  overviewHeaderRow: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '12px 14px',
    display: 'flex',
    alignItems: 'flex-end',
    gap: 8,
  },
  overviewEyebrow: {
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontFamily: 'var(--mono)',
    marginBottom: 3,
  },
  overviewTitle: { fontSize: 18, fontWeight: 600, letterSpacing: -0.2, color: 'var(--text)' },
  overviewSummary: { fontSize: 11, color: 'var(--text-3)', marginTop: 2, fontFamily: 'var(--mono)' },
  toolbarBtnGhost: {
    padding: '5px 11px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-2)',
    borderRadius: 3,
    fontSize: 11.5,
    cursor: 'not-allowed',
    opacity: 0.6,
  },
  toolbarBtnPrimary: {
    padding: '5px 11px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    fontSize: 11.5,
    fontWeight: 600,
    cursor: 'not-allowed',
    opacity: 0.6,
  },

  /* KPI tiles row */
  kpiRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 1,
    background: 'var(--border)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 10,
  },

  /* Page header — Execution overview 와 동일한 단순 디자인 */
  pageHeader: { marginBottom: 14 },
  pageH1: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: -0.2 },
  pageSubtitle: { margin: '4px 0 0', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

  /* Filter bar */
  filterBar: {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    padding: '8px 12px', background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8,
  },
  filterLabel: { display: 'inline-flex', alignItems: 'center', gap: 6 },
  filterLabelText: {
    fontSize: 10.5, fontWeight: 600, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: 'var(--mono)',
  },
  filterSelect: {
    padding: '4px 8px', border: '1px solid var(--border-strong)', borderRadius: 3,
    background: 'var(--panel)', color: 'var(--text)', fontSize: 12,
    outline: 'none', fontFamily: 'var(--mono)', minWidth: 110,
  },
  filterCount: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

  /* Overall progress box — Execution overview 와 동일 */
  overallProgressBox: {
    padding: '10px 14px', background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 6, marginBottom: 12,
  },
  overallProgressHeader: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 },
  overallProgressLabel: {
    fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-2)',
  },
  overallProgressPct: { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' },
  overallProgressDim: { fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-4)' },
  overallProgressOuter: {
    height: 8, borderRadius: 4, background: 'var(--panel-2)',
    border: '1px solid var(--border)', overflow: 'hidden',
  },
  overallProgressInner: { height: '100%', background: 'var(--navy)' },
  ownerCell: { display: 'inline-flex', alignItems: 'center', gap: 6 },
  ownerAvatar: {
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: 'var(--navy)',
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    fontSize: 10,
    fontWeight: 700,
    flexShrink: 0,
  },
  ownerName: { fontSize: 11.5, color: 'var(--text)', fontFamily: 'var(--mono)' },
  kpiTile: {
    background: 'var(--panel)',
    padding: '10px 14px 12px',
  },
  kpiLabel: {
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    fontFamily: 'var(--mono)',
    marginBottom: 4,
    fontWeight: 600,
  },
  kpiValue: {
    fontSize: 22,
    fontWeight: 600,
    letterSpacing: -0.4,
  },
  kpiSub: {
    fontSize: 10.5,
    color: 'var(--text-3)',
    marginTop: 2,
    fontFamily: 'var(--mono)',
  },

  /* Progress box */
  progressBox: {
    padding: '10px 14px',
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
  },
  progressHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 6,
  },
  progressLabel: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-2)' },
  progressMono: { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' },
  progressMonoDim: { fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-4)' },
  progressBarOuter: {
    height: 8,
    borderRadius: 4,
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    overflow: 'hidden',
  },
  progressBarInner: { height: '100%', background: 'var(--navy)' },

  /* Right column panels */
  panel: {
    padding: '10px 14px 12px',
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
  },
  panelTitle: {
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    fontFamily: 'var(--mono)',
    marginBottom: 8,
    fontWeight: 600,
  },
  feedEmpty: {
    fontSize: 11.5,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
  },

  /* Pending approvals */
  pendingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 0',
  },
  pendingRowSep: { borderTop: '1px solid var(--border)' },
  pendingName: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pendingMeta: {
    fontSize: 10.5,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    marginTop: 2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pendingActions: { display: 'flex', gap: 4 },
  pendingApproveBtn: {
    width: 24,
    height: 24,
    border: '1px solid var(--green)',
    background: 'var(--panel)',
    color: 'var(--green)',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1,
    padding: 0,
  },
  pendingRejectBtn: {
    width: 24,
    height: 24,
    border: '1px solid var(--red)',
    background: 'var(--panel)',
    color: 'var(--red)',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1,
    padding: 0,
  },
  pendingCoordTag: {
    padding: '2px 7px',
    fontSize: 9.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    border: '1px solid var(--amber)',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    whiteSpace: 'nowrap',
  },
  feedEmptySub: { fontSize: 10.5, color: 'var(--text-4)', marginTop: 2 },

  mixRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 5,
  },
  mixLabel: { fontSize: 11, color: 'var(--text)', fontWeight: 500, fontFamily: 'var(--mono)', width: 72, flexShrink: 0 },
  mixBarOuter: { flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' },
  mixBarInner: { height: '100%' },
  mixCount: { fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-3)', width: 22, textAlign: 'right' },

  stageRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 5,
  },
  stageLabel: { fontSize: 11, color: 'var(--text-2)', width: 68 },
  stageBarOuter: { flex: 1, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' },
  stageBarInner: { height: '100%', background: 'var(--text-4)' },
  stageCount: { fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-4)', width: 28, textAlign: 'right' },

  statusDot: {
    display: 'inline-block',
    width: 7,
    height: 7,
    borderRadius: '50%',
    verticalAlign: 'middle',
  },
  phaseChips: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  phaseChip: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 72,
    padding: '2px 0',
    fontSize: 10,
    fontWeight: 600,
    fontFamily: 'var(--mono)',
    border: '1px solid',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    textAlign: 'center',
    flexShrink: 0,
  },
  phaseChipCount: { fontWeight: 700, opacity: 0.85 },
  miniBtn: {
    padding: '3px 9px',
    fontSize: 11,
    border: '1px solid var(--border-strong)',
    background: 'var(--panel)',
    color: 'var(--text-2)',
    borderRadius: 3,
    cursor: 'pointer',
  },

  /* Status bar */
  statusbar: {
    display: 'flex',
    gap: 12,
    marginTop: 8,
    padding: '0 4px',
    fontSize: 11,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
  },
  dim: { color: 'var(--text-4)' },

  /* Dev card */
  devCard: { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' },
  devCardHeader: {
    padding: '8px 14px', background: 'var(--panel-2)', borderBottom: '1px solid var(--border)',
    fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: 0.5,
  },
  devCardBody: { padding: 14 },
  devGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 },
  modeBadge: {
    display: 'inline-block', padding: '1px 7px', fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)',
    background: 'var(--navy-50)', color: 'var(--navy)', border: '1px solid var(--navy)', borderRadius: 3,
    textTransform: 'uppercase', letterSpacing: 0.4,
  },
};
