import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import {
  useWorkspaceStore,
  emptyDbConnection,
  PROJECT_ENVIRONMENTS,
  type SiteEnv,
  type SourceEncoding,
  type SiteDbConnection,
  type ProjectEnvironment,
  type TobeDbByEnv,
  type TobeDbLocks,
} from '../store/workspace';
import { useAuthStore } from '../store/auth';
import { ApiError } from '../api/client';
import { tobeDbApi } from '../api/tobeDb';
import { useT, type TranslationKey } from '../i18n';
import { CsvPathField } from './CsvPathField';
import { TestConnectionResult, type TestStatus } from './TestConnectionResult';

interface Props {
  open: boolean;
  onClose: () => void;
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

export function CreateSiteModal({ open, onClose }: Props) {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const isMaster = user?.role === 'master';
  const createSite = useWorkspaceStore((s) => s.createSite);

  const [name, setName] = useState('');
  const [asisEnv, setAsisEnv] = useState<SiteEnv>('mainframe');
  const [tobeEnv, setTobeEnv] = useState<SiteEnv>('on-prem');
  const [asisEncoding, setAsisEncoding] = useState<SourceEncoding>('shift_jis');
  const [tobeEncoding, setTobeEncoding] = useState<SourceEncoding>('utf-8');
  const [csvPath, setCsvPath] = useState('');
  const [asisDbType, setAsisDbType] = useState('');
  const [asisDbVersion, setAsisDbVersion] = useState('');

  // 운영 단계 + 단계별 DB drafts.
  const [stage, setStage] = useState<ProjectEnvironment>('dev');
  /** TO-BE DB 연결 범위 — 'site' = 모든 Project 공유 (기본), 'project' = 각 Project 별. */
  const [tobeDbScope, setTobeDbScope] = useState<'site' | 'project'>('site');
  const [tobeDbByEnv, setTobeDbByEnv] = useState<TobeDbByEnv>({});
  const [error, setError] = useState<string | null>(null);
  // stage 별 test 결과 (각 단계 의 DB 가 통과했는지 별도 추적). handleSubmit 시
  // status === 'ok' 인 stage 만 final 저장 — test 미실시/실패 한 stage 의 DB 정보
  // 는 폐기, site 자체는 생성 (사용자 요청: 통과 안 됐으면 DB 입력 안 된 상태).
  const [testStatusByEnv, setTestStatusByEnv] = useState<Partial<Record<ProjectEnvironment, TestStatus>>>({});
  const [testMessageByEnv, setTestMessageByEnv] = useState<Partial<Record<ProjectEnvironment, string>>>({});
  const testStatus: TestStatus = testStatusByEnv[stage] ?? 'idle';
  const testMessage: string | null = testMessageByEnv[stage] ?? null;
  // 현재 단계의 DB 폼 — tobeDbByEnv 에서 가져오거나 빈 connection (database 필드 누락 보호).
  const tobeDb: SiteDbConnection = { ...emptyDbConnection(), ...(tobeDbByEnv[stage] ?? {}) };
  const patchTobeDb = (patch: Partial<SiteDbConnection>) => {
    setTobeDbByEnv((cur) => ({
      ...cur,
      [stage]: { ...emptyDbConnection(), ...(cur[stage] ?? {}), ...patch },
    }));
    setTestStatusByEnv((cur) => ({ ...cur, [stage]: 'idle' }));
    setTestMessageByEnv((cur) => ({ ...cur, [stage]: undefined }));
  };

  const handleTest = async () => {
    if (testStatus === 'testing') return;
    const curStage = stage;
    setTestStatusByEnv((cur) => ({ ...cur, [curStage]: 'testing' }));
    setTestMessageByEnv((cur) => ({ ...cur, [curStage]: undefined }));
    try {
      const result = await tobeDbApi.testConnectionStandalone({
        dbType:   tobeDb.type,
        host:     tobeDb.host.trim(),
        port:     tobeDb.port.trim() || '5432',
        database: tobeDb.database.trim(),
        username: tobeDb.username.trim(),
        password: tobeDb.password,
      });
      setTestStatusByEnv((cur) => ({ ...cur, [curStage]: result.success ? 'ok' : 'failed' }));
      setTestMessageByEnv((cur) => ({ ...cur, [curStage]: result.message }));
    } catch (e) {
      setTestStatusByEnv((cur) => ({ ...cur, [curStage]: 'failed' }));
      setTestMessageByEnv((cur) => ({ ...cur, [curStage]: (e as Error)?.message ?? 'Network error' }));
    }
  };

  const reset = () => {
    setName('');
    setAsisEnv('mainframe');
    setTobeEnv('on-prem');
    setAsisEncoding('shift_jis');
    setTobeEncoding('utf-8');
    setCsvPath('');
    setAsisDbType('');
    setAsisDbVersion('');
    setStage('dev');
    setTobeDbScope('site');
    setTobeDbByEnv({});
    setError(null);
    setTestStatusByEnv({});
    setTestMessageByEnv({});
  };

  // 모달을 열 때마다 폼을 초기화한다 (닫았다 다시 열어도 이전 입력값이 남지 않게).
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const blockedByProd = stage === 'production' && !isMaster;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || blockedByProd) return;
    // type 이 비어있거나 connection test 통과 안 된 단계는 저장하지 않음 —
    // 사용자 요청: test 통과한 stage 의 DB 만 저장, 미통과 stage 는 DB 미입력
    // 상태로 site 생성. master 가 추후 Site Settings 에서 채울 수 있음.
    const finalByEnv: TobeDbByEnv = {};
    for (const env of PROJECT_ENVIRONMENTS) {
      const c = tobeDbByEnv[env];
      if (c && c.type.trim() && testStatusByEnv[env] === 'ok') finalByEnv[env] = c;
    }
    // 생성 시 데이터가 채워진 모든 단계는 자동 lock.
    const finalLocks: TobeDbLocks = {};
    for (const env of PROJECT_ENVIRONMENTS) {
      if (finalByEnv[env]) finalLocks[env] = true;
    }
    setError(null);
    try {
      await createSite({
        name: name.trim(),
        asisEnv,
        tobeEnv,
        asisEncoding,
        tobeEncoding,
        csvPath: csvPath.trim(),
        asisDbType: asisDbType.trim() || undefined,
        asisDbVersion: asisDbVersion.trim() || undefined,
        environment: stage,
        tobeDbScope,
        tobeDbByEnv: finalByEnv,
        tobeDbLocks: finalLocks,
      });
      reset();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SITE_NAME_DUPLICATE') {
        setError(t('createSite.error.duplicate'));
      } else {
        setError(t('createSite.error.generic'));
      }
    }
  };

  const canTestConnection =
    !!tobeDb.host.trim() &&
    !!tobeDb.username.trim() &&
    !!tobeDb.database.trim() &&
    testStatus !== 'testing';

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={t('createSite.title')}
    >
      <form onSubmit={handleSubmit} style={styles.form}>
        <Field label={t('siteSettings.name')}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={styles.input}
            autoFocus
            required
          />
        </Field>

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

        <Field label={t('siteSettings.csvPath')}>
          <CsvPathField value={csvPath} onChange={setCsvPath} />
        </Field>

        {isMaster && (
          <Field label="TO-BE DB scope">
            <div style={{ display: 'inline-flex', gap: 4 }}>
              <button
                type="button"
                onClick={() => setTobeDbScope('site')}
                style={{ ...styles.btnGhost, ...(tobeDbScope === 'site' ? styles.btnTestActive : {}) }}
              >
                Site shared
              </button>
              <button
                type="button"
                onClick={() => setTobeDbScope('project')}
                style={{ ...styles.btnGhost, ...(tobeDbScope === 'project' ? styles.btnTestActive : {}) }}
              >
                Per-project
              </button>
            </div>
          </Field>
        )}

        {tobeDbScope === 'site' && (
        <Field label={t('siteSettings.stage')}>
          <StagePills value={stage} onChange={setStage} byEnv={tobeDbByEnv} t={t} />
        </Field>
        )}

        {/* TO-BE Target DB connection — 선택된 stage 에 묶여 있음. scope='project' 면 카드 자체를 띄우지 않고 안내만. */}
        {tobeDbScope === 'site' && (
        <div style={styles.dbCard}>
          <div style={styles.dbHeader}>
            {t('siteSettings.tobeDb')}
          </div>

          <div style={styles.dbGrid2}>
            <select value={tobeDb.type} onChange={(e) => patchTobeDb({ type: e.target.value })} style={styles.input}>
              <option value="" disabled>— {t('siteSettings.dbTypePlaceholder')} —</option>
              {DB_TYPES.map((d) => <option key={d}>{d}</option>)}
            </select>
            <input value={tobeDb.version} onChange={(e) => patchTobeDb({ version: e.target.value })} placeholder={t('siteSettings.dbVersion')} style={styles.input} />
          </div>
          <div style={styles.dbGridHostPort}>
            <input value={tobeDb.host} onChange={(e) => patchTobeDb({ host: e.target.value })} placeholder={`${t('siteSettings.dbHost')} (10.20.30.40)`} style={styles.input} />
            <input value={tobeDb.port} onChange={(e) => patchTobeDb({ port: e.target.value })} placeholder={t('siteSettings.dbPort')} style={styles.input} />
          </div>
          <input
            value={tobeDb.database}
            onChange={(e) => patchTobeDb({ database: e.target.value })}
            placeholder={`${t('siteSettings.dbName')} (${t('siteSettings.dbNamePh')})`}
            style={{ ...styles.input, width: '100%' }}
            autoComplete="off"
          />
          <div style={styles.dbGrid2}>
            <input value={tobeDb.username} onChange={(e) => patchTobeDb({ username: e.target.value })} placeholder={t('siteSettings.dbUsername')} style={styles.input} autoComplete="off" />
            <input type="password" value={tobeDb.password} onChange={(e) => patchTobeDb({ password: e.target.value })} placeholder={t('siteSettings.dbPassword')} style={styles.input} autoComplete="new-password" />
          </div>
          <div style={styles.dbTestRow}>
            <TestConnectionResult
              status={testStatus}
              message={testMessage}
              testingLabel={t('siteSettings.test.testing')}
              okLabel={t('siteSettings.test.success')}
              failedLabel={t('siteSettings.test.failed')}
            />
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
        )}

        {tobeDbScope === 'project' && (
          <div style={{
            padding: '12px 14px',
            fontSize: 12,
            color: 'var(--text-3)',
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
            borderRadius: 4,
          }}>
            프로젝트별 모드 — 사이트 생성 후 각 프로젝트의 Settings 페이지(TO-BE DB 섹션)에서 입력하세요.
          </div>
        )}

        {error && <div style={styles.errorBox}>{error}</div>}

        <div style={styles.actions}>
          {blockedByProd && <span style={styles.saveBlockMsg}>{t('siteSettings.prodCoordOnly')}</span>}
          <button type="button" onClick={onClose} style={styles.btnGhost}>{t('common.cancel')}</button>
          <button
            type="submit"
            disabled={blockedByProd}
            title={blockedByProd ? t('siteSettings.prodCoordOnly') : t('createSite.submit')}
            style={{ ...styles.btnPrimary, ...(blockedByProd ? styles.btnDisabled : {}) }}
          >
            {t('createSite.submit')}
          </button>
        </div>
      </form>
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

/**
 * Stage(test/dev/staging/production) pill row.
 * 저장된 단계는 작은 dot 으로 표시 — 사용자가 한 번 데이터를 친 단계.
 */
function StagePills({
  value,
  onChange,
  byEnv,
  t,
}: {
  value: ProjectEnvironment;
  onChange: (v: ProjectEnvironment) => void;
  byEnv: TobeDbByEnv;
  t: ReturnType<typeof useT>;
}) {
  const isCfg = (c: SiteDbConnection | undefined) =>
    !!c && !!c.type?.trim() && !!c.host?.trim() && !!c.database?.trim() && !!c.username?.trim();
  return (
    <div style={styles.pillRow}>
      {PROJECT_ENVIRONMENTS.map((env) => {
        const isActive = value === env;
        const configured = isCfg(byEnv[env]);
        return (
          <button
            key={env}
            type="button"
            onClick={() => onChange(env)}
            style={{ ...styles.pill, ...(isActive ? styles.pillActive : {}) }}
          >
            <span style={{ ...styles.stageDot, background: configured ? 'var(--green)' : 'var(--red)' }} />
            {t(PROJECT_ENV_LABEL[env])}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={styles.field}>
      <div style={styles.label}>{label}</div>
      {hint && <div style={styles.hint}>{hint}</div>}
      {children}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  subtitle: {
    fontSize: 11,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    fontWeight: 400,
    marginTop: 2,
  },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },
  label: { fontSize: 12.5, fontWeight: 600, color: 'var(--text)' },
  hint: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
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

  /* env pills */
  pillRow: { display: 'flex', flexWrap: 'wrap', gap: 4, border: '1px solid var(--border-strong)', borderRadius: 4, padding: 2, background: 'var(--panel)' },
  pill: {
    flex: 1,
    minWidth: 0,
    padding: '6px 10px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-2)',
    fontSize: 12,
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
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: 'var(--navy)',
    display: 'inline-block',
  },

  /* TO-BE DB card */
  dbCard: {
    border: '1px solid var(--navy)',
    background: 'var(--navy-50)',
    borderRadius: 5,
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
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
  dbStageTag: {
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    padding: '1px 7px',
    background: 'var(--panel)',
    color: 'var(--navy)',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    textTransform: 'none',
    letterSpacing: 0,
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

  errorBox: {
    padding: '8px 10px',
    background: 'var(--red-50)',
    border: '1px solid var(--red)',
    borderRadius: 4,
    color: 'var(--red)',
    fontSize: 12,
    fontWeight: 500,
  },
  actions: { display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 },
  btnGhost: {
    padding: '7px 14px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-2)',
    borderRadius: 4,
    fontSize: 12.5,
    cursor: 'pointer',
  },
  btnPrimary: {
    padding: '7px 14px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  saveBlockMsg: {
    flex: 1,
    alignSelf: 'center',
    fontSize: 11,
    color: 'var(--amber)',
    fontFamily: 'var(--mono)',
  },
};
