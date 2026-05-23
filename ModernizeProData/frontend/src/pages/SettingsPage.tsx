import { useMemo, useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useWorkspaceStore, type Project, type ProjectPhase, type Site } from '../store/workspace';
import { useNotificationPrefsStore } from '../store/notificationPreferences';
import { useSettingsStore } from '../store/settings';
import { projectApi } from '../api/workspace';
import { ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import { useActiveProjectReadOnly } from '../store/readOnly';
import { DdlSchemaPanel } from '../components/DdlSchemaPanel';
import { LockIcon } from '../components/LockIcon';
import { Toast } from '../components/Toast';
import { useT } from '../i18n';

/** AppShell 의 AS-IS/TO-BE 램프 클릭 → navigate(..., { state: { highlightSide } }) 로 전달.
 *  'asis-csv' 는 MappingPage 의 "CSV not imported" 배지에서 들어오는 경우에 쓰이며
 *  AS-IS 섹션의 CSV 카드를 하이라이트한다. */
type HighlightSide = 'asis' | 'asis-csv' | 'tobe';
interface HighlightState { highlightSide?: HighlightSide }

const ALL_PHASES: ProjectPhase[] = ['planning', 'analysis', 'test', 'sign-off', 'rehearsal', 'ready', 'cutover', 'hypercare', 'done'];

function isSiteDbConfigured(s: Site | null): boolean {
  if (!s) return false;
  const db = s.tobeDbByEnv?.[s.environment];
  if (!db) return false;
  return !!db.type?.trim() && !!db.host?.trim() && !!db.database?.trim() && !!db.username?.trim();
}

type SectionKey = 'general' | 'ddl' | 'schedule' | 'notify' | 'danger';

/**
 * Project Settings — 프로토타입의 6-section 구조.
 *
 *   General · AS-IS · TO-BE · Schedule · Notifications · Danger zone
 *
 * General / Danger 만 백엔드 연결 (이름·phase 수정, 프로젝트 삭제).
 * 나머지 섹션은 UI 만 — connection / credentials / schedule / notifications
 * 메타데이터가 Project 엔티티에 아직 없어서 mock state 로 구동.
 */
export function SettingsPage() {
  const t = useT();
  const location = useLocation();
  const projects = useWorkspaceStore((s) => s.projects);
  const sites = useWorkspaceStore((s) => s.sites);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const project = useMemo(() => projects.find((p) => p.id === activeProjectId) ?? null, [projects, activeProjectId]);
  const site = useMemo(() => sites.find((s) => s.id === project?.siteId) ?? null, [sites, project]);

  const [section, setSection] = useState<SectionKey>('general');
  const [highlightSide, setHighlightSide] = useState<HighlightSide | null>(null);

  // AppShell 의 AS-IS/TO-BE 램프에서 navigate(..., { state: { highlightSide } }) 로 들어왔을 때
  // DDL 섹션으로 이동 + 1초 highlight pulse.
  useEffect(() => {
    const state = location.state as HighlightState | null;
    const side = state?.highlightSide;
    if (!side) return;
    setSection('ddl');
    setHighlightSide(side);
    const t = window.setTimeout(() => setHighlightSide(null), 1000);
    window.history.replaceState({}, '');
    return () => window.clearTimeout(t);
  }, [location.state]);

  if (!project) {
    return (
      <div>
        <div style={emptyStyles.header}>
          <h1 style={emptyStyles.h1}>{t('tab.settings')}</h1>
          <p style={emptyStyles.subtitle}>{t('projectSettings.subtitle')}</p>
        </div>
        <div style={emptyStyles.empty}>
          <div style={emptyStyles.emptyTitle}>{t('projectSettings.empty.title')}</div>
          <div style={emptyStyles.emptyHint}>{t('projectSettings.empty.hint')}</div>
          <div style={emptyStyles.emptyNote}>{t('projectSettings.empty.note')}</div>
        </div>
      </div>
    );
  }

  const sections: { k: SectionKey; l: string; d: string; danger?: boolean }[] = [
    { k: 'general',   l: t('projectSettings.section.general.label'),   d: t('projectSettings.sidebar.general.desc') },
    { k: 'ddl',       l: t('projectSettings.section.ddl.label'),       d: t('projectSettings.sidebar.ddl.desc') },
    { k: 'schedule',  l: t('projectSettings.section.schedule.label'),  d: t('projectSettings.sidebar.schedule.desc') },
    { k: 'notify',    l: t('projectSettings.section.notify.label'),    d: t('projectSettings.sidebar.notify.desc') },
    { k: 'danger',    l: t('projectSettings.section.danger.label'),    d: t('projectSettings.sidebar.danger.desc'), danger: true },
  ];

  return (
    <div style={styles.wrap}>
      <aside style={styles.aside}>
        <div style={styles.asideHeader}>{t('projectSettings.sidebar.header')}</div>
        {sections.map((s) => {
          const active = s.k === section;
          return (
            <div
              key={s.k}
              onClick={() => setSection(s.k)}
              title={s.d}
              style={{
                ...styles.asideItem,
                background: active ? (s.danger ? 'var(--red-50)' : 'var(--navy-50)') : 'transparent',
                borderLeft: active
                  ? `2px solid ${s.danger ? 'var(--red)' : 'var(--navy)'}`
                  : '2px solid transparent',
              }}
            >
              <div
                style={{
                  ...styles.asideItemLabel,
                  fontWeight: active ? 600 : 500,
                  color: active
                    ? s.danger ? 'var(--red)' : 'var(--navy)'
                    : s.danger ? 'var(--red)' : 'var(--text)',
                }}
              >
                {s.l}
              </div>
              <div style={styles.asideItemDesc}>{s.d}</div>
            </div>
          );
        })}
      </aside>

      <div style={styles.content}>
        {section === 'general'   && <PSGeneral   project={project} site={site} />}
        {section === 'ddl'       && <PSDdl       project={project} highlightSide={highlightSide} />}
        {section === 'schedule'  && <PSSchedule  project={project} />}
        {section === 'notify'    && <PSNotify    project={project} />}
        {section === 'danger'    && <PSDanger    project={project} />}
      </div>
    </div>
  );
}

/* ─── General ────────────────────────────────────────────── */

function PSGeneral({ project, site }: { project: Project; site: Site | null }) {
  const t = useT();
  const readOnly = useActiveProjectReadOnly();
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const dirty = name !== project.name;

  // unlock 취소 시 이름 원복
  useEffect(() => {
    if (!unlocked) setName(project.name);
  }, [unlocked, project.name]);

  const handleSave = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      await projectApi.update(project.id, { name });
      await useWorkspaceStore.getState().fetchSites();
      const siteId = useWorkspaceStore.getState().activeSiteId;
      if (siteId) await useWorkspaceStore.getState().fetchProjects(siteId);
      setSavedMsg('Saved');
      setUnlocked(false);
      setTimeout(() => setSavedMsg(null), 1500);
    } catch (e) {
      console.error('[settings] save name failed', e);
      if (e instanceof ApiError && e.code === 'PROJECT_NAME_DUPLICATE') {
        setSavedMsg('Name already used');
      } else {
        setSavedMsg('Failed');
      }
      setTimeout(() => setSavedMsg(null), 2500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PSHead
        title="General"
        desc={t('projectSettings.head.general.desc')}
        actions={
          <>
            {savedMsg && <span style={styles.savedMsg}>{savedMsg}</span>}
            <button
              onClick={handleSave}
              disabled={!dirty || saving || readOnly}
              style={{ ...styles.btnPrimary, ...((!dirty || saving || readOnly) ? styles.btnDisabled : {}) }}
            >
              {saving ? t('projectSettings.action.saving') : t('projectSettings.action.save')}
            </button>
          </>
        }
      />
      <PSCard>
        <PSRow label={t('projectSettings.row.name')}>
          <PSInput value={name} onChange={unlocked && !readOnly ? setName : undefined} readOnly={!unlocked || readOnly} />
          <button
            type="button"
            onClick={() => setUnlocked((u) => !u)}
            style={{ ...styles.btnLockIcon, ...(readOnly ? styles.btnDisabled : {}) }}
            disabled={saving || readOnly}
            title={unlocked ? t('projectSettings.general.lock') : t('projectSettings.general.unlock')}
            aria-label={unlocked ? t('projectSettings.general.lock') : t('projectSettings.general.unlock')}
          >
            <LockIcon open={unlocked} color="var(--green)" size={16} />
          </button>
        </PSRow>
        <PSRow label={t('projectSettings.row.site')}>
          <span style={styles.staticText}>{site?.name ?? '—'}</span>
        </PSRow>
        <PSRow label={t('projectSettings.row.env')}>
          <span style={isSiteDbConfigured(site) ? styles.envChip : styles.envChipOff}>{site?.environment ?? '—'}</span>
        </PSRow>
        <PSRow label={t('projectSettings.row.createdAt')}>
          <span style={styles.staticText}>{new Date(project.createdAt).toLocaleString()}</span>
        </PSRow>
      </PSCard>

      <PSCard title={t('projectSettings.phase.title')} desc={t('projectSettings.phase.desc')}>
        <PSRow label={t('projectSettings.phase.row')}>
          <select
            value={project.phase}
            disabled={readOnly}
            onChange={async (e) => {
              const phase = e.target.value as ProjectPhase;
              try {
                await projectApi.update(project.id, { phase, runStatus: 'idle' });
                const siteId = useWorkspaceStore.getState().activeSiteId;
                if (siteId) await useWorkspaceStore.getState().fetchProjects(siteId);
              } catch (err) {
                console.error('[settings] phase change failed', err);
              }
            }}
            style={{ ...styles.phaseSelect, ...(readOnly ? styles.btnDisabled : {}) }}
          >
            {ALL_PHASES.map((ph) => <option key={ph} value={ph}>{ph}</option>)}
          </select>
        </PSRow>
      </PSCard>
    </>
  );
}

/* ─── DDL Import (AS-IS + TO-BE) ─────────────────────────── */

function PSDdl({ project, highlightSide }: { project: Project; highlightSide: HighlightSide | null }) {
  const t = useT();
  return (
    <>
      <PSHead title={t('projectSettings.section.ddl.label')} />
      <DdlSchemaPanel project={project} side="asis" highlight={highlightSide === 'asis'} />
      <DdlSchemaPanel project={project} side="tobe" highlight={highlightSide === 'tobe'} />
    </>
  );
}

/* ─── Schedule ───────────────────────────────────────────── */

function PSSchedule({ project }: { project: Project }) {
  const t = useT();
  /* mock — 실제론 Project 엔티티에 schedule jsonb 추가 필요 */
  const [rehearsalOn, setRehearsalOn] = useState(true);
  const [startTime, setStartTime] = useState('22:00 KST');
  const [maxDuration, setMaxDuration] = useState('240');
  const [extOpen, setExtOpen] = useState(false);

  const cutover = (project.cutover ?? {}) as { dday?: string; freezeHours?: number; rollbackSla?: number };

  return (
    <>
      <PSHead
        title="Schedule"
        desc={t('projectSettings.head.schedule.desc')}
        actions={<button style={styles.btnPrimary} disabled>{t('projectSettings.action.saveChanges')}</button>}
        mock
      />

      <PSCard
        title={t('projectSettings.schedule.nightly.title')}
        desc={t('projectSettings.schedule.nightly.desc')}
      >
        <PSRow label={t('projectSettings.schedule.row.enabled')} hint={rehearsalOn ? t('projectSettings.schedule.row.enabledOn') : t('projectSettings.schedule.row.enabledOff')}>
          <Toggle on={rehearsalOn} onChange={setRehearsalOn} label={rehearsalOn ? t('projectSettings.schedule.toggle.on') : t('projectSettings.schedule.toggle.off')} />
        </PSRow>
        <PSRow label={t('projectSettings.schedule.row.startTime')} hint={t('projectSettings.schedule.row.startTimeHint')}>
          <PSInput value={startTime} onChange={setStartTime} mono width={140} />
        </PSRow>
        <PSRow label={t('projectSettings.schedule.row.maxDuration')} hint={t('projectSettings.schedule.row.maxDurationHint')}>
          <PSInput value={maxDuration} onChange={setMaxDuration} mono suffix={t('projectSettings.schedule.minutes')} width={120} />
        </PSRow>
        <PSRow label={t('projectSettings.schedule.row.next')}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: rehearsalOn ? 'var(--text-2)' : 'var(--text-4)' }}>
            {rehearsalOn ? t('projectSettings.schedule.row.nextRun', { time: startTime }) : t('projectSettings.schedule.row.nextDisabled')}
          </span>
        </PSRow>
      </PSCard>

      <PSCard title={t('projectSettings.schedule.cutover.title')} desc={t('projectSettings.schedule.cutover.desc')}>
        <PSRow label={t('projectSettings.schedule.cutover.dday')} hint={t('projectSettings.schedule.cutover.ddayHint')}>
          <PSInput value={cutover.dday ?? 'TBD'} mono />
        </PSRow>
        <PSRow label={t('projectSettings.schedule.cutover.freeze')} hint={t('projectSettings.schedule.cutover.freezeHint')}>
          <PSInput value={String(cutover.freezeHours ?? 24)} mono suffix={t('projectSettings.schedule.hours')} width={120} />
        </PSRow>
        <PSRow label={t('projectSettings.schedule.cutover.rollback')} hint={t('projectSettings.schedule.cutover.rollbackHint')}>
          <PSInput value={String(cutover.rollbackSla ?? 15)} mono suffix={t('projectSettings.schedule.minutes')} width={120} />
        </PSRow>
      </PSCard>

      <div style={styles.collapseCard}>
        <div onClick={() => setExtOpen((o) => !o)} style={{ ...styles.collapseHeader, background: extOpen ? 'var(--panel-2)' : 'var(--panel)' }}>
          <span style={{ color: 'var(--text-4)', fontSize: 10, width: 10 }}>{extOpen ? '▾' : '▸'}</span>
          <div style={{ flex: 1 }}>
            <div style={styles.cardTitle}>{t('projectSettings.schedule.external.title')}</div>
            <div style={styles.cardDesc}>
              {t('projectSettings.schedule.external.desc')}
            </div>
          </div>
          <span style={styles.statusBadgeQueued}>{t('projectSettings.schedule.external.optional')}</span>
        </div>
        {extOpen && (
          <div style={{ padding: '14px 16px' }}>
            <div style={styles.warnBox}>
              <div style={styles.warnTitle}>{t('projectSettings.schedule.external.warnTitle')}</div>
              {t('projectSettings.schedule.external.warnBodyBefore')}<b>Solution Settings › External integrations</b>{t('projectSettings.schedule.external.warnBodyAfter')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 8, marginTop: 10 }}>
              {t('projectSettings.schedule.external.cliHint')}
            </div>
            <pre style={styles.cliBlock}>
{`# Nightly rehearsal (dry-run · TEST target)
migrate run --project ${project.id} --mode rehearsal --dry-run

# Cutover (production target · approved snapshot required)
migrate run --project ${project.id} --mode cutover

# Rollback
migrate rollback --project ${project.id} --to pre-cutover`}
            </pre>
          </div>
        )}
      </div>
    </>
  );
}

/* ─── Notifications ──────────────────────────────────────── */

function PSNotify({ project }: { project: Project }) {
  const t = useT();
  const readOnly = useActiveProjectReadOnly();
  // Solution settings 의 Enable notifications. false 면 Event subscriptions 토글 일괄 비활성.
  const globalNotifEnabled = useSettingsStore((s) => s.notifications);
  const events = [
    { k: 'run.started',      l: t('projectSettings.notify.event.runStarted.label'),      d: t('projectSettings.notify.event.runStarted.desc') },
    { k: 'run.failed',       l: t('projectSettings.notify.event.runFailed.label'),       d: t('projectSettings.notify.event.runFailed.desc') },
    { k: 'run.finished',     l: t('projectSettings.notify.event.runFinished.label'),     d: t('projectSettings.notify.event.runFinished.desc') },
    { k: 'snapshot.pending', l: t('projectSettings.notify.event.snapPending.label'),     d: t('projectSettings.notify.event.snapPending.desc') },
    { k: 'snapshot.approved',l: t('projectSettings.notify.event.snapApproved.label'),    d: t('projectSettings.notify.event.snapApproved.desc') },
    { k: 'snapshot.rejected',l: t('projectSettings.notify.event.snapRejected.label'),    d: t('projectSettings.notify.event.snapRejected.desc') },
  ];

  const subsMap          = useNotificationPrefsStore((s) => s.subs);
  const setSubscription  = useNotificationPrefsStore((s) => s.setSubscription);

  // store 에 저장된 현재 값
  const savedSubs = subsMap[project.id] ?? {};

  // 로컬 draft — Save 누르기 전까지는 store 에 반영 안 됨
  const [draftSubs, setDraftSubs] = useState<Record<string, boolean>>(savedSubs);
  const [savedToast, setSavedToast] = useState(false);

  // 프로젝트가 바뀌면 draft 를 저장값으로 재초기화
  useEffect(() => {
    setDraftSubs(subsMap[project.id] ?? {});
    // 프로젝트 변경 시에만 초기화 — store map 변화로 인한 재초기화는 원치 않음 (자기가 저장한 직후 깜박임 방지)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const isOn = (k: string) => draftSubs[k] ?? true;

  const isDirty = useMemo(() => {
    for (const e of events) {
      const d = draftSubs[e.k] ?? true;
      const s = savedSubs[e.k] ?? true;
      if (d !== s) return true;
    }
    return false;
  }, [draftSubs, savedSubs, events]);

  const handleSave = () => {
    if (!isDirty) return;
    for (const e of events) {
      const v = draftSubs[e.k] ?? true;
      setSubscription(project.id, e.k, v);
    }
    setSavedToast(true);
  };

  return (
    <>
      <PSHead
        title="Notifications"
        desc={t('projectSettings.head.notify.desc')}
        actions={
          <button
            onClick={handleSave}
            disabled={!isDirty || readOnly}
            style={{ ...styles.btnPrimary, ...((!isDirty || readOnly) ? styles.btnDisabled : {}) }}
          >
            {t('projectSettings.action.saveChanges')}
          </button>
        }
      />

      <PSCard title={t('projectSettings.notify.subscriptions.title')} desc={t('projectSettings.notify.subscriptions.desc')}>
        {events.map((e, i) => (
          <div
            key={e.k}
            style={{
              ...styles.notifyRow,
              borderBottom: i < events.length - 1 ? '1px dashed var(--border)' : 'none',
            }}
          >
            <div>
              <div style={{ fontSize: 12, fontWeight: 500 }}>{e.l}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>{e.d}</div>
            </div>
            <Toggle
              on={globalNotifEnabled && isOn(e.k)}
              onChange={() => setDraftSubs((cur) => ({ ...cur, [e.k]: !(cur[e.k] ?? true) }))}
              disabled={!globalNotifEnabled || readOnly}
              label=""
            />
          </div>
        ))}
      </PSCard>

      <Toast visible={savedToast} message={t('projectSettings.action.savedToast')} onHide={() => setSavedToast(false)} />
    </>
  );
}


/* ─── Danger zone ────────────────────────────────────────── */

function PSDanger({ project }: { project: Project }) {
  const t = useT();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const isMaster = user?.role === 'master';
  const readOnly = useActiveProjectReadOnly();
  const deleteProject = useWorkspaceStore((s) => s.deleteProject);
  const createProject = useWorkspaceStore((s) => s.createProject);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const canDelete = confirmText === project.name;

  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);

  const closeDuplicate = () => {
    setDuplicateOpen(false);
    setDuplicateError(null);
  };

  const handleDelete = async () => {
    if (!isMaster || !canDelete) return;
    try {
      await deleteProject(project.id);
      setConfirmOpen(false);
      setConfirmText('');
      navigate('/');
    } catch (e) {
      console.error('[settings] delete project failed', e);
    }
  };

  const confirmDuplicate = async () => {
    if (!isMaster || duplicating) return;
    setDuplicating(true);
    setDuplicateError(null);
    try {
      await createProject({
        name: `${project.name} (copy)`,
        phase: 'planning',
        tableCount: 0,
        ddlFiles: project.ddlFiles,
        owner: project.owner,
      });
      closeDuplicate();
      navigate('/');
    } catch (e) {
      console.error('[settings] duplicate project failed', e);
      if (e instanceof ApiError && e.code === 'PROJECT_NAME_DUPLICATE') {
        setDuplicateError(t('projectSettings.duplicate.error.duplicate'));
      } else {
        setDuplicateError(t('projectSettings.duplicate.error.generic'));
      }
    } finally {
      setDuplicating(false);
    }
  };

  return (
    <>
      <PSHead title={t('projectSettings.section.danger.label')} desc={t('projectSettings.head.danger.desc')} />

      <div style={styles.dangerCard}>
        <div style={styles.dangerRow}>
          <div style={{ flex: 1 }}>
            <div style={styles.dangerTitle}>{t('projectSettings.danger.duplicate.label')}</div>
            <div style={styles.dangerDesc}>
              {t('projectSettings.danger.duplicate.desc')}
            </div>
          </div>
          {isMaster ? (
            <button
              onClick={() => setDuplicateOpen(true)}
              disabled={readOnly}
              style={{ ...styles.btnSecondary, ...(readOnly ? styles.btnDisabled : {}) }}
            >
              {t('projectSettings.danger.duplicate.cta')}
            </button>
          ) : (
            <span style={styles.coordOnlyTag} title="Coordinator only">Coordinator only</span>
          )}
        </div>

        <div style={{ ...styles.dangerRow, borderTop: '1px solid var(--red)' }}>
          <div style={{ flex: 1 }}>
            <div style={styles.dangerTitle}>Delete project</div>
            <div style={styles.dangerDesc}>
              Permanently removes mapping rules, execution logs, and generated artifacts. <b>This cannot be undone.</b>
            </div>
          </div>
          {isMaster ? (
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={readOnly}
              style={{ ...styles.btnDanger, ...(readOnly ? styles.btnDisabled : {}) }}
            >
              Delete project…
            </button>
          ) : (
            <span style={styles.coordOnlyTag} title="Coordinator only">Coordinator only</span>
          )}
        </div>
      </div>

      {duplicateOpen && (
        <div onClick={closeDuplicate} style={styles.modalOverlay}>
          <div onClick={(e) => e.stopPropagation()} style={styles.modal}>
            <div style={{ ...styles.modalHeader, background: 'var(--panel-2)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                {t('projectSettings.duplicate.title')}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 6, lineHeight: 1.5 }}>
                {t('projectSettings.duplicate.desc', { name: project.name })}
              </div>
            </div>
            {duplicateError && (
              <div style={{
                padding: '10px 18px',
                background: 'var(--red-50)',
                borderTop: '1px solid var(--red)',
                color: 'var(--red)',
                fontSize: 12,
                fontWeight: 500,
              }}>
                {duplicateError}
              </div>
            )}
            <div style={styles.modalFooter}>
              <button
                onClick={closeDuplicate}
                style={styles.btnGhost}
                disabled={duplicating}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={confirmDuplicate}
                disabled={duplicating}
                style={{ ...styles.btnPrimary, ...(duplicating ? styles.btnDisabled : {}) }}
              >
                {t('projectSettings.duplicate.confirmBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmOpen && (
        <div onClick={() => setConfirmOpen(false)} style={styles.modalOverlay}>
          <div onClick={(e) => e.stopPropagation()} style={styles.modal}>
            <div style={styles.modalHeader}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--red)' }}>Delete "{project.name}"</div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 3 }}>
                This will permanently delete:
              </div>
              <ul style={styles.modalList}>
                <li>{project.tableCount} table mapping{project.tableCount === 1 ? '' : 's'}</li>
                <li>all run logs, artifacts, and diff reports</li>
                <li>scheduled runs and webhook configuration</li>
              </ul>
            </div>
            <div style={styles.modalBody}>
              <div style={{ fontSize: 11.5, marginBottom: 6 }}>
                Type <code style={styles.confirmCode}>{project.name}</code> to confirm.
              </div>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={project.name}
                style={{ ...styles.confirmTextInput, borderColor: canDelete ? 'var(--red)' : 'var(--border)' }}
                autoFocus
              />
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => { setConfirmOpen(false); setConfirmText(''); }} style={styles.btnGhost}>Cancel</button>
              <button
                onClick={handleDelete}
                disabled={!canDelete}
                style={{ ...styles.btnDanger, ...(canDelete ? {} : styles.btnDisabled), background: canDelete ? 'var(--red)' : 'var(--border-strong)', color: '#fff' }}
              >
                Delete forever
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ─── Reusable primitives ────────────────────────────────── */

function PSHead({ title, actions, mock }: { title: string; desc?: string; actions?: React.ReactNode; mock?: boolean }) {
  return (
    <div style={styles.head}>
      <div style={{ flex: 1 }}>
        <h2 style={styles.headTitle}>
          {title}
          {mock && <span style={{ ...styles.uiOnlyBadge, marginLeft: 10, verticalAlign: 'middle' }}>UI only</span>}
        </h2>
      </div>
      {actions && <div style={styles.headActions}>{actions}</div>}
    </div>
  );
}

function PSCard({ title, desc, children, mock }: { title?: string; desc?: string; children: React.ReactNode; mock?: boolean }) {
  return (
    <div style={styles.card}>
      {(title || desc || mock) && (
        <div style={styles.cardHeader}>
          <div style={{ flex: 1 }}>
            {(title || mock) && (
              <div style={styles.cardTitle}>
                {title ?? ''}
                {mock && <span style={{ ...styles.uiOnlyBadge, marginLeft: title ? 8 : 0 }}>UI only</span>}
              </div>
            )}
            {desc && <div style={styles.cardDesc}>{desc}</div>}
          </div>
        </div>
      )}
      <div style={styles.cardBody}>{children}</div>
    </div>
  );
}

function PSRow({ label, hint, children, vertical }: { label: string; hint?: string; children: React.ReactNode; vertical?: boolean }) {
  if (vertical) {
    return (
      <div style={styles.rowVertical}>
        <div style={styles.rowLabelText}>{label}</div>
        {hint && <div style={styles.rowHint}>{hint}</div>}
        <div style={{ ...styles.rowControl, marginTop: 8 }}>{children}</div>
      </div>
    );
  }
  return (
    <div style={styles.row}>
      <div style={styles.rowLabel}>
        <div style={styles.rowLabelText}>{label}</div>
        {hint && <div style={styles.rowHint}>{hint}</div>}
      </div>
      <div style={styles.rowControl}>{children}</div>
    </div>
  );
}

function PSInput({
  value,
  onChange,
  readOnly,
  mono,
  suffix,
  width,
}: {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  mono?: boolean;
  suffix?: string;
  width?: number;
}) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...(width ? { width } : { width: '100%' }) }}>
      <input
        value={value}
        readOnly={readOnly || !onChange}
        onChange={(e) => onChange?.(e.target.value)}
        style={{
          ...styles.input,
          fontFamily: mono ? 'var(--mono)' : 'inherit',
          color: readOnly || !onChange ? 'var(--text-3)' : 'var(--text)',
          background: readOnly || !onChange ? 'var(--panel-2)' : 'var(--panel)',
          flex: 1,
        }}
      />
      {suffix && <span style={styles.inputSuffix}>{suffix}</span>}
    </div>
  );
}

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      onClick={() => { if (!disabled) onChange(!on); }}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: 0,
        background: 'transparent',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 11.5, color: on ? 'var(--text)' : 'var(--text-3)',
        fontFamily: 'var(--mono)',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <span style={{
        width: 22, height: 12, borderRadius: 7,
        background: on ? 'var(--text-2)' : 'var(--border-strong)',
        position: 'relative', display: 'inline-block',
      }}>
        <span style={{
          position: 'absolute', top: 1, left: on ? 11 : 1,
          width: 10, height: 10, borderRadius: '50%', background: '#fff',
          transition: 'left .15s',
        }} />
      </span>
      {label && <span>{label}</span>}
    </button>
  );
}

/* ─── Styles ─────────────────────────────────────────────── */

const emptyStyles: Record<string, React.CSSProperties> = {
  header: { marginBottom: 18 },
  h1: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: -0.2 },
  subtitle: { margin: '4px 0 0', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  empty: {
    background: 'var(--panel)',
    border: '1px dashed var(--border-strong)',
    borderRadius: 6,
    padding: '50px 24px',
    textAlign: 'center',
  },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6 },
  emptyHint: { fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginBottom: 10 },
  emptyNote: { marginTop: 16, fontSize: 11, color: 'var(--text-4)' },
};

const styles: Record<string, React.CSSProperties> = {
  /* layout */
  wrap: { display: 'flex', minHeight: '100%', height: '100%', margin: -18, background: 'var(--bg)', alignItems: 'stretch' },
  aside: {
    width: 220, minWidth: 220,
    borderRight: '1px solid var(--border)',
    background: 'var(--panel)',
    padding: '10px 0',
    overflow: 'auto',
    alignSelf: 'stretch',
    minHeight: 'calc(100vh - 122px)',
  },
  asideHeader: {
    padding: '4px 14px 6px',
    fontSize: 10, fontFamily: 'var(--mono)',
    color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.7,
  },
  asideItem: {
    padding: '7px 14px 8px',
    cursor: 'pointer',
    transition: 'background .08s',
  },
  asideItemLabel: { fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  asideItemDesc: {
    fontSize: 10,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    marginTop: 2,
    lineHeight: 1.4,
    wordBreak: 'break-word',
  },
  content: { flex: 1, minWidth: 0, overflow: 'auto', padding: '18px 26px 40px' },

  /* head */
  head: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  headTitle: { margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text)', letterSpacing: -0.2 },
  headDesc: { fontSize: 11.5, color: 'var(--text-3)', marginTop: 3 },
  headActions: { display: 'flex', alignItems: 'center', gap: 8 },

  /* card */
  card: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    marginBottom: 14,
    overflow: 'hidden',
  },
  amberCard: {
    background: 'var(--amber-50)',
    border: '1px solid var(--amber)',
    borderRadius: 4,
    marginBottom: 14,
    padding: '12px 14px',
  },
  amberCardTitle: { fontSize: 12, fontWeight: 600, marginBottom: 3 },
  amberCardDesc: { fontSize: 11, color: 'var(--text-2)' },
  cardHeader: {
    padding: '10px 14px 9px',
    borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', gap: 10,
  },
  cardTitle: { fontSize: 12, fontWeight: 600, color: 'var(--text)' },
  cardDesc: { fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 },
  cardBody: { padding: '12px 14px' },
  csvPathRowLabel: { fontSize: 11.5, fontWeight: 500, color: 'var(--text)', marginBottom: 6 },
  csvPathActions: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 10 },

  /* collapse card */
  collapseCard: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 4, marginBottom: 14, overflow: 'hidden',
  },
  collapseHeader: {
    padding: '10px 14px',
    display: 'flex', alignItems: 'center', gap: 10,
    cursor: 'pointer',
  },

  /* row */
  row: {
    display: 'grid',
    gridTemplateColumns: '180px 1fr',
    gap: 14,
    padding: '7px 0',
    borderBottom: '1px dashed var(--border)',
    alignItems: 'center',
  },
  rowLabel: {},
  rowLabelText: { fontSize: 11.5, fontWeight: 500, color: 'var(--text)' },
  rowHint: { fontSize: 10.5, color: 'var(--text-3)', marginTop: 2, fontFamily: 'var(--mono)' },
  rowControl: { display: 'flex', alignItems: 'center', gap: 8 },
  rowVertical: {
    display: 'flex',
    flexDirection: 'column',
    padding: '7px 0',
    borderBottom: '1px dashed var(--border)',
  },

  /* input */
  input: {
    height: 24, padding: '0 8px',
    border: '1px solid var(--border)',
    borderRadius: 3,
    fontSize: 11.5,
    color: 'var(--text)',
    background: 'var(--panel)',
    outline: 'none',
  },
  inputSuffix: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  inputInline: {
    flex: 1, height: 24, padding: '0 8px',
    border: '1px solid var(--border)', borderRadius: 3,
    background: 'var(--panel)', fontFamily: 'var(--mono)',
    fontSize: 11.5, color: 'var(--text)',
  },
  select: {
    height: 24, padding: '0 8px',
    border: '1px solid var(--border)', borderRadius: 3,
    background: 'var(--panel)', fontFamily: 'var(--mono)',
    fontSize: 11.5, color: 'var(--text)',
  },
  envChip: {
    display: 'inline-block',
    padding: '2px 10px',
    fontSize: 11, fontFamily: 'var(--mono)',
    background: 'var(--green-50)', color: 'var(--green)',
    border: '1px solid var(--green)', borderRadius: 3,
    textTransform: 'uppercase', letterSpacing: 0.4,
  },
  envChipOff: {
    display: 'inline-block',
    padding: '2px 10px',
    fontSize: 11, fontFamily: 'var(--mono)',
    background: 'var(--red-50)', color: 'var(--red)',
    border: '1px solid var(--red)', borderRadius: 3,
    textTransform: 'uppercase', letterSpacing: 0.4,
  },
  staticText: {
    fontSize: 11.5,
    color: 'var(--text-2)',
    fontFamily: 'var(--mono)',
  },
  phaseSelect: {
    padding: '4px 10px',
    border: '1px solid var(--amber)',
    borderRadius: 3,
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    fontSize: 11.5,
    fontWeight: 600,
    fontFamily: 'var(--mono)',
    cursor: 'pointer',
  },

  /* buttons */
  btnPrimary: {
    padding: '4px 14px',
    background: 'var(--navy)', color: '#fff',
    border: '1px solid var(--navy)', borderRadius: 3,
    fontSize: 11.5, fontWeight: 500, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnSecondary: {
    padding: '4px 12px',
    background: 'var(--panel)', color: 'var(--text)',
    border: '1px solid var(--border-strong)', borderRadius: 3,
    fontSize: 11.5, fontWeight: 500, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnGhost: {
    padding: '4px 12px',
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border-strong)', borderRadius: 3,
    fontSize: 11.5, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnDanger: {
    padding: '4px 14px',
    background: 'var(--panel)', color: 'var(--red)',
    border: '1px solid var(--red)', borderRadius: 3,
    fontSize: 11.5, fontWeight: 500, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  btnXs: {
    border: '1px solid var(--border)', background: 'var(--panel)',
    color: 'var(--text-2)', cursor: 'pointer',
    fontSize: 10.5, fontFamily: 'var(--mono)',
    padding: '0 8px', height: 24, borderRadius: 3,
  },
  btnLockIcon: {
    width: 26, height: 26,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid var(--green)', background: 'var(--panel)',
    cursor: 'pointer', borderRadius: 3,
    padding: 0,
    flexShrink: 0,
  },
  btnLink: {
    border: 'none', background: 'transparent',
    color: 'var(--navy)', cursor: 'pointer',
    fontSize: 11, textDecoration: 'underline',
  },
  savedMsg: {
    fontSize: 11, color: 'var(--green)', fontFamily: 'var(--mono)',
  },
  uiOnlyBadge: {
    display: 'inline-block',
    padding: '1px 7px',
    fontSize: 9.5,
    fontFamily: 'var(--mono)',
    fontWeight: 700,
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    border: '1px solid var(--amber)',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  },

  /* status / badges */
  statusCard: {
    border: '1px solid', borderRadius: 4,
    padding: '10px 14px', marginBottom: 14,
    display: 'flex', alignItems: 'center', gap: 12,
  },
  statusDot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
  statusBadgeOk: {
    display: 'inline-block', padding: '1px 7px', fontSize: 10,
    fontFamily: 'var(--mono)', fontWeight: 700,
    background: 'var(--green-50)', color: 'var(--green)',
    border: '1px solid var(--green)', borderRadius: 3,
  },
  statusBadgeWarn: {
    display: 'inline-block', padding: '1px 7px', fontSize: 10,
    fontFamily: 'var(--mono)', fontWeight: 700,
    background: 'var(--amber-50)', color: 'var(--amber)',
    border: '1px solid var(--amber)', borderRadius: 3,
  },
  statusBadgeQueued: {
    display: 'inline-block', padding: '1px 7px', fontSize: 10,
    fontFamily: 'var(--mono)', fontWeight: 700,
    background: 'var(--panel-2)', color: 'var(--text-3)',
    border: '1px solid var(--border-strong)', borderRadius: 3,
  },

  /* DDL list */
  ddlList: { margin: 0, padding: 0, listStyle: 'none' },
  ddlItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 16px',
    borderTop: '1px solid var(--border)',
    fontSize: 12,
  },
  ddlIcon: { color: 'var(--navy)', display: 'inline-flex' },
  ddlName: { flex: 1, color: 'var(--text)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  ddlSize: { width: 70, textAlign: 'right', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  ddlDate: { width: 95, textAlign: 'right', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  ddlRemoveBtn: {
    width: 22, height: 22, background: 'transparent', border: 'none',
    color: 'var(--text-3)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0,
  },

  /* credentials */
  pwDisplay: {
    flex: 1, fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-2)',
    padding: '3px 8px', background: 'var(--panel-2)',
    border: '1px solid var(--border)', borderRadius: 3,
  },

  /* schedule */
  warnBox: {
    padding: 10,
    border: '1px solid var(--amber)', background: 'var(--amber-50)',
    borderRadius: 3, fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.6,
  },
  warnTitle: { fontWeight: 600, color: 'var(--amber)', marginBottom: 4 },
  cliBlock: {
    padding: 10, margin: 0,
    background: '#0e1a2b', color: '#cad7e8',
    fontFamily: 'var(--mono)', fontSize: 11, borderRadius: 3, lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
  },

  /* notifications */
  infoBox: {
    padding: '10px 14px', marginBottom: 14,
    border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--panel-2)',
    fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.6,
  },
  notifyRow: {
    display: 'grid', gridTemplateColumns: '1fr auto',
    alignItems: 'center', gap: 14,
    padding: '8px 0',
  },

  /* danger zone */
  dangerCard: {
    border: '1px solid var(--red)', borderRadius: 4,
    background: 'var(--panel)', marginBottom: 10,
    overflow: 'hidden',
  },
  dangerRow: {
    padding: '10px 14px', background: 'var(--red-50)',
    display: 'flex', alignItems: 'center', gap: 12,
  },
  dangerTitle: { fontSize: 12, fontWeight: 600, color: 'var(--red)' },
  dangerDesc: { fontSize: 10.5, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.5 },
  coordOnlyTag: {
    padding: '3px 8px',
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    border: '1px solid var(--amber)',
    borderRadius: 3,
    whiteSpace: 'nowrap',
  },

  /* modal */
  modalOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(20,30,50,.35)',
    display: 'grid', placeItems: 'center', zIndex: 2000,
  },
  modal: {
    width: 460, background: 'var(--panel)',
    border: '1px solid var(--border)', borderRadius: 6,
    boxShadow: '0 20px 60px rgba(20,30,50,.25)', overflow: 'hidden',
  },
  modalHeader: {
    padding: '14px 18px 10px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--red-50)',
  },
  modalList: { margin: '4px 0 0 18px', padding: 0, fontSize: 11, color: 'var(--text-2)', lineHeight: 1.7 },
  modalBody: { padding: '14px 18px' },
  modalFooter: {
    padding: '10px 14px',
    borderTop: '1px solid var(--border)',
    background: 'var(--panel-2)',
    display: 'flex', justifyContent: 'flex-end', gap: 6,
  },
  confirmCode: {
    background: 'var(--panel-2)', padding: '1px 6px',
    borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 11,
  },
  confirmTextInput: {
    width: '100%', height: 28, padding: '0 10px',
    border: '1px solid var(--border)', borderRadius: 3,
    fontFamily: 'var(--mono)', fontSize: 12,
    background: 'var(--panel)', color: 'var(--text)',
    outline: 'none',
  },
};
