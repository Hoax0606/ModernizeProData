import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import {
  useWorkspaceStore,
  emptyDbConnection,
  PROJECT_ENVIRONMENTS,
  type Site,
  type SiteEnv,
  type SourceEncoding,
  type SiteDbConnection,
  type ProjectEnvironment,
  type TobeDbByEnv,
  type TobeDbLocks,
} from '../store/workspace';
import { useAuthStore } from '../store/auth';
import { tobeDbApi } from '../api/tobeDb';
import { useT, type TranslationKey } from '../i18n';
import { CsvPathField } from './CsvPathField';
import { TestConnectionResult, type TestStatus } from './TestConnectionResult';
import { LockIcon } from './LockIcon';

function isDbConfigured(c: SiteDbConnection | undefined): boolean {
  if (!c) return false;
  return !!c.type?.trim() && !!c.host?.trim() && !!c.database?.trim() && !!c.username?.trim();
}

function siteInitials(name: string): string {
  if (!name) return '·';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * `highlight` 는 Pre-flight 의 csv-arrived / conn-tobe Fix 클릭으로 모달이 열렸을 때
 * 어느 섹션을 1초 강조할지 지정. AppShell 이 URL `?siteSettings=csv|tobe-db` 를 감지해
 * modal open + 이 prop 을 한 번 set 한 다음 1초 후 null 로 reset 한다.
 */
interface Props {
  open: boolean;
  onClose: () => void;
  highlight?: 'csv' | 'tobe-db' | null;
}

const ENV_OPTIONS: Array<{ value: SiteEnv; key: TranslationKey }> = [
  { value: 'mainframe', key: 'siteEnv.mainframe' },
  { value: 'midrange',  key: 'siteEnv.midrange'  },
  { value: 'cloud',     key: 'siteEnv.cloud'     },
  { value: 'on-prem',   key: 'siteEnv.onprem'    },
  { value: 'other',     key: 'siteEnv.other'     },
];

const ENCODING_OPTIONS: Array<{ value: SourceEncoding; key: TranslationKey }> = [
  { value: 'shift_jis', key: 'encoding.shiftjis' },
  { value: 'euc-jp',    key: 'encoding.eucjp'    },
  { value: 'utf-8',     key: 'encoding.utf8'     },
  { value: 'ebcdic',    key: 'encoding.ebcdic'   },
];

const PROJECT_ENV_LABEL: Record<ProjectEnvironment, TranslationKey> = {
  test:       'projectEnv.test',
  dev:        'projectEnv.dev',
  staging:    'projectEnv.staging',
  production: 'projectEnv.production',
};

const DB_TYPES = ['PostgreSQL', 'Oracle', 'MySQL', 'SQL Server', 'Db2'];
const ASIS_DB_TYPES = ['Oracle', 'DB2', 'Mainframe DB2', 'SQL Server', 'PostgreSQL', 'MySQL', 'Other'];

/**
 * Site settings — name·envs·encoding·notes·운영 단계·TO-BE DB 편집 + 삭제.
 */
export function SiteSettingsModal({ open, onClose, highlight }: Props) {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const isMaster = user?.role === 'master';
  const sites = useWorkspaceStore((s) => s.sites);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const updateSite = useWorkspaceStore((s) => s.updateSite);
  const deleteSite = useWorkspaceStore((s) => s.deleteSite);
  const projects = useWorkspaceStore((s) => s.projects);

  const site: Site | undefined = sites.find((s) => s.id === activeSiteId);
  const projectCount = projects.filter((p) => p.siteId === activeSiteId).length;

  // Pre-flight Fix → csv-arrived / conn-tobe 가 강조할 두 섹션의 ref.
  const csvRef = useRef<HTMLDivElement>(null);
  const tobeDbRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !highlight) return;
    const el = highlight === 'csv' ? csvRef.current : tobeDbRef.current;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [open, highlight]);

  const [name, setName] = useState('');
  const [asisEnv, setAsisEnv] = useState<SiteEnv>('mainframe');
  const [tobeEnv, setTobeEnv] = useState<SiteEnv>('on-prem');
  const [asisEncoding, setAsisEncoding] = useState<SourceEncoding>('shift_jis');
  const [tobeEncoding, setTobeEncoding] = useState<SourceEncoding>('utf-8');
  const [csvPath, setCsvPath] = useState('');
  const [asisDbType, setAsisDbType] = useState('');
  const [asisDbVersion, setAsisDbVersion] = useState('');
  const [stage, setStage] = useState<ProjectEnvironment>('dev');
  const [tobeDbByEnv, setTobeDbByEnv] = useState<TobeDbByEnv>({});
  const [tobeDbLocks, setTobeDbLocks] = useState<TobeDbLocks>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [siteUnlocked, setSiteUnlocked] = useState(false);

  useEffect(() => {
    if (!open || !site) return;
    setName(site.name);
    setAsisEnv(site.asisEnv);
    setTobeEnv(site.tobeEnv);
    setAsisEncoding(site.asisEncoding);
    setTobeEncoding(site.tobeEncoding);
    setCsvPath(site.csvPath ?? '');
    setAsisDbType(site.asisDbType ?? '');
    setAsisDbVersion(site.asisDbVersion ?? '');
    setStage(site.environment);
    setTobeDbByEnv({ ...site.tobeDbByEnv });
    setTobeDbLocks({ ...site.tobeDbLocks });
    setConfirmOpen(false);
    setConfirmText('');
    setTestStatus('idle');
    setTestMessage(null);
    setSiteUnlocked(false);
  }, [open, site]);

  if (!site) return null;

  // 현재 stage 의 DB — 저장된 것이 없거나 일부 필드가 없으면 emptyDbConnection 으로 빈칸 채움.
  // (백엔드 jsonb 에 database 필드가 없던 기존 사이트도 안전하게 로딩되도록.)
  const tobeDb: SiteDbConnection = { ...emptyDbConnection(), ...(tobeDbByEnv[stage] ?? {}) };
  const stageLocked = !!tobeDbLocks[stage];
  const siteEditDisabled = !siteUnlocked;
  const dbFieldsDisabled = stageLocked || siteEditDisabled;

  const patchTobeDb = (patch: Partial<SiteDbConnection>) => {
    if (stageLocked) return;
    setTobeDbByEnv((cur) => ({
      ...cur,
      [stage]: { ...emptyDbConnection(), ...(cur[stage] ?? {}), ...patch },
    }));
    setTestStatus('idle');
    setTestMessage(null);
  };

  const handleTest = async () => {
    if (!site || testStatus === 'testing') return;
    setTestStatus('testing');
    setTestMessage(null);
    try {
      const result = await tobeDbApi.testConnection(site.id, {
        dbType:   tobeDb.type,
        host:     tobeDb.host.trim(),
        port:     tobeDb.port.trim() || '5432',
        database: tobeDb.database.trim(),
        username: tobeDb.username.trim(),
        password: tobeDb.password,
      });
      setTestStatus(result.success ? 'ok' : 'failed');
      setTestMessage(result.message);
    } catch (e) {
      setTestStatus('failed');
      setTestMessage((e as Error)?.message ?? 'Network error');
    }
  };

  const toggleStageLock = () => {
    if (!isMaster) return;
    setTobeDbLocks((cur) => ({ ...cur, [stage]: !cur[stage] }));
  };

  // site lock 가드: site name 비어있거나 현재 stage 의 DB lock 풀려있으면 차단
  const nameMissing = !name.trim();
  const dbUnlockedNow = !tobeDbLocks[stage];
  const siteLockBlocked = nameMissing || dbUnlockedNow;

  const toggleSiteLock = () => {
    if (siteUnlocked) {
      // 잠그려는 시도
      if (siteLockBlocked) {
        window.alert(
          nameMissing
            ? t('siteSettings.siteLock.blockedNameMissing')
            : t('siteSettings.siteLock.blockedDbUnlocked')
        );
        return;
      }
      setSiteUnlocked(false);
    } else {
      setSiteUnlocked(true);
    }
  };

  const isDirty =
    name !== site.name ||
    asisEnv !== site.asisEnv ||
    tobeEnv !== site.tobeEnv ||
    asisEncoding !== site.asisEncoding ||
    tobeEncoding !== site.tobeEncoding ||
    csvPath !== (site.csvPath ?? '') ||
    asisDbType !== (site.asisDbType ?? '') ||
    asisDbVersion !== (site.asisDbVersion ?? '') ||
    stage !== site.environment ||
    JSON.stringify(tobeDbByEnv) !== JSON.stringify(site.tobeDbByEnv) ||
    JSON.stringify(tobeDbLocks) !== JSON.stringify(site.tobeDbLocks);

  // production 으로 전환은 master 만
  const blockedByProd = stage === 'production' && stage !== site.environment && !isMaster;
  const canSave = isDirty && !!name.trim() && !blockedByProd && !siteUnlocked;
  // lock 상태에서도 저장된 값으로 connection test 는 항상 허용 (편집만 잠금).
  const canTestConnection =
    !!tobeDb.host.trim() &&
    !!tobeDb.username.trim() &&
    !!tobeDb.database.trim() &&
    testStatus !== 'testing';

  const dbConfigured =
    !!tobeDb.type.trim() &&
    !!tobeDb.host.trim() &&
    !!tobeDb.database.trim() &&
    !!tobeDb.username.trim();

  const handleSave = async () => {
    if (!canSave) return;
    // type 이 비어있는 단계는 저장하지 않음.
    const finalByEnv: TobeDbByEnv = {};
    for (const env of PROJECT_ENVIRONMENTS) {
      const c = tobeDbByEnv[env];
      if (c && c.type.trim()) finalByEnv[env] = c;
    }
    // 저장 시 데이터 있는 모든 stage 는 자동 lock — unlock 상태인 채로 저장되지 않도록.
    const finalLocks: TobeDbLocks = {};
    for (const env of PROJECT_ENVIRONMENTS) {
      if (finalByEnv[env]) finalLocks[env] = true;
    }

    await updateSite(site.id, {
      name: name.trim(),
      asisEnv,
      tobeEnv,
      asisEncoding,
      tobeEncoding,
      csvPath: csvPath.trim(),
      asisDbType: asisDbType.trim(),
      asisDbVersion: asisDbVersion.trim(),
      environment: stage,
      tobeDbByEnv: finalByEnv,
      tobeDbLocks: finalLocks,
    });
    onClose();
  };

  const handleDelete = async () => {
    if (confirmText !== site.name) return;
    await deleteSite(site.id);
    onClose();
  };

  const titleNode = (
    <div style={styles.titleWrap}>
      <div style={styles.eyebrow}>{t('siteSettings.title')}</div>
      <div style={styles.siteNameRow}>
        <span style={styles.siteBadge}>{siteInitials(site.name)}</span>
        <span style={styles.siteName} title={site.name}>{site.name || '—'}</span>
      </div>
      <div style={styles.titleMeta}>
        <span style={styles.titleMetaChip}>
          <span style={styles.titleMetaValue}>{projectCount}</span>
          <span style={styles.titleMetaLabel}>{t('siteSettings.projectCount')}</span>
        </span>
        <span style={styles.titleMetaSep}>·</span>
        <span style={styles.titleMetaChip}>
          <span style={styles.titleMetaLabel}>{t('siteSettings.createdAt')}</span>
          <span style={styles.titleMetaValue}>{new Date(site.createdAt).toLocaleDateString()}</span>
        </span>
      </div>
    </div>
  );

  const headerRight = (
    <div style={styles.headerActions}>
      {blockedByProd && <span style={styles.saveBlockMsg}>{t('siteSettings.prodCoordOnly')}</span>}
      <button onClick={onClose} style={styles.btnGhostSm}>{t('common.close')}</button>
      <button
        onClick={handleSave}
        disabled={!canSave}
        title={blockedByProd ? t('siteSettings.prodCoordOnly') : t('common.save')}
        style={{ ...styles.btnPrimarySm, ...(canSave ? {} : styles.btnDisabled) }}
      >
        {t('common.save')}
      </button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} width={560} title={titleNode} headerRight={headerRight}>
      <Field
        label={t('siteSettings.name')}
        labelRight={
          (() => {
            const lockBlocked = siteUnlocked && siteLockBlocked;
            const chipStyle = siteUnlocked ? styles.siteLockChipOpen : styles.siteLockChipClosed;
            const blockedTooltip = nameMissing
              ? t('siteSettings.siteLock.blockedNameMissing')
              : t('siteSettings.siteLock.blockedDbUnlocked');
            return (
              <button
                type="button"
                onClick={toggleSiteLock}
                disabled={lockBlocked}
                style={{ ...chipStyle, ...(lockBlocked ? styles.siteLockChipBlocked : {}) }}
                title={
                  lockBlocked
                    ? blockedTooltip
                    : siteUnlocked ? t('siteSettings.lock.title') : t('siteSettings.unlock.title')
                }
                aria-label={siteUnlocked ? t('siteSettings.lock.title') : t('siteSettings.unlock.title')}
              >
                <LockIcon open={siteUnlocked} color={siteUnlocked ? 'var(--amber)' : 'var(--green)'} size={13} />
                <span style={styles.siteLockChipText}>
                  {siteUnlocked ? t('siteSettings.siteLock.unlocked') : t('siteSettings.siteLock.locked')}
                </span>
              </button>
            );
          })()
        }
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ ...styles.input, ...(siteEditDisabled ? styles.inputDisabled : {}) }}
          disabled={siteEditDisabled}
        />
      </Field>

      <div style={{ opacity: siteEditDisabled ? 0.55 : 1, pointerEvents: siteEditDisabled ? 'none' : 'auto' }}>

      <Field label={t('siteSettings.asisEnv')}>
        <EnvPills value={asisEnv} onChange={setAsisEnv} t={t} />
      </Field>

      <Field label={t('siteSettings.tobeEnv')}>
        <EnvPills value={tobeEnv} onChange={setTobeEnv} t={t} />
      </Field>

      <Field label={t('siteSettings.asisEncoding')}>
        <select value={asisEncoding} onChange={(e) => setAsisEncoding(e.target.value as SourceEncoding)} style={styles.input}>
          {ENCODING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.key)}</option>
          ))}
        </select>
      </Field>

      <Field label={t('siteSettings.tobeEncoding')}>
        <select value={tobeEncoding} onChange={(e) => setTobeEncoding(e.target.value as SourceEncoding)} style={styles.input}>
          {ENCODING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.key)}</option>
          ))}
        </select>
      </Field>

      <div style={styles.twoCol}>
        <Field label={t('siteSettings.asisDbType')}>
          <select value={asisDbType} onChange={(e) => setAsisDbType(e.target.value)} style={styles.input}>
            <option value="">— {t('siteSettings.asisDbTypePlaceholder')} —</option>
            {ASIS_DB_TYPES.map((d) => <option key={d}>{d}</option>)}
          </select>
        </Field>
        <Field label={t('siteSettings.asisDbVersion')}>
          <input
            value={asisDbVersion}
            onChange={(e) => setAsisDbVersion(e.target.value)}
            placeholder={t('siteSettings.asisDbVersionPlaceholder')}
            style={styles.input}
          />
        </Field>
      </div>

      <div
        ref={csvRef}
        className={highlight === 'csv' ? 'mpd-fix-highlight' : undefined}
      >
        <Field label={t('siteSettings.csvPath')}>
          <CsvPathField value={csvPath} onChange={setCsvPath} />
        </Field>
      </div>

      <Field label={t('siteSettings.stage')}>
        <StagePills value={stage} onChange={setStage} byEnv={tobeDbByEnv} locks={tobeDbLocks} t={t} />
      </Field>

      {/* TO-BE DB */}
      <div
        ref={tobeDbRef}
        className={highlight === 'tobe-db' ? 'mpd-fix-highlight' : undefined}
        style={styles.dbCard}>
        <div style={styles.dbHeader}>
          <span>{t('siteSettings.tobeDb')}</span>
          {dbConfigured
            ? <span style={styles.dbStatusOk}><span style={styles.dbStatusDot} />{t('siteSettings.dbStatus.configured')}</span>
            : <span style={styles.dbStatusNone}><span style={styles.dbStatusDotNone} />{t('siteSettings.dbStatus.notConfigured')}</span>}
          <div style={{ flex: 1 }} />
          {isMaster ? (
            <button
              type="button"
              onClick={toggleStageLock}
              style={styles.dbLockBtn}
              title={stageLocked ? t('siteSettings.unlock') : t('siteSettings.lock.title')}
              aria-label={stageLocked ? t('siteSettings.unlock') : t('siteSettings.lock.title')}
            >
              <LockIcon open={!stageLocked} color="var(--green)" size={14} />
            </button>
          ) : (
            stageLocked && (
              <span
                style={styles.dbLockBtnDisabled}
                title={t('siteSettings.unlockCoordOnly')}
                aria-label={t('siteSettings.locked')}
              >
                <LockIcon open={false} color="var(--text-3)" size={14} />
              </span>
            )
          )}
        </div>

        <div style={styles.dbGrid2}>
          <select value={tobeDb.type} onChange={(e) => patchTobeDb({ type: e.target.value })} style={{ ...styles.input, ...(dbFieldsDisabled ? styles.inputDisabled : {}) }} disabled={dbFieldsDisabled}>
            <option value="" disabled>— {t('siteSettings.dbTypePlaceholder')} —</option>
            {DB_TYPES.map((d) => <option key={d}>{d}</option>)}
          </select>
          <input value={tobeDb.version} onChange={(e) => patchTobeDb({ version: e.target.value })} placeholder={t('siteSettings.dbVersion')} style={{ ...styles.input, ...(dbFieldsDisabled ? styles.inputDisabled : {}) }} disabled={dbFieldsDisabled} />
        </div>
        <div style={styles.dbGridHostPort}>
          <input value={tobeDb.host} onChange={(e) => patchTobeDb({ host: e.target.value })} placeholder={`${t('siteSettings.dbHost')} (10.20.30.40)`} style={{ ...styles.input, ...(dbFieldsDisabled ? styles.inputDisabled : {}) }} disabled={dbFieldsDisabled} />
          <input value={tobeDb.port} onChange={(e) => patchTobeDb({ port: e.target.value })} placeholder={t('siteSettings.dbPort')} style={{ ...styles.input, ...(dbFieldsDisabled ? styles.inputDisabled : {}) }} disabled={dbFieldsDisabled} />
        </div>
        <input
          value={tobeDb.database}
          onChange={(e) => patchTobeDb({ database: e.target.value })}
          placeholder={`${t('siteSettings.dbName')} (${t('siteSettings.dbNamePh')})`}
          style={{ ...styles.input, width: '100%', ...(dbFieldsDisabled ? styles.inputDisabled : {}) }}
          autoComplete="off"
          disabled={dbFieldsDisabled}
        />
        <div style={styles.dbGrid2}>
          <input value={tobeDb.username} onChange={(e) => patchTobeDb({ username: e.target.value })} placeholder={t('siteSettings.dbUsername')} style={{ ...styles.input, ...(dbFieldsDisabled ? styles.inputDisabled : {}) }} autoComplete="off" disabled={dbFieldsDisabled} />
          <input type="password" value={tobeDb.password} onChange={(e) => patchTobeDb({ password: e.target.value })} placeholder={t('siteSettings.dbPassword')} style={{ ...styles.input, ...(dbFieldsDisabled ? styles.inputDisabled : {}) }} autoComplete="new-password" disabled={dbFieldsDisabled} />
        </div>
        <div style={styles.dbTestRow}>
          <TestConnectionResult status={testStatus} message={testMessage} testingLabel={t('siteSettings.test.testing')} okLabel={t('siteSettings.test.success')} failedLabel={t('siteSettings.test.failed')} />
          <button
            type="button"
            onClick={handleTest}
            disabled={!canTestConnection}
            title={canTestConnection ? t('siteSettings.testConnection') : t('siteSettings.testConnectionHint')}
            style={{ ...styles.btnGhost, ...(canTestConnection ? styles.btnTestActive : styles.btnDisabled) }}
          >
            {testStatus === 'testing' ? t('siteSettings.test.testing') : t('siteSettings.testConnection')}
          </button>
        </div>
      </div>

      </div>{/* /siteEditDisabled wrap */}

      {/* Danger zone — Coordinator 만 삭제 가능 */}
      <div style={styles.dangerZone}>
        <div style={styles.dangerHeader}>{t('siteSettings.dangerZone')}</div>
        {!confirmOpen ? (
          <div style={styles.dangerRow}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={styles.dangerTitle}>{t('siteSettings.deleteTitle')}</div>
              <div style={styles.dangerDesc}>
                {t('siteSettings.deleteDesc')}
                <b> {t('siteSettings.deleteIrreversible')}</b>
              </div>
            </div>
            {isMaster ? (
              <button onClick={() => setConfirmOpen(true)} style={styles.btnDanger}>
                {t('siteSettings.deleteCta')}
              </button>
            ) : (
              <span style={styles.coordOnlyTag} title={t('siteSettings.deleteCoordOnly')}>
                {t('siteSettings.deleteCoordOnly')}
              </span>
            )}
          </div>
        ) : (
          <div style={styles.confirmBox}>
            <div style={styles.confirmTitle}>{t('siteSettings.confirmTitle', { name: site.name })}</div>
            <div style={styles.confirmDesc}>
              {t('siteSettings.confirmDescBefore')}<b>{projectCount}</b>{t('siteSettings.confirmDescAfter')}
            </div>
            <div style={styles.confirmInput}>
              {t('siteSettings.confirmInputBefore')}<code style={styles.confirmCode}>{site.name}</code>{t('siteSettings.confirmInputAfter')}
            </div>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              style={styles.input}
              placeholder={site.name}
              autoFocus
            />
            <div style={styles.confirmActions}>
              <button onClick={() => { setConfirmOpen(false); setConfirmText(''); }} style={styles.btnGhost}>
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDelete}
                disabled={confirmText !== site.name}
                style={{
                  ...styles.btnDanger,
                  ...(confirmText !== site.name ? styles.btnDisabled : {}),
                }}
              >
                {t('siteSettings.deleteBtn')}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function EnvPills({ value, onChange, t }: { value: SiteEnv; onChange: (v: SiteEnv) => void; t: ReturnType<typeof useT> }) {
  return (
    <div style={styles.pillRow}>
      {ENV_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          style={{ ...styles.pill, ...(value === o.value ? styles.pillActive : {}) }}
        >
          {t(o.key)}
        </button>
      ))}
    </div>
  );
}

function StagePills({
  value,
  onChange,
  byEnv,
  locks,
  t,
}: {
  value: ProjectEnvironment;
  onChange: (v: ProjectEnvironment) => void;
  byEnv: TobeDbByEnv;
  locks: TobeDbLocks;
  t: ReturnType<typeof useT>;
}) {
  return (
    <div style={styles.pillRow}>
      {PROJECT_ENVIRONMENTS.map((env) => {
        const isActive = value === env;
        const configured = isDbConfigured(byEnv[env]);
        const isLocked = !!locks[env];
        return (
          <button
            key={env}
            type="button"
            onClick={() => onChange(env)}
            style={{ ...styles.pill, ...(isActive ? styles.pillActive : {}) }}
          >
            <span style={{ ...styles.stageDot, background: configured ? 'var(--green)' : 'var(--red)' }} />
            {t(PROJECT_ENV_LABEL[env])}
            {isLocked && (
              <span style={styles.stageLockIcon}>
                <LockIcon open={false} color="var(--green)" size={11} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, hint, children, labelRight }: { label: string; hint?: string; children: React.ReactNode; labelRight?: React.ReactNode }) {
  return (
    <div style={styles.field}>
      <div style={styles.fieldLabelRow}>
        <div style={styles.fieldLabel}>{label}</div>
        {labelRight}
      </div>
      {hint && <div style={styles.fieldHint}>{hint}</div>}
      {children}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  field: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 },
  fieldLabelRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text)' },
  fieldHint: { fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 },
  input: {
    padding: '8px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 13,
    outline: 'none',
    width: '100%',
  },
  readonly: {
    padding: '8px 10px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    fontSize: 12.5,
    color: 'var(--text-2)',
    fontFamily: 'var(--mono)',
  },
  inputDisabled: {
    background: 'var(--panel-2)',
    color: 'var(--text-3)',
    cursor: 'not-allowed',
    borderColor: 'var(--border)',
  },

  /* env pills */
  pillRow: { display: 'flex', flexWrap: 'wrap', gap: 4, border: '1px solid var(--border-strong)', borderRadius: 4, padding: 2, background: 'var(--panel)' },
  pill: {
    flex: 1,
    minWidth: 0,
    padding: '6px 8px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-2)',
    fontSize: 11.5,
    fontWeight: 500,
    cursor: 'pointer',
    borderRadius: 3,
    whiteSpace: 'nowrap',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  pillActive: {
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    fontWeight: 600,
  },
  stageDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--green)',
    display: 'inline-block',
    flexShrink: 0,
  },
  stageLockIcon: { display: 'inline-flex', alignItems: 'center', marginLeft: 2 },

  /* TO-BE DB card */
  dbCard: {
    border: '1px solid var(--navy)',
    background: 'var(--navy-50)',
    borderRadius: 5,
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginBottom: 12,
  },
  dbHeader: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--navy)',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dbLockBtn: {
    width: 24, height: 24,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--panel)',
    border: '1px solid var(--green)',
    borderRadius: 3,
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
  },
  dbLockBtnDisabled: {
    width: 24, height: 24,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--panel-2)',
    border: '1px solid var(--border-strong)',
    borderRadius: 3,
    padding: 0,
    flexShrink: 0,
  },
  dbStatusOk: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    padding: '1px 7px',
    background: 'var(--green-50)',
    color: 'var(--green)',
    border: '1px solid var(--green)',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  dbStatusNone: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    padding: '1px 7px',
    background: 'var(--red-50)',
    color: 'var(--red)',
    border: '1px solid var(--red)',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  dbStatusDot: {
    width: 6, height: 6, borderRadius: '50%', background: 'var(--green)',
  },
  dbStatusDotNone: {
    width: 6, height: 6, borderRadius: '50%', background: 'var(--red)',
  },
  dbLockTag: {
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    padding: '1px 7px',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    border: '1px solid var(--amber)',
    borderRadius: 3,
    textTransform: 'none',
    letterSpacing: 0,
  },
  dbUnlockBtn: {
    padding: '4px 10px',
    fontSize: 11.5,
    fontWeight: 600,
    background: 'var(--panel)',
    color: 'var(--navy)',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    cursor: 'pointer',
    textTransform: 'none',
    letterSpacing: 0,
  },
  dbCoordOnly: {
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    padding: '1px 7px',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    border: '1px solid var(--amber)',
    borderRadius: 3,
    textTransform: 'none',
    letterSpacing: 0,
  },
  saveBlockMsg: {
    flex: 1,
    fontSize: 11,
    color: 'var(--amber)',
    fontFamily: 'var(--mono)',
  },
  dbDesc: { fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--mono)', marginBottom: 2 },
  dbGrid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  dbGridHostPort: { display: 'grid', gridTemplateColumns: '1fr 90px', gap: 8 },
  dbTestRow: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 2 },
  btnTestActive: {
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    fontWeight: 600,
  },
  dbTestHint: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  titleWrap: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 },
  eyebrow: {
    fontSize: 9.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  siteNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  siteBadge: {
    display: 'inline-grid',
    placeItems: 'center',
    width: 22, height: 22,
    borderRadius: 4,
    background: 'var(--navy)',
    color: '#fff',
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    letterSpacing: 0.4,
    flexShrink: 0,
  },
  siteName: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text)',
    letterSpacing: -0.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  titleMeta: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 },
  titleMetaChip: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-3)' },
  titleMetaLabel: { textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 },
  titleMetaValue: { color: 'var(--text-2)', fontWeight: 700 },
  titleMetaSep: { color: 'var(--text-4)', fontSize: 10 },

  headerActions: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  btnPrimarySm: {
    padding: '4px 12px',
    background: 'var(--navy)', color: '#fff',
    border: '1px solid var(--navy)', borderRadius: 3,
    fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
  },
  btnGhostSm: {
    padding: '4px 10px',
    background: 'var(--panel)', color: 'var(--text-2)',
    border: '1px solid var(--border-strong)', borderRadius: 3,
    fontSize: 11.5, cursor: 'pointer',
  },
  siteLockChipOpen: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '3px 9px',
    border: '1px solid var(--amber)', background: 'var(--amber-50)',
    color: 'var(--amber)',
    cursor: 'pointer', borderRadius: 3,
    fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--mono)',
    textTransform: 'uppercase', letterSpacing: 0.5,
    flexShrink: 0,
  },
  siteLockChipClosed: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '3px 9px',
    border: '1px solid var(--green)', background: 'var(--green-50)',
    color: 'var(--green)',
    cursor: 'pointer', borderRadius: 3,
    fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--mono)',
    textTransform: 'uppercase', letterSpacing: 0.5,
    flexShrink: 0,
  },
  siteLockChipText: { lineHeight: 1 },
  siteLockChipBlocked: { opacity: 0.45, cursor: 'not-allowed' },

  metaRow: {
    display: 'flex',
    gap: 1,
    marginTop: 6,
    background: 'var(--border)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  metaItem: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '10px 14px',
    background: 'var(--panel)',
  },
  metaLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  metaValue: {
    fontSize: 14,
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    lineHeight: 1.3,
  },

  saveRow: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8, marginBottom: 14 },
  btnPrimary: {
    padding: '7px 16px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnGhost: {
    padding: '7px 14px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-2)',
    borderRadius: 4,
    fontSize: 12.5,
    cursor: 'pointer',
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },

  /* Danger */
  dangerZone: {
    marginTop: 8,
    padding: 14,
    border: '1px solid var(--red)',
    borderRadius: 5,
    background: 'var(--red-50)',
  },
  dangerHeader: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--red)',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 10,
  },
  dangerRow: { display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' },
  dangerTitle: { fontSize: 12.5, fontWeight: 600, color: 'var(--red)' },
  dangerDesc: { fontSize: 11, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.5 },
  btnDanger: {
    padding: '6px 14px',
    background: 'var(--panel)',
    border: '1px solid var(--red)',
    color: 'var(--red)',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  coordOnlyTag: {
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    border: '1px solid var(--amber)',
    borderRadius: 3,
    whiteSpace: 'nowrap',
  },

  confirmBox: { background: 'var(--panel)', padding: 12, borderRadius: 4, border: '1px solid var(--red)' },
  confirmTitle: { fontSize: 13, fontWeight: 600, color: 'var(--red)' },
  confirmDesc: { fontSize: 11.5, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.5 },
  confirmInput: { fontSize: 11.5, color: 'var(--text-2)', marginTop: 12, marginBottom: 6 },
  confirmCode: {
    fontFamily: 'var(--mono)',
    background: 'var(--panel-2)',
    padding: '1px 6px',
    borderRadius: 3,
    fontSize: 11,
  },
  confirmActions: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 },
};
