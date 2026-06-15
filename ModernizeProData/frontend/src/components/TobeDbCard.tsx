import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import {
  emptyDbConnection,
  PROJECT_ENVIRONMENTS,
  type ProjectEnvironment,
  type SiteDbConnection,
  type TobeDbByEnv,
  type TobeDbLocks,
} from '../store/workspace';
import { tobeDbApi } from '../api/tobeDb';
import { useTobeDbHealth } from '../hooks/useTobeDbHealth';
import { useT, type TranslationKey } from '../i18n';
import { TestConnectionResult, type TestStatus } from './TestConnectionResult';
import { LockIcon } from './LockIcon';

/**
 * StagePills + TO-BE DB 입력 카드 + lock + test-connection 를 한 묶음으로 추출.
 * SiteSettingsModal (Site 의 DB) 과 Project SettingsPage (per-project 모드의 Project DB)
 * 양쪽에서 같은 UI/동작으로 쓰인다.
 *
 * State 정책: tobeDbByEnv / tobeDbLocks / stage 는 부모가 관리(controlled),
 * testStatus 만 내부 state. patch/test 로직은 내부에서 처리.
 */

const DB_TYPES = ['PostgreSQL', 'Oracle', 'MySQL', 'SQL Server', 'Db2'];

const PROJECT_ENV_LABEL: Record<ProjectEnvironment, TranslationKey> = {
  test:       'projectEnv.test',
  dev:        'projectEnv.dev',
  staging:    'projectEnv.staging',
  production: 'projectEnv.production',
};

function isDbConfigured(c: SiteDbConnection | undefined): boolean {
  if (!c) return false;
  return !!c.type?.trim() && !!c.host?.trim() && !!c.database?.trim() && !!c.username?.trim();
}

interface Props {
  stage: ProjectEnvironment;
  onStageChange: (v: ProjectEnvironment) => void;
  value: TobeDbByEnv;
  onValueChange: (next: TobeDbByEnv) => void;
  locks: TobeDbLocks;
  onLocksChange: (next: TobeDbLocks) => void;
  /** 카드를 통째로 read-only 로 잠그는 외부 게이트(예: site lock unlocked 아님, 또는 SiteSettings 에서 scope=project). */
  editDisabled: boolean;
  isMaster: boolean;
  /** test connection 의 API context id (현 backend 는 site.id 기준 endpoint). Project 별 입력 시에도 그 Project 의 site.id 를 넘기면 됨. */
  siteIdForTest: string;
  pulseRef?: RefObject<HTMLDivElement>;
  pulse?: boolean;
}

export function TobeDbCard({
  stage,
  onStageChange,
  value,
  onValueChange,
  locks,
  onLocksChange,
  editDisabled,
  isMaster,
  siteIdForTest,
  pulseRef,
  pulse,
}: Props) {
  const t = useT();
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState<string | null>(null);
  // env dot hover 커스텀 tooltip — 네이티브 title= 대신 (브라우저 기본 tooltip 회피).
  const [hoverEnv, setHoverEnv] = useState<string | null>(null);
  // 환경별 실시간 도달성 — 카드(=Site Settings 모달)가 열려 있는 동안만 poll.
  // 미저장 사이트(생성 모달)에선 siteId 가 's-…' 가 아니라 자동 disabled.
  const health = useTobeDbHealth(siteIdForTest);

  const tobeDb: SiteDbConnection = { ...emptyDbConnection(), ...(value[stage] ?? {}) };
  const stageLocked = !!locks[stage];
  const dbFieldsDisabled = stageLocked || editDisabled;

  const patchTobeDb = (patch: Partial<SiteDbConnection>) => {
    if (stageLocked) return;
    onValueChange({
      ...value,
      [stage]: { ...emptyDbConnection(), ...(value[stage] ?? {}), ...patch },
    });
    setTestStatus('idle');
    setTestMessage(null);
  };

  const toggleStageLock = () => {
    if (!isMaster) return;
    const isLocking = !locks[stage];
    // 잠그려는 시도면 connection test 가 'ok' 일 때만 허용 — fail/미테스트 면 차단.
    // 잘못된 정보가 DB 에 저장되지 않도록 lock 자체를 막는다.
    if (isLocking && testStatus !== 'ok') return;
    onLocksChange({ ...locks, [stage]: !locks[stage] });
  };

  const handleTest = async () => {
    if (testStatus === 'testing') return;
    setTestStatus('testing');
    setTestMessage(null);
    try {
      const result = await tobeDbApi.testConnection(siteIdForTest, {
        dbType:   tobeDb.type,
        host:     tobeDb.host.trim(),
        port:     tobeDb.port.trim(),
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

  // stage 가 바뀌면 이전 stage 의 test 결과가 잔류하지 않도록 reset.
  useEffect(() => {
    setTestStatus('idle');
    setTestMessage(null);
  }, [stage]);

  const canTestConnection =
    !!tobeDb.host.trim() &&
    !!tobeDb.port.trim() &&
    !!tobeDb.username.trim() &&
    !!tobeDb.database.trim() &&
    testStatus !== 'testing';

  const dbConfigured =
    !!tobeDb.type.trim() &&
    !!tobeDb.host.trim() &&
    !!tobeDb.database.trim() &&
    !!tobeDb.username.trim();

  return (
    <div style={styles.wrap}>
      <div style={styles.field}>
        <div style={styles.fieldLabel}>{t('siteSettings.stage')}</div>
        <div style={styles.pillRow}>
          {PROJECT_ENVIRONMENTS.map((env) => {
            const isActive = stage === env;
            const configured = isDbConfigured(value[env]);
            const isLocked = !!locks[env];
            // dot: 미설정=grey, 설정+도달=green, 설정+단절=red, 설정+(아직 미확인)=green(낙관).
            // health 는 카드 열린 동안 polling — 중간에 TO-BE 가 내려가면 그 env dot 이 red 로.
            const eh = health?.[env];
            const dotColor = !configured ? 'var(--text-4)'
              : eh && !eh.reachable ? 'var(--red)'
              : 'var(--green)';
            const dotTitle = !configured ? t('siteSettings.dbStatus.notConfigured')
              : eh ? (eh.reachable ? t('siteSettings.dbStatus.configured') : eh.message)
              : t('siteSettings.dbStatus.configured');
            return (
              <button
                key={env}
                type="button"
                onClick={() => onStageChange(env)}
                style={{ ...styles.pill, ...(isActive ? styles.pillActive : {}) }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {t(PROJECT_ENV_LABEL[env])}
                  <span
                    style={{ position: 'relative', display: 'inline-flex' }}
                    onMouseEnter={() => setHoverEnv(env)}
                    onMouseLeave={() => setHoverEnv((cur) => (cur === env ? null : cur))}
                  >
                    <span
                      style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: dotColor,
                        display: 'inline-block',
                      }}
                    />
                    {hoverEnv === env && (
                      <span style={styles.dotTooltip}>{dotTitle}</span>
                    )}
                  </span>
                  {isLocked && <LockIcon open={false} color="var(--text-3)" size={10} />}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        ref={pulseRef}
        style={{
          ...styles.dbCard,
          ...(pulse ? { boxShadow: '0 0 0 3px var(--green)', transition: 'box-shadow 200ms' } : {}),
        }}
      >
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
              <span style={styles.dbLockBtnDisabled} title={t('siteSettings.unlockCoordOnly')} aria-label={t('siteSettings.locked')}>
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
    </div>
  );
}

/** SiteSettingsModal 의 dbCard 영역과 시각적으로 같은 느낌이 되도록 동일 토큰 사용. */
const styles: Record<string, CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldLabel: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: 0.5 },
  pillRow: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' },
  pill: { padding: '4px 10px', fontSize: 12, border: '1px solid var(--border)', background: 'var(--panel)', cursor: 'pointer', borderRadius: 4 },
  pillActive: { background: 'var(--navy-50)', borderColor: 'var(--navy)', color: 'var(--navy)' },
  dotTooltip: {
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'var(--text)',
    color: 'var(--panel)',
    padding: '4px 8px',
    borderRadius: 4,
    fontSize: 10.5,
    fontFamily: 'var(--mono)',
    lineHeight: 1.35,
    whiteSpace: 'normal',
    maxWidth: 240,
    width: 'max-content',
    wordBreak: 'break-word',
    textAlign: 'center',
    zIndex: 50,
    pointerEvents: 'none',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
  },
  dbCard: { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  dbHeader: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600 },
  dbStatusOk: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--green)' },
  dbStatusNone: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-3)' },
  dbStatusDot: { width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' },
  dbStatusDotNone: { width: 6, height: 6, borderRadius: '50%', background: 'var(--text-4)', display: 'inline-block' },
  dbLockBtn: { background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, display: 'inline-flex', alignItems: 'center' },
  dbLockBtnDisabled: { padding: 2, display: 'inline-flex', alignItems: 'center', opacity: 0.6, cursor: 'not-allowed' },
  dbGrid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  dbGridHostPort: { display: 'grid', gridTemplateColumns: '3fr 1fr', gap: 8 },
  input: { fontSize: 12, padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--panel)' },
  inputDisabled: { background: 'var(--panel-2)', color: 'var(--text-3)', cursor: 'not-allowed' },
  dbTestRow: { display: 'flex', alignItems: 'center', gap: 8 },
  btnGhost: { fontSize: 12, padding: '5px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer' },
  btnTestActive: { background: 'var(--navy-50)', borderColor: 'var(--navy)', color: 'var(--navy)' },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
};
