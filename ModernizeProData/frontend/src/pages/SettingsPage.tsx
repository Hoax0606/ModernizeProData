import { useMemo, useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore, type DdlFile, type Project, type ProjectPhase, type Site } from '../store/workspace';
import { useSnapshotsStore, type SnapshotStatus, type SnapshotType } from '../store/snapshots';
import { projectApi } from '../api/workspace';
import { useAuthStore } from '../store/auth';
import { DdlSchemaPanel } from '../components/DdlSchemaPanel';
import { useT } from '../i18n';

/** AppShell 의 AS-IS/TO-BE 램프 클릭 → navigate(..., { state: { highlightSide } }) 로 전달. */
type HighlightSide = 'asis' | 'tobe';
interface HighlightState { highlightSide?: HighlightSide }

const ALL_PHASES: ProjectPhase[] = ['planning', 'analysis', 'test', 'sign-off', 'rehearsal', 'ready', 'cutover', 'hypercare', 'done'];

type SectionKey = 'general' | 'source' | 'target' | 'snapshots' | 'schedule' | 'notify' | 'danger';

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
  // 해당 섹션으로 자동 이동 + 1초 amber pulse.
  useEffect(() => {
    const state = location.state as HighlightState | null;
    const side = state?.highlightSide;
    if (!side) return;
    setSection(side === 'asis' ? 'source' : 'target');
    setHighlightSide(side);
    const t = window.setTimeout(() => setHighlightSide(null), 1000);
    // location.state 를 history 에서 비워두 — 같은 페이지 재진입 시 재발 방지.
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
    { k: 'general',  l: 'General',       d: '프로젝트 이름·환경·생성일' },
    { k: 'source',   l: 'AS-IS',         d: 'AS-IS DDL · 추출 데이터 · 도구 내장 DB' },
    { k: 'target',   l: 'TO-BE',         d: '대상 DB · 인코딩 · 자격증명' },
    { k: 'snapshots', l: 'Snapshots',    d: '매핑 스냅샷 버전 관리 · 승인 플로우' },
    { k: 'schedule', l: 'Schedule',      d: '야간 리허설 · 컷오버 · 외부 트리거' },
    { k: 'notify',   l: 'Notifications', d: '인앱 알림 이벤트 구독' },
    { k: 'danger',   l: 'Danger zone',   d: '프로젝트 삭제 등 위험 동작', danger: true },
  ];

  return (
    <div style={styles.wrap}>
      <aside style={styles.aside}>
        <div style={styles.asideHeader}>Project settings</div>
        {sections.map((s) => {
          const active = s.k === section;
          return (
            <div
              key={s.k}
              onClick={() => setSection(s.k)}
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
        {section === 'source'    && <PSSource    project={project} />}
        {section === 'target'    && <PSTarget    project={project} />}
        {section === 'snapshots' && <PSSnapshots project={project} />}
        {section === 'schedule'  && <PSSchedule  project={project} />}
        {section === 'notify'    && <PSNotify    />}
        {section === 'danger'    && <PSDanger    project={project} />}
      </div>
    </div>
  );
}

/* ─── General ────────────────────────────────────────────── */

function PSGeneral({ project, site }: { project: Project; site: Site | null }) {
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const dirty = name !== project.name;

  const handleSave = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      await projectApi.update(project.id, { name });
      await useWorkspaceStore.getState().fetchSites();
      const siteId = useWorkspaceStore.getState().activeSiteId;
      if (siteId) await useWorkspaceStore.getState().fetchProjects(siteId);
      setSavedMsg('Saved');
      setTimeout(() => setSavedMsg(null), 1500);
    } catch (e) {
      console.error('[settings] save name failed', e);
      setSavedMsg('Failed');
      setTimeout(() => setSavedMsg(null), 1800);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PSHead
        title="General"
        desc="이 프로젝트의 기본 메타정보."
        actions={
          <>
            {savedMsg && <span style={styles.savedMsg}>{savedMsg}</span>}
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              style={{ ...styles.btnPrimary, ...((!dirty || saving) ? styles.btnDisabled : {}) }}
            >
              {saving ? '저장 중…' : '저장'}
            </button>
          </>
        }
      />
      <PSCard>
        <PSRow label="프로젝트 이름">
          <PSInput value={name} onChange={setName} />
        </PSRow>
        <PSRow label="고객사" hint="이 프로젝트가 속한 사이트.">
          <PSInput value={site?.name ?? '—'} readOnly mono />
        </PSRow>
        <PSRow label="환경 라벨" hint="사이트의 운영 단계 (Site settings 에서 변경).">
          <span style={styles.envChip}>{site?.environment ?? '—'}</span>
        </PSRow>
        <PSRow label="생성일">
          <PSInput value={new Date(project.createdAt).toLocaleString()} readOnly mono />
        </PSRow>
      </PSCard>

      <PSCard title="Phase (dev/test only)" desc="테스트용 phase 수동 변경. 운영 시 제거 예정.">
        <PSRow label="Current phase">
          <select
            value={project.phase}
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
            style={styles.phaseSelect}
          >
            {ALL_PHASES.map((ph) => <option key={ph} value={ph}>{ph}</option>)}
          </select>
        </PSRow>
      </PSCard>
    </>
  );
}

/* ─── AS-IS (Source) ─────────────────────────────────────── */

function PSSource({ project, highlight }: { project: Project; highlight?: boolean }) {
  return (
    <>
      <PSHead title="AS-IS" desc="AS-IS DDL · 야간 추출 데이터 · 도구 내장 DB." />
      <DdlCard project={project} side="asis" highlight={highlight} />
      <CsvSourceCard />
      <StagingCard />
    </>
  );
}

function CsvSourceCard() {
  return (
    <div style={styles.amberCard}>
      <div style={styles.amberCardTitle}>
        AS-IS 추출 데이터 (CSV)
        <span style={{ ...styles.uiOnlyBadge, marginLeft: 8 }}>UI only</span>
      </div>
      <div style={styles.amberCardDesc}>
        추출 파일이 아직 등록되지 않았습니다. 운영팀의 야간 추출 파일 경로를 등록하면 도착 후 자동으로 파싱됩니다.
      </div>
    </div>
  );
}

function StagingCard() {
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={{ flex: 1 }}>
          <div style={styles.cardTitle}>
            <span style={{ marginRight: 6 }}>📦</span>
            AS-IS DB (도구 내장)
            <span style={{ ...styles.uiOnlyBadge, marginLeft: 8 }}>UI only</span>
          </div>
          <div style={styles.cardDesc}>
            추출된 CSV 를 원본 그대로 적재하는 임베디드 DB — 호스트·자격증명 설정 없이 도구가 알아서 처리합니다.
          </div>
        </div>
      </div>
      <div style={{ padding: '14px 16px', fontSize: 11.5, color: 'var(--text-3)' }}>
        AS-IS DB 가 아직 초기화되지 않았습니다. 추출 데이터(CSV) 도착 후 자동으로 적재됩니다.
      </div>
    </div>
  );
}

/* ─── TO-BE (Target) ─────────────────────────────────────── */

function PSTarget({ project, highlight }: { project: Project; highlight?: boolean }) {
  /* mock state — connection/credentials 는 Project 엔티티에 없음 */
  const [host, setHost] = useState('pg-core-01.kdb.internal:5432');
  const [database, setDatabase] = useState('core_banking');
  const [schema, setSchema] = useState('public');
  const [encoding, setEncoding] = useState('UTF-8');
  const [collation, setCollation] = useState('ko_KR.UTF-8');
  const [connStatus, setConnStatus] = useState<'untested' | 'testing' | 'ok' | 'failed'>('untested');
  const [lastTestedAt, setLastTestedAt] = useState<string | null>(null);

  const handleTest = async () => {
    setConnStatus('testing');
    /* mock — 실제론 Worker 노드로 위임할 endpoint */
    await new Promise((r) => setTimeout(r, 900));
    setConnStatus('ok');
    setLastTestedAt(new Date().toLocaleTimeString());
  };

  return (
    <>
      <PSHead
        title="TO-BE"
        desc="이행 대상 데이터베이스."
        actions={
          <button
            onClick={handleTest}
            disabled={connStatus === 'testing'}
            style={{ ...styles.btnSecondary, ...(connStatus === 'testing' ? styles.btnDisabled : {}) }}
          >
            {connStatus === 'testing' ? '연결 테스트 중…' : '연결 테스트'}
          </button>
        }
      />
      <PSCard title="Database connection" desc="대상 DB 접속 정보. Worker 노드가 이 설정으로 연결합니다." mock>
        <PSRow label="DB 종류"><PSInput value="PostgreSQL 18" readOnly mono /></PSRow>
        <PSRow label="호스트"><PSInput value={host} onChange={setHost} mono /></PSRow>
        <PSRow label="데이터베이스"><PSInput value={database} onChange={setDatabase} mono /></PSRow>
        <PSRow label="스키마"><PSInput value={schema} onChange={setSchema} mono /></PSRow>
        <PSRow label="인코딩"><PSInput value={encoding} onChange={setEncoding} mono /></PSRow>
        <PSRow label="콜레이션"><PSInput value={collation} onChange={setCollation} mono /></PSRow>
        <PSRow label="SSL 모드"><PSInput value="verify-full · corp-ca-2024" readOnly mono /></PSRow>
      </PSCard>

      <ConnectionStatusCard status={connStatus} lastTestedAt={lastTestedAt} onRetry={handleTest} />

      <CredsCard />

      <DdlCard project={project} side="tobe" highlight={highlight} />
    </>
  );
}

function ConnectionStatusCard({
  status,
  lastTestedAt,
  onRetry,
}: {
  status: 'untested' | 'testing' | 'ok' | 'failed';
  lastTestedAt: string | null;
  onRetry: () => void;
}) {
  const tone =
    status === 'ok' ? 'green' :
    status === 'failed' ? 'red' :
    status === 'testing' ? 'amber' : 'gray';
  const palette =
    tone === 'green' ? { bg: 'var(--green-50)', bd: 'var(--green)', fg: 'var(--green)' } :
    tone === 'red'   ? { bg: 'var(--red-50)',   bd: 'var(--red)',   fg: 'var(--red)' } :
    tone === 'amber' ? { bg: 'var(--amber-50)', bd: 'var(--amber)', fg: 'var(--amber)' } :
                       { bg: 'var(--panel-2)',  bd: 'var(--border)', fg: 'var(--text-3)' };
  const label =
    status === 'ok' ? 'Connected' :
    status === 'failed' ? 'Connection failed' :
    status === 'testing' ? 'Testing…' : 'Not tested';

  return (
    <div style={{ ...styles.statusCard, background: palette.bg, borderColor: palette.bd }}>
      <span style={{ ...styles.statusDot, background: palette.fg }} />
      <span style={{ fontSize: 12, fontWeight: 600, color: palette.fg }}>{label}</span>
      <span style={styles.uiOnlyBadge}>UI only</span>
      <div style={{ flex: 1, fontSize: 11.5, color: 'var(--text-2)', fontFamily: 'var(--mono)' }}>
        {status === 'ok' && lastTestedAt && <>last tested {lastTestedAt}</>}
        {status === 'untested' && <>아직 연결을 테스트하지 않았습니다. [연결 테스트] 로 검증하세요.</>}
        {status === 'testing' && <>연결을 확인하는 중입니다…</>}
        {status === 'failed' && <>연결 실패</>}
      </div>
      {status === 'failed' && (
        <button onClick={onRetry} style={styles.btnSecondary}>Retry</button>
      )}
    </div>
  );
}

function CredsCard() {
  const [username, setUsername] = useState('app_ops');
  const [authMethod, setAuthMethod] = useState<'password' | 'kerberos' | 'ssh_key' | 'cert'>('password');
  const [passwordSet, setPasswordSet] = useState(true);
  const [showPw, setShowPw] = useState(false);
  const [editingPw, setEditingPw] = useState(false);
  const [newPw, setNewPw] = useState('');

  const commitPw = () => {
    if (newPw) setPasswordSet(true);
    setEditingPw(false);
    setNewPw('');
  };

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={{ flex: 1 }}>
          <div style={styles.cardTitle}>
            Credentials
            <span style={{ ...styles.uiOnlyBadge, marginLeft: 8 }}>UI only</span>
          </div>
          <div style={styles.cardDesc}>
            로그인 정보와 인증 방식. 자격증명은 이 프로젝트에만 적용됩니다.
          </div>
        </div>
        <button
          onClick={() => setPasswordSet(true)}
          style={styles.btnGhost}
        >
          Rotate password
        </button>
      </div>

      <div style={styles.cardBody}>
        <PSRow label="Username"><PSInput value={username} onChange={setUsername} mono /></PSRow>
        <PSRow label="Auth method">
          <select
            value={authMethod}
            onChange={(e) => setAuthMethod(e.target.value as typeof authMethod)}
            style={styles.select}
          >
            <option value="password">Password</option>
            <option value="kerberos">Kerberos</option>
            <option value="ssh_key">SSH key</option>
            <option value="cert">Certificate</option>
          </select>
        </PSRow>
        {authMethod === 'password' && (
          <PSRow label="Password" hint={passwordSet ? 'set' : 'not set'}>
            {editingPw ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  autoFocus
                  type={showPw ? 'text' : 'password'}
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  onBlur={commitPw}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitPw();
                    if (e.key === 'Escape') { setEditingPw(false); setNewPw(''); }
                  }}
                  placeholder="new password"
                  style={{ ...styles.inputInline, borderColor: 'var(--navy)' }}
                />
                <button onClick={() => setShowPw((s) => !s)} style={styles.btnXs}>{showPw ? 'Hide' : 'Show'}</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={styles.pwDisplay}>
                  {passwordSet ? (showPw ? '(mock) ops-pw-23f!' : '••••••••••') : <span style={{ color: 'var(--text-4)' }}>not set</span>}
                </span>
                <button onClick={() => setShowPw((s) => !s)} style={styles.btnXs}>{showPw ? 'Hide' : 'Show'}</button>
                <button
                  onClick={() => { setEditingPw(true); setNewPw(''); setShowPw(false); }}
                  style={styles.btnLink}
                >
                  Change…
                </button>
              </div>
            )}
          </PSRow>
        )}
        {authMethod === 'kerberos' && (
          <PSRow label="Principal"><PSInput value="app_ops@KDB.CORP" mono /></PSRow>
        )}
        {authMethod === 'ssh_key' && (
          <PSRow label="Private key" hint="대화형 발급 흐름은 V1 예정">
            <PSInput value="~/.ssh/mig-ops.key" mono readOnly />
          </PSRow>
        )}
        {authMethod === 'cert' && (
          <PSRow label="Certificate"><PSInput value="/etc/mig/certs/app_ops.pem" mono readOnly /></PSRow>
        )}
      </div>
    </div>
  );
}

/* ─── DDL card — Source / Target 공용 ────────────────────── */

function DdlCard({ project, side, highlight }: { project: Project; side: 'asis' | 'tobe'; highlight?: boolean }) {
  return <DdlSchemaPanel project={project} side={side} highlight={highlight} />;
}

/* ─── Schedule ───────────────────────────────────────────── */

function PSSchedule({ project }: { project: Project }) {
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
        desc="Nightly rehearsal 자동 실행 · 컷오버 D-day · 외부 스케줄러 연동 옵션"
        actions={<button style={styles.btnPrimary} disabled>Save changes</button>}
        mock
      />

      <PSCard
        title="Nightly rehearsal"
        desc="매일 정해진 시각에 dry-run rehearsal 을 자동 실행합니다. Control-M 같은 외부 스케줄러가 있는 환경에서는 비활성화하고 CLI 트리거를 쓰세요."
      >
        <PSRow label="Enabled" hint={rehearsalOn ? '활성화됨 — 매일 밤 자동 실행' : '비활성화 — 수동 또는 외부 스케줄러가 트리거'}>
          <Toggle on={rehearsalOn} onChange={setRehearsalOn} label={rehearsalOn ? 'Run every night' : 'Paused'} />
        </PSRow>
        <PSRow label="Start time" hint="타임존은 사이트 설정 기준">
          <PSInput value={startTime} onChange={setStartTime} mono width={140} />
        </PSRow>
        <PSRow label="Max duration" hint="초과 시 자동 abort">
          <PSInput value={maxDuration} onChange={setMaxDuration} mono suffix="minutes" width={120} />
        </PSRow>
        <PSRow label="Next scheduled">
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: rehearsalOn ? 'var(--text-2)' : 'var(--text-4)' }}>
            {rehearsalOn ? `다음 실행 ${startTime}` : '— (disabled)'}
          </span>
        </PSRow>
      </PSCard>

      <PSCard title="Cutover window" desc="고객과 합의된 D-day 및 관련 시간 창.">
        <PSRow label="Planned cutover" hint="이행 실제 실행 일시 (본운영 전환)">
          <PSInput value={cutover.dday ?? 'TBD'} mono />
        </PSRow>
        <PSRow label="Freeze start (T-N hours)" hint="소스 DB 가 read-only 로 전환되는 시점">
          <PSInput value={String(cutover.freezeHours ?? 24)} mono suffix="hours" width={120} />
        </PSRow>
        <PSRow label="Rollback SLA" hint="컷오버 실패 판단 후 구 시스템 복구 완료까지 허용 시간">
          <PSInput value={String(cutover.rollbackSla ?? 15)} mono suffix="minutes" width={120} />
        </PSRow>
      </PSCard>

      <div style={styles.collapseCard}>
        <div onClick={() => setExtOpen((o) => !o)} style={{ ...styles.collapseHeader, background: extOpen ? 'var(--panel-2)' : 'var(--panel)' }}>
          <span style={{ color: 'var(--text-4)', fontSize: 10, width: 10 }}>{extOpen ? '▾' : '▸'}</span>
          <div style={{ flex: 1 }}>
            <div style={styles.cardTitle}>External trigger (선택)</div>
            <div style={styles.cardDesc}>
              Control-M · Jenkins · Airflow 등 기존 사내 스케줄러에서 이 프로젝트를 트리거하는 방법
            </div>
          </div>
          <span style={styles.statusBadgeQueued}>optional</span>
        </div>
        {extOpen && (
          <div style={{ padding: '14px 16px' }}>
            <div style={styles.warnBox}>
              <div style={styles.warnTitle}>⚠ 사전 조건 — Solution Settings 에서 활성화 필요</div>
              External trigger 는 솔루션 전역 기능이라 <b>Solution Settings › External integrations</b> 에서 먼저 토글을 켜야 동작합니다. 켜지 않으면 CLI / API endpoint 가 응답하지 않습니다.
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 8, marginTop: 10 }}>
              아래 명령을 외부 스케줄러(Control-M · Airflow · Jenkins · cron)에 등록하면 됩니다.
            </div>
            <pre style={styles.cliBlock}>
{`# 야간 rehearsal (dry-run · TEST 타겟)
migrate run --project ${project.id} --mode rehearsal --dry-run

# 컷오버 (운영 타겟 · 승인된 스냅샷 필요)
migrate run --project ${project.id} --mode cutover

# 롤백
migrate rollback --project ${project.id} --to pre-cutover`}
            </pre>
          </div>
        )}
      </div>
    </>
  );
}

/* ─── Notifications ──────────────────────────────────────── */

function PSNotify() {
  const events = [
    { k: 'run.failed',       l: 'Run failed',          d: 'rehearsal · cutover 실행 실패 시' },
    { k: 'snapshot.pending', l: 'Snapshot pending',    d: '승인 대기 스냅샷이 생성되었을 때' },
    { k: 'snapshot.approved',l: 'Snapshot approved',   d: '내가 요청한 스냅샷이 승인되었을 때' },
    { k: 'snapshot.rejected',l: 'Snapshot rejected',   d: '내가 요청한 스냅샷이 반려되었을 때' },
    { k: 'cutover.started',  l: 'Cutover started',     d: 'cutover 가 시작되었을 때' },
    { k: 'cutover.finished', l: 'Cutover finished',    d: 'cutover 가 완료되었을 때' },
  ];

  const [subs, setSubs] = useState<Record<string, boolean>>(() => {
    const o: Record<string, boolean> = {};
    events.forEach((e) => { o[e.k] = true; });
    return o;
  });

  return (
    <>
      <PSHead
        title="Notifications"
        desc="In-app inbox · 닫힌 네트워크에서는 유일한 기본 채널입니다."
        actions={<button style={styles.btnPrimary} disabled>Save changes</button>}
        mock
      />

      <div style={styles.infoBox}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>📬 In-app notification inbox</div>
        외부 Slack / Email / Webhook 은 폐쇄망에서는 쓸 수 없으므로, 모든 알림은 상단의 🔔 Bell 아이콘을 통해 수신됩니다.
      </div>

      <PSCard title="이벤트 구독" desc="알림으로 받을 이벤트를 선택합니다.">
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
            <Toggle on={subs[e.k]} onChange={() => setSubs((s) => ({ ...s, [e.k]: !s[e.k] }))} label="" />
          </div>
        ))}
      </PSCard>

      <PSCard title="수신자 옵션" desc="이 프로젝트에 관한 알림을 받는 범위.">
        <PSRow label="Scope" hint="본인이 관여한 활동만 받을지, 프로젝트 전체 이벤트를 받을지">
          <div style={{ display: 'flex', gap: 5 }}>
            {[
              { k: 'mine-only',   l: 'My activity only' },
              { k: 'all-project', l: 'All project events' },
            ].map((opt) => {
              const active = opt.k === 'all-project';
              return (
                <button
                  key={opt.k}
                  style={{
                    padding: '3px 12px', fontSize: 11, fontFamily: 'var(--mono)',
                    border: `1px solid ${active ? 'var(--navy)' : 'var(--border)'}`,
                    background: active ? 'var(--navy)' : 'var(--panel)',
                    color: active ? '#fff' : 'var(--text-2)',
                    borderRadius: 3, cursor: 'pointer',
                  }}
                >
                  {opt.l}
                </button>
              );
            })}
          </div>
        </PSRow>
        <PSRow label="Retention" hint="알림이 inbox 에 유지되는 기간">
          <PSInput value="90 days" mono width={160} />
        </PSRow>
      </PSCard>
    </>
  );
}

/* ─── Snapshots ─────────────────────────────────────────── */

function PSSnapshots({ project }: { project: Project }) {
  const user = useAuthStore((s) => s.user);
  const allSnapshots = useSnapshotsStore((s) => s.snapshots);
  const fetchByProject = useSnapshotsStore((s) => s.fetchByProject);
  const snapshots = useMemo(
    () => allSnapshots.filter((s) => s.projectId === project.id).slice().reverse(),
    [allSnapshots, project.id],
  );
  const createSnapshot = useSnapshotsStore((s) => s.createSnapshot);
  const requestSnapshot = useSnapshotsStore((s) => s.requestSnapshot);
  const deleteSnapshot = useSnapshotsStore((s) => s.deleteSnapshot);

  // 마운트 시 + 프로젝트 변경 시 서버에서 fetch
  useEffect(() => {
    if (project.id) void fetchByProject(project.id);
  }, [project.id, fetchByProject]);

  // UI 상태
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);

  const selectedSnapshot = useMemo(
    () => snapshots.find((s) => s.id === selectedSnapshotId) ?? null,
    [snapshots, selectedSnapshotId],
  );

  // 첫 번째 스냅샷을 기본 선택
  useEffect(() => {
    if (snapshots.length > 0 && !selectedSnapshotId) {
      setSelectedSnapshotId(snapshots[0].id);
    }
  }, [snapshots, selectedSnapshotId]);

  const resetCreate = () => {
    setCreateOpen(false);
    setNewName('');
    setNewDesc('');
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const newSnapshot = await createSnapshot(project.id, {
      name,
      description: newDesc.trim() || undefined,
      tableCount: project.tableCount,
      ruleCount: 0,
    });
    setSelectedSnapshotId(newSnapshot.id);
    resetCreate();
  };

  const handleRequest = async (id: string) => {
    await requestSnapshot(id);
    setRequestId(null);
  };

  function statusTone(s: SnapshotStatus): React.CSSProperties {
    switch (s) {
      case 'draft':    return { background: 'var(--panel-2)', color: 'var(--text-3)', borderColor: 'var(--border-strong)' };
      case 'pending':  return { background: 'var(--amber-50)', color: 'var(--amber)', borderColor: 'var(--amber)' };
      case 'approved': return { background: 'var(--green-50)', color: 'var(--green)', borderColor: 'var(--green)' };
      case 'rejected': return { background: 'var(--red-50)',   color: 'var(--red)',   borderColor: 'var(--red)' };
    }
  }

  return (
    <>
      <PSHead
        title="Snapshots"
        desc="매핑 스냅샷 버전 관리. v1.0 부터 시작해서 자동으로 버전이 증가합니다."
        actions={
          <button onClick={() => setCreateOpen(!createOpen)} style={styles.btnPrimary}>
            {createOpen ? 'Cancel' : '+ Create snapshot'}
          </button>
        }
      />

      {createOpen && (
        <form onSubmit={handleCreate} style={styles.snapshotCreateForm}>
          <div style={styles.snapshotCreateTitle}>New snapshot</div>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Split customer into customer + customer_contact, unified transaction tables"
            style={styles.snapshotCreateInput}
            autoFocus
            required
          />
          <textarea
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            style={styles.snapshotCreateTextarea}
          />
          <div style={styles.snapshotCreateActions}>
            <button type="button" onClick={resetCreate} style={styles.btnGhost}>Cancel</button>
            <button type="submit" style={{ ...styles.btnPrimary, ...(newName.trim() ? {} : styles.btnDisabled) }} disabled={!newName.trim()}>
              Create
            </button>
          </div>
        </form>
      )}

      <div style={styles.snapshotsContainer}>
        {/* 왼쪽: 스냅샷 목록 */}
        <div style={styles.snapshotsList}>
          {snapshots.length === 0 ? (
            <div style={styles.emptySnapshots}>
              <div style={styles.emptySnapshotsTitle}>No snapshots yet</div>
              <div style={styles.emptySnapshotsDesc}>
                Create your first snapshot to start version control
              </div>
            </div>
          ) : (
            snapshots.map((s) => (
              <div
                key={s.id}
                style={{
                  ...styles.snapshotItem,
                  ...(selectedSnapshotId === s.id ? styles.snapshotItemActive : {}),
                }}
                onClick={() => setSelectedSnapshotId(s.id)}
              >
                <div style={styles.snapshotVersion}>
                  <span style={styles.versionText}>{s.version}</span>
                  <span style={{ ...styles.statusBadgeSmall, ...statusTone(s.status) }}>
                    {s.status.toUpperCase()}
                  </span>
                </div>
                <div style={styles.snapshotName}>{s.name}</div>
                <div style={styles.snapshotMeta}>
                  {s.createdBy} · {new Date(s.createdAt).toLocaleDateString()}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 오른쪽: 선택된 스냅샷 상세 */}
        <div style={styles.snapshotDetail}>
          {selectedSnapshot ? (
            <>
              <div style={styles.snapshotDetailHeader}>
                <div>
                  <h3 style={styles.snapshotDetailTitle}>
                    {selectedSnapshot.name}
                    <span style={styles.versionBadge}>{selectedSnapshot.version}</span>
                  </h3>
                  <div style={styles.snapshotDetailMeta}>
                    created {new Date(selectedSnapshot.createdAt).toLocaleString()} by {selectedSnapshot.createdBy}
                  </div>
                </div>
              </div>

              {selectedSnapshot.description && (
                <div style={styles.snapshotDescription}>
                  {selectedSnapshot.description}
                </div>
              )}

              <div style={styles.snapshotStats}>
                <div style={styles.statItem}>
                  <span style={styles.statLabel}>Tables</span>
                  <span style={styles.statValue}>{selectedSnapshot.tableCount}</span>
                </div>
                <div style={styles.statItem}>
                  <span style={styles.statLabel}>Rules</span>
                  <span style={styles.statValue}>{selectedSnapshot.ruleCount}</span>
                </div>
                <div style={styles.statItem}>
                  <span style={styles.statLabel}>Status</span>
                  <span style={{ ...styles.statusBadge, ...statusTone(selectedSnapshot.status) }}>
                    {selectedSnapshot.status.toUpperCase()}
                  </span>
                </div>
              </div>

              {/* Request/Approval 영역 */}
              {requestId === selectedSnapshot.id ? (
                <div style={styles.requestConfirm}>
                  <div style={styles.requestTitle}>Request approval</div>
                  <div style={styles.requestDesc}>
                    Send snapshot <b>{selectedSnapshot.name}</b> for review?
                  </div>
                  <div style={styles.requestActions}>
                    <button onClick={() => setRequestId(null)} style={styles.btnGhost}>Cancel</button>
                    <button onClick={() => handleRequest(selectedSnapshot.id)} style={styles.btnPrimary}>
                      Confirm request
                    </button>
                  </div>
                </div>
              ) : (
                <div style={styles.reviewSection}>
                  {selectedSnapshot.status === 'draft' && (
                    <button onClick={() => setRequestId(selectedSnapshot.id)} style={styles.btnPrimary}>
                      Request changes
                    </button>
                  )}
                  {selectedSnapshot.status === 'pending' && (
                    <div style={styles.pendingReview}>
                      <div style={styles.pendingIcon}>⏳</div>
                      <div>
                        <div style={styles.pendingTitle}>Pending review</div>
                        <div style={styles.pendingDesc}>Waiting for coordinator approval</div>
                      </div>
                    </div>
                  )}
                  {selectedSnapshot.status === 'approved' && selectedSnapshot.approvedBy && (
                    <div style={styles.approvedSection}>
                      <div style={styles.approvedTitle}>✓ Approved</div>
                      <div style={styles.approvedDesc}>
                        by {selectedSnapshot.approvedBy} on {selectedSnapshot.approvedAt && new Date(selectedSnapshot.approvedAt).toLocaleDateString()}
                      </div>
                    </div>
                  )}
                  {selectedSnapshot.status === 'rejected' && (
                    <div style={styles.rejectedSection}>
                      <div style={styles.rejectedTitle}>✗ Rejected</div>
                      <div style={styles.rejectedDesc}>
                        {selectedSnapshot.rejectedBy && <>by {selectedSnapshot.rejectedBy}</>}
                        {selectedSnapshot.rejectionReason && (
                          <div style={styles.rejectionReason}>{selectedSnapshot.rejectionReason}</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div style={styles.noSelection}>
              <div>Select a snapshot to view details</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ─── Danger zone ────────────────────────────────────────── */

function PSDanger({ project }: { project: Project }) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const isMaster = user?.role === 'master';
  const deleteProject = useWorkspaceStore((s) => s.deleteProject);
  const createProject = useWorkspaceStore((s) => s.createProject);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const canDelete = confirmText === project.name;

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

  const handleDuplicate = async () => {
    if (!isMaster) return;
    try {
      await createProject({
        name: `${project.name} (copy)`,
        phase: 'planning',
        tableCount: 0,
        ddlFiles: project.ddlFiles,
        owner: project.owner,
      });
      navigate('/');
    } catch (e) {
      console.error('[settings] duplicate project failed', e);
    }
  };

  return (
    <>
      <PSHead title="Danger zone" desc="Destructive actions. All operations are logged to the audit trail." />

      <div style={styles.dangerCard}>
        <div style={styles.dangerRow}>
          <div style={{ flex: 1 }}>
            <div style={styles.dangerTitle}>Duplicate project</div>
            <div style={styles.dangerDesc}>
              Copy mapping rules and DDL files to a new project. Artifacts and logs are not copied.
            </div>
          </div>
          {isMaster ? (
            <button onClick={handleDuplicate} style={styles.btnSecondary}>Duplicate…</button>
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
            <button onClick={() => setConfirmOpen(true)} style={styles.btnDanger}>Delete project…</button>
          ) : (
            <span style={styles.coordOnlyTag} title="Coordinator only">Coordinator only</span>
          )}
        </div>
      </div>

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

function PSHead({ title, desc, actions, mock }: { title: string; desc: string; actions?: React.ReactNode; mock?: boolean }) {
  return (
    <div style={styles.head}>
      <div style={{ flex: 1 }}>
        <h2 style={styles.headTitle}>
          {title}
          {mock && <span style={{ ...styles.uiOnlyBadge, marginLeft: 10, verticalAlign: 'middle' }}>UI only</span>}
        </h2>
        <div style={styles.headDesc}>{desc}</div>
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

function PSRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '3px 8px',
        background: on ? 'var(--navy-50)' : 'var(--panel)',
        border: `1px solid ${on ? 'var(--navy)' : 'var(--border)'}`,
        borderRadius: 3, cursor: 'pointer',
        fontSize: 11.5, color: on ? 'var(--navy)' : 'var(--text-3)',
        fontFamily: 'var(--mono)',
      }}
    >
      <span style={{
        width: 22, height: 12, borderRadius: 7,
        background: on ? 'var(--navy)' : 'var(--border-strong)',
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  wrap: { display: 'flex', height: '100%', minHeight: 0, margin: -18, background: 'var(--bg)' },
  aside: {
    width: 220, minWidth: 220,
    borderRight: '1px solid var(--border)',
    background: 'var(--panel)',
    padding: '10px 0',
    overflow: 'auto',
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
  asideItemLabel: { fontSize: 12 },
  asideItemDesc: { fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginTop: 2 },
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
    background: 'var(--navy-50)', color: 'var(--navy)',
    border: '1px solid var(--navy)', borderRadius: 3,
    textTransform: 'uppercase', letterSpacing: 0.4,
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
