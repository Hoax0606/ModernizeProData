import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './Modal';
import { BrandName } from './BrandName';
import { Toggle } from './Toggle';
import { Toast } from './Toast';
import { useSettingsStore, type Theme, type Language, type NotificationScope } from '../store/settings';
import { useAuthStore } from '../store/auth';
import { LANGUAGE_LABELS, useT } from '../i18n';
import { licenseApi, type LicenseDto, type LicenseStatus as LicenseStatusEnum } from '../api/license';
import { ApiError } from '../api/client';
import { useLicenseStore } from '../store/license';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Solution settings 모달 — 사이트 전역 도구 설정.
 * Save 클릭 시 store 에 반영되어 localStorage 영속 + theme/language 즉시 적용.
 */
export function SolutionSettingsModal({ open, onClose }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const store = useSettingsStore();
  const user = useAuthStore((s) => s.user);
  const isMaster = user?.role === 'master';

  // 로컬 드래프트 — Save 전에는 store 에 반영 안 됨.
  const [theme, setTheme] = useState<Theme>(store.theme);
  const [language, setLanguage] = useState<Language>(store.language);
  const [notifications, setNotifications] = useState(store.notifications);
  const [notifScope, setNotifScope] = useState<NotificationScope>(store.notificationScope);
  const [notifRetention, setNotifRetention] = useState(store.notificationRetention);
  const [saved, setSaved] = useState(false);

  // 모달 열릴 때마다 store 의 현재 값으로 리셋
  useEffect(() => {
    if (!open) return;
    setTheme(store.theme);
    setLanguage(store.language);
    setNotifications(store.notifications);
    setNotifScope(store.notificationScope);
    setNotifRetention(store.notificationRetention);
    setSaved(false);
  }, [open, store.theme, store.language, store.notifications, store.notificationScope, store.notificationRetention]);

  // 변경 여부 — Save 버튼 활성 조건
  const isDirty = useMemo(() => {
    if (theme !== store.theme) return true;
    if (language !== store.language) return true;
    if (notifications !== store.notifications) return true;
    if (notifScope !== store.notificationScope) return true;
    if (notifRetention !== store.notificationRetention) return true;
    return false;
  }, [theme, language, notifications, notifScope, notifRetention, store]);

  const handleSave = async () => {
    if (!isDirty) return;
    store.setTheme(theme);
    store.setLanguage(language);
    store.setNotifications(notifications);
    store.setNotificationScope(notifScope);
    if (isMaster) store.setNotificationRetention(notifRetention);
    setSaved(true);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={780}
      title={
        <div>
          <div>{t('solution.title')}</div>
          <div style={styles.subtitle}>
            preferences for <BrandName /> · applies across all sites
          </div>
        </div>
      }
    >
      {/* Save 행 */}
      <div style={styles.saveRow}>
        <button
          style={{ ...styles.btnPrimary, ...(isDirty ? {} : styles.btnPrimaryDisabled) }}
          onClick={handleSave}
          disabled={!isDirty}
        >
          {t('common.save')}
        </button>
      </div>

      <Toast visible={saved} message={t('solution.savedToast')} onHide={() => setSaved(false)} />

      {/* License */}
      <LicenseCard isMaster={isMaster} />

      {/* Worker registration UI lives in User Management → Worker Nodes tab
          (ClusterAdminModal). Don't duplicate it here. */}

      {/* Appearance */}
      <Card title={t('solution.appearance')}>
        <Row label={t('solution.language')} align="right">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            style={styles.select}
          >
            {(Object.keys(LANGUAGE_LABELS) as Language[]).map((k) => (
              <option key={k} value={k}>{LANGUAGE_LABELS[k]}</option>
            ))}
          </select>
        </Row>
        <Row label={t('solution.theme')} align="right">
          <div style={styles.toggleGroup}>
            <button
              onClick={() => setTheme('light')}
              style={{ ...styles.toggleBtn, ...(theme === 'light' ? styles.toggleBtnActive : {}) }}
            >{t('solution.theme.light')}</button>
            <button
              onClick={() => setTheme('dark')}
              style={{ ...styles.toggleBtn, ...(theme === 'dark' ? styles.toggleBtnActive : {}) }}
            >{t('solution.theme.dark')}</button>
          </div>
        </Row>
      </Card>

      {/* Notifications */}
      <Card
        title={t('solution.notifications')}
        desc={t('solution.notifications.desc')}
      >
        <div style={styles.toggleRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={styles.rowLabelTitle}>{t('solution.notifications.enable')}</div>
            <div style={styles.rowSub}>{t('solution.notifications.enableDesc')}</div>
          </div>
          <Toggle on={notifications} onChange={() => setNotifications((v) => !v)} ariaLabel={t('solution.notifications.enable')} />
        </div>

        <div>
          {/* Scope — Enable notifications 와 무관하게 항상 활성.
              표준 Row 의 width:220 라벨 박스로는 hint 가 한 줄에 안 들어가서 custom 행. */}
          <div style={styles.row}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={styles.rowLabelTitle}>{t('projectSettings.notify.recipients.scope')}</div>
              <div style={{ ...styles.rowSub, whiteSpace: 'nowrap' }}>
                {t('projectSettings.notify.recipients.scopeHint')}
              </div>
            </div>
            <select
              value={notifScope}
              onChange={(e) => setNotifScope(e.target.value as NotificationScope)}
              style={{ ...styles.select, width: 180, flexShrink: 0 }}
            >
              <option value="mine-only">{t('projectSettings.notify.scope.mine')}</option>
              <option value="all-project">{t('projectSettings.notify.scope.all')}</option>
            </select>
          </div>

          {/* Retention — master 만 수정 가능. 4개 옵션 중 택일. 우측 드롭다운. */}
          <Row label={
            <RowLabel
              title={<>{t('projectSettings.notify.recipients.retention')} {!isMaster && <span style={styles.masterOnlyTag}>{t('solution.external.masterOnly')}</span>}</>}
              sub={t('projectSettings.notify.recipients.retentionHint')}
            />
          }>
            <div style={{ marginLeft: 'auto' }}>
              <select
                value={notifRetention}
                onChange={(e) => setNotifRetention(e.target.value)}
                disabled={!isMaster}
                style={{
                  ...styles.select,
                  width: 120,
                  background: isMaster ? 'var(--panel)' : 'var(--panel-2)',
                  color: isMaster ? 'var(--text)' : 'var(--text-3)',
                }}
              >
                <option value="7 days">7일</option>
                <option value="30 days">30일</option>
                <option value="90 days">90일</option>
                <option value="OFF">OFF</option>
              </select>
            </div>
          </Row>
        </div>
      </Card>

      {/* Internal scheduler / External integrations 카드 는 SchedulerPage 로 이동했음 (Phase 3). */}

      <div style={styles.footer}>
        © 2024–2026 KS Info System · All rights reserved
      </div>
    </Modal>
  );
}

/* ─── Building blocks ───────────────────────────────────── */

function Card({ title, desc, right, children }: { title: React.ReactNode; desc?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={styles.card}>
      <div style={styles.cardHeaderRow}>
        <div>
          <div style={styles.cardTitle}>{title}</div>
          {desc && <div style={styles.cardDesc}>{desc}</div>}
        </div>
        {right && <div style={{ flexShrink: 0 }}>{right}</div>}
      </div>
      <div style={styles.cardBody}>{children}</div>
    </section>
  );
}

function Row({ label, children, align }: { label: React.ReactNode; children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <div style={styles.row}>
      <div style={styles.rowLabel}>{label}</div>
      <div style={{ ...styles.rowValue, justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>{children}</div>
    </div>
  );
}

function RowLabel({ title, sub }: { title: React.ReactNode; sub?: string }) {
  return (
    <div>
      <div style={styles.rowLabelTitle}>{title}</div>
      {sub && <div style={styles.rowSub}>{sub}</div>}
    </div>
  );
}

/* ─── License ───────────────────────────────────────────── */

const STATUS_TONE: Record<LicenseStatusEnum, { bg: string; color: string; border: string }> = {
  ACTIVE:    { bg: 'var(--green-50)', color: 'var(--green)', border: 'var(--green)' },
  EXPIRING:  { bg: 'var(--amber-50)', color: 'var(--amber)', border: 'var(--amber)' },
  IN_GRACE:  { bg: 'var(--amber-50)', color: 'var(--amber)', border: 'var(--amber)' },
  READ_ONLY: { bg: 'var(--red-50)',   color: 'var(--red)',   border: 'var(--red)'   },
  EXPIRED:   { bg: 'var(--red-50)',   color: 'var(--red)',   border: 'var(--red)'   },
  MISSING:   { bg: 'var(--red-50)',   color: 'var(--red)',   border: 'var(--red)'   },
  INVALID:   { bg: 'var(--red-50)',   color: 'var(--red)',   border: 'var(--red)'   },
};

function LicenseCard({ isMaster }: { isMaster: boolean }) {
  const t = useT();
  const [lic, setLic] = useState<LicenseDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadOk, setUploadOk] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const refreshGlobalLicense = useLicenseStore((s) => s.refresh);

  useEffect(() => {
    let cancelled = false;
    licenseApi.get()
      .then((d) => { if (!cancelled) setLic(d); })
      .catch(() => { /* MISSING 상태일 수 있음 — 그냥 null */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploadOk(false);
    try {
      const next = await licenseApi.upload(file);
      setLic(next);
      setUploadOk(true);
      // banner 가 즉시 갱신되도록 전역 store 도 refresh
      void refreshGlobalLicense();
    } catch (err) {
      if (err instanceof ApiError) {
        setUploadError(err.code === 'LICENSE_INVALID_SIG'
          ? t('solution.license.upload.invalidSig')
          : err.message);
      } else {
        setUploadError(t('solution.license.upload.failed'));
      }
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const status = lic?.status ?? 'MISSING';
  const tone = STATUS_TONE[status];
  const days = lic?.daysRemaining ?? 0;

  return (
    <Card
      title={t('solution.license')}
      desc={t('solution.license.desc')}
      right={isMaster ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            ref={fileRef}
            type="file"
            accept=".lic,application/json"
            style={{ display: 'none' }}
            onChange={onFile}
          />
          {lic?.status && lic.status !== 'MISSING' && (
            <button
              style={styles.licenseClearBtn}
              onClick={async () => {
                if (!confirm(t('solution.license.clearDev.confirm'))) return;
                try {
                  await licenseApi.clear();
                  // SPA nav, not window.location — JavaFX WebView does not
                  // actually reload the page on location.replace().
                  useAuthStore.getState().logout();
                  navigate('/license-setup', { replace: true });
                } catch (err) {
                  setUploadError(err instanceof ApiError
                    ? err.message
                    : t('solution.license.clearDev.failed'));
                }
              }}
              title={t('solution.license.clearDev')}
            >
              {t('solution.license.clearDev')}
            </button>
          )}
          <button
            style={styles.licenseUpdateBtn}
            onClick={() => fileRef.current?.click()}
            title={t('solution.license.update')}
          >
            {t('solution.license.update')}
          </button>
        </div>
      ) : (
        <span style={styles.masterOnlyTag}>{t('solution.license.coordOnly')}</span>
      )}
    >
      {loading ? (
        <Row label={t('solution.license.licensedTo')}>
          <span style={styles.licenseValue}>…</span>
        </Row>
      ) : (
        <>
          <Row label={t('solution.license.licensedTo')}>
            <span style={styles.licenseValue}>{lic?.customer ?? '—'}</span>
          </Row>
          <Row label={t('solution.license.edition')}>
            <span style={styles.licenseMono}>{lic?.edition ?? '—'}</span>
          </Row>
          <Row label={t('solution.license.issued')}>
            <span style={styles.licenseMono}>{lic?.issuedAt ?? '—'}</span>
          </Row>
          <Row label={t('solution.license.expires')}>
            <span style={styles.licenseMono}>{lic?.expiresAt ?? '—'}</span>
          </Row>
          <Row label={t('solution.license.daysLeft')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                ...styles.licenseDaysBadge,
                background: tone.bg, color: tone.color, borderColor: tone.border,
              }}>
                {days < 0 ? 0 : days} {t('solution.license.daysUnit')}
              </span>
              <span style={{
                ...styles.licenseStatusBadge,
                background: tone.bg, color: tone.color, borderColor: tone.border,
              }}>
                {t(`solution.license.status.${status}` as const)}
              </span>
            </div>
          </Row>
          <Row label={t('solution.license.hardwareId')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <code style={styles.licenseMono} title={lic?.currentHardwareId ?? ''}>
                {lic?.currentHardwareId ?? '—'}
              </code>
              {lic?.currentHardwareId && (
                <button
                  style={styles.licenseClearBtn}
                  onClick={() => {
                    void navigator.clipboard.writeText(lic.currentHardwareId);
                  }}
                  title={t('solution.license.hardwareId.copy')}
                >
                  {t('solution.license.hardwareId.copy')}
                </button>
              )}
            </div>
          </Row>
          {lic?.boundHardwareId && (
            <Row label={t('solution.license.boundTo')}>
              <code style={{
                ...styles.licenseMono,
                color: lic.hardwareMismatch ? 'var(--red)' : 'var(--text-3)',
              }}>
                {lic.boundHardwareId}
              </code>
            </Row>
          )}
          {lic?.hardwareMismatch && (
            <Row label="">
              <span style={{ fontSize: 12, color: 'var(--red)' }}>
                {t('solution.license.hardwareMismatch')}
              </span>
            </Row>
          )}
          {uploadOk && (
            <Row label="">
              <span style={{ fontSize: 12, color: 'var(--green)' }}>
                {t('solution.license.upload.ok')}
              </span>
            </Row>
          )}
          {uploadError && (
            <Row label="">
              <span style={{ fontSize: 12, color: 'var(--red)' }}>{uploadError}</span>
            </Row>
          )}
        </>
      )}
    </Card>
  );
}


/* (Removed in favor of User Management → Worker Nodes tab.) */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _PLACEHOLDER = {
  REMOVED: 'Worker registration is owned by ClusterAdminModal NodesTab.',
};

// Old reference left in code path below was deleted -- see ClusterAdminModal.tsx.
const _UNUSED_TONE_REMOVED: Record<string, { bg: string; color: string; border: string }> = {
  PROVISIONED: { bg: 'var(--amber-50)', color: 'var(--amber)', border: 'var(--amber)' },
  REGISTERED:  { bg: 'var(--green-50)', color: 'var(--green)', border: 'var(--green)' },
  REVOKED:     { bg: 'var(--red-50)',   color: 'var(--red)',   border: 'var(--red)'   },
};

function WorkerCard() {
  const t = useT();
  const [workers, setWorkers] = useState<WorkerSummaryDto[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState('');
  const [addSiteId, setAddSiteId] = useState<string>('');
  const [issueErr, setIssueErr] = useState<string | null>(null);
  // Raw token shown exactly once after issue. Cleared on next list refresh or Close.
  const [issuedToken, setIssuedToken] = useState<{ name: string; token: string } | null>(null);

  const refresh = async () => {
    try {
      const [ws, ss] = await Promise.all([workerApi.list(), siteApi.list()]);
      setWorkers(ws);
      setSites(ss);
    } catch {
      /* license-blocked or auth — caller's responsibility */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onIssue = async () => {
    setIssueErr(null);
    try {
      const res = await workerApi.issue(addName.trim(), addSiteId || null);
      setIssuedToken({ name: res.worker.name, token: res.rawToken });
      setAdding(false);
      setAddName('');
      setAddSiteId('');
      void refresh();
    } catch (err) {
      setIssueErr(err instanceof ApiError ? err.message : t('solution.workers.issue.failed'));
    }
  };

  const onRevoke = async (workerId: string) => {
    if (!confirm(t('solution.workers.revoke.confirm'))) return;
    try {
      await workerApi.revoke(workerId);
      void refresh();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : t('solution.workers.revoke.failed'));
    }
  };

  return (
    <Card
      title={t('solution.workers')}
      desc={t('solution.workers.desc')}
      right={
        <button
          style={styles.licenseUpdateBtn}
          onClick={() => { setAdding((v) => !v); setIssueErr(null); }}
        >
          {adding ? t('common.cancel') : t('solution.workers.add')}
        </button>
      }
    >
      {adding && (
        <div style={styles.workerAddPanel}>
          <Row label={t('solution.workers.name')}>
            <input
              type="text"
              style={styles.workerInput}
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder={t('solution.workers.name.placeholder')}
            />
          </Row>
          <Row label={t('solution.workers.site')}>
            <select
              style={styles.workerInput}
              value={addSiteId}
              onChange={(e) => setAddSiteId(e.target.value)}
            >
              <option value="">{t('solution.workers.site.none')}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Row>
          <Row label="">
            <button
              style={styles.btnPrimary}
              disabled={!addName.trim()}
              onClick={() => void onIssue()}
            >
              {t('solution.workers.issue')}
            </button>
          </Row>
          {issueErr && (
            <Row label="">
              <span style={{ fontSize: 12, color: 'var(--red)' }}>{issueErr}</span>
            </Row>
          )}
        </div>
      )}

      {issuedToken && (
        <div style={styles.workerTokenPanel}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
            {t('solution.workers.tokenIssued', { name: issuedToken.name })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>
            {t('solution.workers.tokenWarning')}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <code style={{ ...styles.licenseMono, padding: '4px 8px', flex: 1 }}>
              {issuedToken.token}
            </code>
            <button
              style={styles.licenseUpdateBtn}
              onClick={() => void navigator.clipboard.writeText(issuedToken.token)}
            >
              {t('solution.license.hardwareId.copy')}
            </button>
            <button
              style={styles.licenseClearBtn}
              onClick={() => setIssuedToken(null)}
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <Row label={t('solution.workers.list')}>
          <span style={styles.licenseValue}>…</span>
        </Row>
      ) : workers.length === 0 ? (
        <Row label={t('solution.workers.list')}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('solution.workers.empty')}</span>
        </Row>
      ) : (
        workers.map((w) => {
          const tone = WORKER_STATUS_TONE[w.status];
          const siteName = sites.find((s) => s.id === w.siteId)?.name ?? '—';
          return (
            <Row key={w.workerId} label={w.name}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  ...styles.licenseStatusBadge,
                  background: tone.bg, color: tone.color, borderColor: tone.border,
                }}>
                  {t(`solution.workers.status.${w.status}` as const)}
                </span>
                <code style={styles.licenseMono}>{w.tokenPrefix}…</code>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{siteName}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {w.lastSeenAt ? new Date(w.lastSeenAt).toLocaleString() : t('solution.workers.lastSeen.never')}
                </span>
                {w.status !== 'REVOKED' && (
                  <button
                    style={styles.licenseClearBtn}
                    onClick={() => void onRevoke(w.workerId)}
                  >
                    {t('solution.workers.revoke')}
                  </button>
                )}
              </div>
            </Row>
          );
        })
      )}
    </Card>
  );
}


const styles: Record<string, React.CSSProperties> = {
  workerAddPanel: {
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '10px 12px',
    marginBottom: 8,
  },
  workerInput: {
    width: '100%',
    padding: '4px 8px',
    fontSize: 12.5,
    fontFamily: 'var(--mono)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
  },
  workerTokenPanel: {
    background: 'var(--amber-50)',
    border: '1px solid var(--amber)',
    borderRadius: 6,
    padding: '10px 12px',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 11,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    marginTop: 2,
    fontWeight: 400,
  },

  saveRow: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 10 },
  btnPrimary: {
    padding: '7px 18px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background .08s, border-color .08s, opacity .08s',
  },
  btnPrimaryDisabled: {
    background: 'var(--border-strong)',
    borderColor: 'var(--border-strong)',
    color: 'var(--text-3)',
    cursor: 'not-allowed',
  },

  card: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    marginBottom: 12,
    overflow: 'hidden',
  },
  cardHeaderRow: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
  },
  cardTitle: { fontSize: 13, fontWeight: 700, color: 'var(--text)' },
  cardDesc: {
    fontSize: 11.5,
    color: 'var(--text-3)',
    marginTop: 4,
    lineHeight: 1.55,
    maxWidth: 600,
  },
  cardBody: { padding: '0 16px' },

  row: {
    display: 'flex',
    alignItems: 'center',
    padding: '12px 0',
    borderBottom: '1px dashed var(--border)',
    gap: 12,
    minHeight: 48,
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 0',
    borderBottom: '1px dashed var(--border)',
    gap: 12,
  },
  rowLabel: { width: 220, fontSize: 12.5, color: 'var(--text)', flexShrink: 0 },
  rowLabelTitle: { fontSize: 12.5, fontWeight: 600 },
  rowValue: { flex: 1, display: 'flex', alignItems: 'center' },
  rowSub: {
    fontSize: 11,
    color: 'var(--text-3)',
    fontWeight: 400,
    marginTop: 3,
    lineHeight: 1.4,
  },

  select: {
    padding: '6px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12.5,
    outline: 'none',
    minWidth: 140,
  },
  input: {
    width: '100%',
    padding: '7px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12.5,
    fontFamily: 'var(--mono)',
    outline: 'none',
  },

  toggleGroup: { display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 4, overflow: 'hidden' },
  toggleBtn: {
    padding: '5px 16px',
    background: 'var(--panel)',
    color: 'var(--text-2)',
    border: 'none',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
  toggleBtnActive: {
    background: 'var(--navy)',
    color: '#fff',
    fontWeight: 600,
  },

  footer: {
    marginTop: 14,
    fontSize: 11,
    color: 'var(--text-4)',
    fontFamily: 'var(--mono)',
    textAlign: 'center',
  },
  masterOnlyTag: {
    marginLeft: 8,
    padding: '1px 6px',
    fontSize: 9.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    background: 'var(--amber-50)',
    color: 'var(--amber)',
    border: '1px solid var(--amber)',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },

  /* License card */
  licenseValue: { fontSize: 12.5, color: 'var(--text)' },
  licenseMono: { fontSize: 12.5, color: 'var(--text)', fontFamily: 'var(--mono)' },
  licenseDaysBadge: {
    padding: '2px 8px',
    fontSize: 12,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    border: '1px solid',
    borderRadius: 3,
  },
  licenseStatusBadge: {
    padding: '1px 7px',
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    border: '1px solid',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  licenseClearBtn: {
    padding: '4px 10px',
    background: 'var(--red-50)',
    border: '1px solid var(--red)',
    color: 'var(--red)',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  licenseUpdateBtn: {
    padding: '5px 12px',
    background: 'var(--navy)',
    border: '1px solid var(--navy)',
    color: '#fff',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
};
