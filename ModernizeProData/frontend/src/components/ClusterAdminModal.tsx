import React, { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { useUsersStore } from '../store/users';
import { useWorkerNodesStore, type NodeStatus } from '../store/workerNodes';
import { useWorkspaceStore } from '../store/workspace';
import { useAuthStore, roleLabel, type UserRole } from '../store/auth';
import { ApiError } from '../api/client';
import { usersApi } from '../api/users';
import { useT, type TranslationKey } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

const ROLE_OPTIONS: UserRole[] = ['master', 'admin', 'viewer'];

type Tab = 'users' | 'nodes';

/**
 * Coordinator(master) 전용 클러스터 관리 모달.
 *   - Users tab: 사용자 발급·역할 변경·삭제 (정확히 1 Coordinator)
 *   - Worker Nodes tab: 노드 등록·해지·토큰
 */
export function ClusterAdminModal({ open, onClose }: Props) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('users');

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={920}
      title={
        <div>
          <div>{t('clusterAdmin.title')}</div>
          <div style={styles.subtitle}>{t('clusterAdmin.subtitle')}</div>
        </div>
      }
    >
      {/* tabs */}
      <div style={styles.tabbar}>
        <TabBtn label={t('clusterAdmin.tab.users')} active={tab === 'users'} onClick={() => setTab('users')} />
        <TabBtn label={t('clusterAdmin.tab.nodes')} active={tab === 'nodes'} onClick={() => setTab('nodes')} />
      </div>

      {tab === 'users' ? <UsersTab /> : <NodesTab />}
    </Modal>
  );
}

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ ...styles.tabBtn, ...(active ? styles.tabBtnActive : {}) }}>
      {label}
    </button>
  );
}

/* ═══════ Users tab ═══════ */

function UsersTab() {
  const t = useT();
  const currentUser = useAuthStore((s) => s.user);
  const users = useUsersStore((s) => s.users);
  const loading = useUsersStore((s) => s.loading);
  const loadError = useUsersStore((s) => s.error);
  const loadUsers = useUsersStore((s) => s.loadUsers);
  const addUser = useUsersStore((s) => s.addUser);
  const deleteUser = useUsersStore((s) => s.deleteUser);
  const updateUserRole = useUsersStore((s) => s.updateUserRole);

  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('admin');
  const [newPw, setNewPw] = useState('');
  const [newSiteId, setNewSiteId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Sites for the admin-user site dropdown.
  const sites = useWorkspaceStore((s) => s.sites);
  const fetchSites = useWorkspaceStore((s) => s.fetchSites);
  useEffect(() => { void fetchSites(); }, [fetchSites]);

  // Force logout (master 가 다른 user 의 활성 세션 강제 종료)
  const [forceLogoutId, setForceLogoutId] = useState<string | null>(null);
  const handleForceLogout = async (id: string, username: string) => {
    if (!window.confirm(t('userMgmt.forceLogout.confirm', { name: username }))) return;
    setForceLogoutId(id);
    try {
      await usersApi.forceLogout(id);
      await loadUsers();
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setForceLogoutId(null);
    }
  };

  // Reset password (master 가 다른 user 의 비번 강제 변경)
  const [resetPwUserId, setResetPwUserId] = useState<string | null>(null);
  const [resetPwValue, setResetPwValue] = useState('');
  const [resetPwSaving, setResetPwSaving] = useState(false);
  const [resetPwError, setResetPwError] = useState<string | null>(null);
  const [resetPwSuccess, setResetPwSuccess] = useState<string | null>(null);
  const resetPwTarget = users.find((u) => u.id === resetPwUserId) ?? null;

  const closeResetPw = () => {
    setResetPwUserId(null);
    setResetPwValue('');
    setResetPwError(null);
    setResetPwSaving(false);
  };

  const handleResetPwSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPwTarget) return;
    const pw = resetPwValue.trim();
    if (pw.length < 4) {
      setResetPwError(t('userMgmt.resetPw.error.tooShort'));
      return;
    }
    setResetPwSaving(true);
    setResetPwError(null);
    try {
      await usersApi.resetPassword(resetPwTarget.id, pw);
      setResetPwSuccess(t('userMgmt.resetPw.success', { name: resetPwTarget.username }));
      closeResetPw();
      setTimeout(() => setResetPwSuccess(null), 2500);
    } catch (err) {
      setResetPwError(formatApiError(err));
      setResetPwSaving(false);
    }
  };

  // 탭 진입 시 최신 사용자 목록 fetch.
  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const hasMaster = users.some((u) => u.role === 'master');
  const canSubmitAdd = !!newName.trim() && !!newPw.trim() && !submitting;

  const resetAddForm = () => {
    setNewName('');
    setNewPw('');
    setNewRole('admin');
    setNewSiteId('');
    setError(null);
  };

  const formatApiError = (e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.code === 'USER_ALREADY_EXISTS') return t('userMgmt.add.dupName');
      return e.message;
    }
    return (e as Error).message ?? t('userMgmt.add.failed');
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const name = newName.trim();
    if (!name || !newPw.trim()) return;
    if (newRole === 'master' && hasMaster) {
      setError(t('userMgmt.coordExactlyOne'));
      return;
    }
    setSubmitting(true);
    try {
      await addUser({
        username: name,
        password: newPw,
        role: newRole,
        siteId: newRole === 'admin' ? (newSiteId || null) : null,
      });
      resetAddForm();
      setAddOpen(false);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoleChange = async (id: string, role: UserRole) => {
    const target = users.find((u) => u.id === id);
    if (!target) return;
    if (role === 'master' && target.role !== 'master' && hasMaster) return;
    if (target.role === 'master' && role !== 'master') return;
    try {
      await updateUserRole(id, role);
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const handleConfirmDelete = async (id: string) => {
    const target = users.find((u) => u.id === id);
    if (!target) return;
    if (target.username === currentUser?.username) return;
    if (target.role === 'master') return;
    try {
      await deleteUser(id);
      setConfirmDeleteId(null);
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  return (
    <>
      {!addOpen && (
        <div style={styles.toolbar}>
          <div style={{ flex: 1 }} />
          <button onClick={() => setAddOpen(true)} style={styles.btnPrimary}>
            {t('userMgmt.addUser')}
          </button>
        </div>
      )}

      {addOpen && (
        <form onSubmit={handleAdd} style={styles.addCard}>
          <div style={styles.addCardHeader}>{t('userMgmt.addUser')}</div>
          <div style={styles.addCardBody}>
            <div style={styles.formRow}>
              <label style={styles.formRowLabel}>{t('userMgmt.add.username')}</label>
              <input
                value={newName}
                onChange={(e) => { setNewName(e.target.value); setError(null); }}
                style={styles.input}
                autoFocus
                required
              />
            </div>
            <div style={styles.formRow}>
              <label style={styles.formRowLabel}>{t('userMgmt.add.role')}</label>
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)} style={styles.input}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r} disabled={r === 'master' && hasMaster}>
                    {roleLabel(r)}{r === 'master' && hasMaster ? ' — ' + t('userMgmt.coordExactlyOne') : ''}
                  </option>
                ))}
              </select>
            </div>
            {newRole === 'admin' && (
              <div style={styles.formRow}>
                <label style={styles.formRowLabel}>{t('userMgmt.add.site')}</label>
                <select
                  value={newSiteId}
                  onChange={(e) => setNewSiteId(e.target.value)}
                  style={styles.input}
                >
                  <option value="">{t('userMgmt.add.site.none')}</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div style={styles.formRow}>
              <label style={styles.formRowLabel}>{t('userMgmt.add.password')}</label>
              <div style={styles.formRowControl}>
                <input
                  type="text"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  style={{ ...styles.input, fontFamily: 'var(--mono)' }}
                  placeholder="••••••••"
                  required
                />
                <div style={styles.formRowHint}>{t('userMgmt.add.passwordHint')}</div>
              </div>
            </div>
            {error && <div style={styles.errorMsg}>{error}</div>}
            <div style={styles.addActions}>
              <button type="button" onClick={() => { setAddOpen(false); resetAddForm(); }} style={styles.btnGhost}>
                {t('userMgmt.cancelAdd')}
              </button>
              <button type="submit" style={{ ...styles.btnPrimary, ...(canSubmitAdd ? {} : styles.btnDisabled) }} disabled={!canSubmitAdd}>
                {t('userMgmt.add.submit')}
              </button>
            </div>
          </div>
        </form>
      )}

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <Th>{t('userMgmt.col.username')}</Th>
              <Th>{t('userMgmt.col.role')}</Th>
              <Th>{t('userMgmt.col.createdAt')}</Th>
              <Th>{t('userMgmt.col.lastSignIn')}</Th>
              <Th>{t('userMgmt.col.actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr><td colSpan={5} style={styles.emptyRow}>{t('userMgmt.loading')}</td></tr>
            ) : loadError ? (
              <tr><td colSpan={5} style={{ ...styles.emptyRow, color: 'var(--red)' }}>{loadError}</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={5} style={styles.emptyRow}>{t('userMgmt.empty')}</td></tr>
            ) : (
              users.map((u, i) => {
                const isSelf = u.username === currentUser?.username;
                const isMaster = u.role === 'master';
                const roleDisabled = isMaster || isSelf;
                const cannotDelete = isMaster || isSelf;
                const cannotDeleteReason = isSelf
                  ? t('userMgmt.cannotDeleteSelf')
                  : isMaster
                    ? t('userMgmt.coordExactlyOne')
                    : '';
                const rowBg = i % 2 ? 'var(--zebra)' : 'transparent';

                if (confirmDeleteId === u.id) {
                  return (
                    <tr key={u.id} style={{ background: 'var(--red-50)', borderBottom: '1px solid var(--border)' }}>
                      <td colSpan={5} style={styles.confirmCell}>
                        <div style={styles.confirmBar}>
                          <span style={styles.confirmText}>
                            {t('userMgmt.confirmDeletePre')}<b>{u.username}</b>{t('userMgmt.confirmDeletePost')}
                          </span>
                          <div style={{ flex: 1 }} />
                          <button onClick={() => setConfirmDeleteId(null)} style={styles.miniBtn}>
                            {t('common.cancel')}
                          </button>
                          <button onClick={() => handleConfirmDelete(u.id)} style={styles.miniBtnDanger}>
                            {t('userMgmt.confirmDelete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={u.id} style={{ background: rowBg, borderBottom: '1px solid var(--border)' }}>
                    <td style={styles.td}>
                      <span style={styles.userMono}>{u.username}</span>
                      {isSelf && <span style={styles.youTag}>{t('userMgmt.you')}</span>}
                    </td>
                    <td style={styles.td}>
                      <select
                        value={u.role}
                        onChange={(e) => handleRoleChange(u.id, e.target.value as UserRole)}
                        disabled={roleDisabled}
                        style={styles.roleSelect}
                        title={roleDisabled ? (isSelf ? t('userMgmt.cannotDeleteSelf') : t('userMgmt.coordExactlyOne')) : ''}
                      >
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r} value={r} disabled={r === 'master' && !isMaster && hasMaster}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ ...styles.td, color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ ...styles.td, color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                      {u.lastSignInAt ? new Date(u.lastSignInAt).toLocaleString() : '—'}
                    </td>
                    <td style={styles.td}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          onClick={() => { setResetPwUserId(u.id); setResetPwValue(''); setResetPwError(null); }}
                          disabled={isSelf}
                          title={isSelf ? t('userMgmt.resetPw.selfHint') : t('userMgmt.resetPassword')}
                          style={{ ...styles.miniBtn, ...(isSelf ? styles.btnDisabled : {}) }}
                        >
                          {t('userMgmt.resetPassword')}
                        </button>
                        <button
                          onClick={() => handleForceLogout(u.id, u.username)}
                          disabled={isSelf || !u.hasActiveSession || forceLogoutId === u.id}
                          title={
                            isSelf ? t('userMgmt.forceLogout.selfHint')
                            : !u.hasActiveSession ? t('userMgmt.forceLogout.noSession')
                            : t('userMgmt.forceLogout')
                          }
                          style={{ ...styles.miniBtn, ...((isSelf || !u.hasActiveSession) ? styles.btnDisabled : {}) }}
                        >
                          {forceLogoutId === u.id ? '…' : t('userMgmt.forceLogout')}
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(u.id)}
                          disabled={cannotDelete}
                          title={cannotDelete ? cannotDeleteReason : t('userMgmt.delete')}
                          style={{ ...styles.miniBtnDanger, ...(cannotDelete ? styles.btnDisabled : {}) }}
                        >
                          {t('userMgmt.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Reset password 모달 — master 가 다른 user 의 비번 강제 변경 */}
      <Modal
        open={!!resetPwUserId}
        onClose={closeResetPw}
        width={420}
        title={t('userMgmt.resetPw.title')}
      >
        {resetPwTarget && (
          <form onSubmit={handleResetPwSubmit}>
            <div style={styles.resetPwTarget}>
              <span style={styles.resetPwTargetLabel}>{t('userMgmt.resetPw.target')}</span>
              <span style={styles.resetPwTargetName}>{resetPwTarget.username}</span>
              <span style={styles.resetPwTargetRole}>{roleLabel(resetPwTarget.role)}</span>
            </div>
            <div style={styles.resetPwWarn}>{t('userMgmt.resetPw.warn')}</div>
            <label style={styles.resetPwField}>
              <span style={styles.fieldLabel}>{t('userMgmt.resetPw.newPassword')}</span>
              <input
                type="text"
                value={resetPwValue}
                onChange={(e) => { setResetPwValue(e.target.value); setResetPwError(null); }}
                style={{ ...styles.input, fontFamily: 'var(--mono)' }}
                placeholder="••••••••"
                autoFocus
                disabled={resetPwSaving}
              />
            </label>
            {resetPwError && <div style={styles.errorMsg}>{resetPwError}</div>}
            <div style={styles.addActions}>
              <button type="button" onClick={closeResetPw} style={styles.btnGhost} disabled={resetPwSaving}>
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={resetPwSaving || resetPwValue.trim().length < 4}
                style={{ ...styles.btnPrimary, ...((resetPwSaving || resetPwValue.trim().length < 4) ? styles.btnDisabled : {}) }}
              >
                {resetPwSaving ? t('userMgmt.resetPw.saving') : t('userMgmt.resetPw.submit')}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {resetPwSuccess && (
        <div style={styles.resetPwToast}>{resetPwSuccess}</div>
      )}
    </>
  );
}

/* ═══════ Worker Nodes tab ═══════ */

const NODE_STATUS_KEY: Record<NodeStatus, TranslationKey> = {
  online:       'workerNode.status.online',
  offline:      'workerNode.status.offline',
  registering:  'workerNode.status.registering',
  revoked:      'workerNode.status.revoked',
};

function nodeStatusTone(s: NodeStatus): React.CSSProperties {
  switch (s) {
    case 'online':      return { background: 'var(--green-50)', color: 'var(--green)', borderColor: 'var(--green)' };
    case 'offline':     return { background: 'var(--panel-2)',  color: 'var(--text-3)', borderColor: 'var(--border-strong)' };
    case 'registering': return { background: 'var(--amber-50)', color: 'var(--amber)', borderColor: 'var(--amber)' };
    case 'revoked':     return { background: 'var(--red-50)',   color: 'var(--red)',   borderColor: 'var(--red)' };
  }
}

function NodesTab() {
  const t = useT();
  const nodes = useWorkerNodesStore((s) => s.nodes);
  const refresh = useWorkerNodesStore((s) => s.refresh);
  const revokeNode = useWorkerNodesStore((s) => s.revokeNode);

  const sites = useWorkspaceStore((s) => s.sites);
  const fetchSites = useWorkspaceStore((s) => s.fetchSites);

  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    void fetchSites();
  }, [refresh, fetchSites]);

  const siteNameOf = (siteId: string | null): string => {
    if (!siteId) return '—';
    return sites.find((s) => s.id === siteId)?.name ?? siteId;
  };

  // Sites grouped: workers belonging to each, plus unassigned bucket.
  const grouped = (() => {
    const byKey = new Map<string, typeof nodes>();
    for (const n of nodes) {
      const key = n.siteId ?? '__none__';
      const list = byKey.get(key) ?? [];
      list.push(n);
      byKey.set(key, list);
    }
    const result: { siteId: string | null; siteName: string; rows: typeof nodes }[] = [];
    for (const s of sites) {
      const rows = byKey.get(s.id) ?? [];
      if (rows.length > 0) result.push({ siteId: s.id, siteName: s.name, rows });
    }
    const unassigned = byKey.get('__none__') ?? [];
    if (unassigned.length > 0) {
      result.push({ siteId: null, siteName: t('workerNode.unassigned'), rows: unassigned });
    }
    return result;
  })();

  return (
    <>
      <div style={styles.subTitle}>{t('workerNode.subtitle')}</div>

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <Th>{t('workerNode.col.name')}</Th>
              <Th>{t('workerNode.col.owner')}</Th>
              <Th>{t('workerNode.col.status')}</Th>
              <Th>{t('workerNode.col.heartbeat')}</Th>
              <Th>{t('workerNode.col.actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {nodes.length === 0 ? (
              <tr><td colSpan={5} style={styles.emptyRow}>{t('workerNode.empty')}</td></tr>
            ) : (
              grouped.map((group) => (
                <React.Fragment key={group.siteId ?? '__none__'}>
                  <tr>
                    <td colSpan={5} style={styles.groupHeader}>
                      {group.siteName} <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>({group.rows.length})</span>
                    </td>
                  </tr>
                  {group.rows.map((n, i) => {
                    const rowBg = i % 2 ? 'var(--zebra)' : 'transparent';

                    if (confirmRevokeId === n.id) {
                      return (
                        <tr key={n.id} style={{ background: 'var(--red-50)', borderBottom: '1px solid var(--border)' }}>
                          <td colSpan={5} style={styles.confirmCell}>
                            <div style={styles.confirmBar}>
                              <span style={styles.confirmText}>
                                {t('workerNode.confirmRevokePre')}<b>{n.name}</b>{t('workerNode.confirmRevokePost')}
                              </span>
                              <div style={{ flex: 1 }} />
                              <button onClick={() => setConfirmRevokeId(null)} style={styles.miniBtn}>
                                {t('common.cancel')}
                              </button>
                              <button onClick={() => { void revokeNode(n.id); setConfirmRevokeId(null); }} style={styles.miniBtnDanger}>
                                {t('workerNode.confirmRevoke')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    }

                    return (
                      <tr key={n.id} style={{ background: rowBg, borderBottom: '1px solid var(--border)' }}>
                        <td style={styles.td}>
                          <span style={styles.userMono}>{n.name}</span>
                          <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{n.createdBy}</div>
                        </td>
                        <td style={{ ...styles.td, fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-2)' }}>
                          {siteNameOf(n.siteId)}
                        </td>
                        <td style={styles.td}>
                          <span style={{ ...styles.statusBadge, ...nodeStatusTone(n.status) }}>
                            <span style={{ ...styles.statusDot, background: nodeStatusTone(n.status).color }} />
                            {t(NODE_STATUS_KEY[n.status])}
                          </span>
                        </td>
                        <td style={{ ...styles.td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                          {relativeTime(n.lastHeartbeatAt ?? undefined, t)}
                        </td>
                        <td style={styles.td}>
                          {n.status !== 'revoked' && (
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button onClick={() => setConfirmRevokeId(n.id)} style={styles.miniBtnDanger}>
                                {t('workerNode.revoke')}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function relativeTime(iso: string | undefined, t: ReturnType<typeof useT>): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t('workerNode.justNow');
  if (min < 60) return t('workerNode.minutesAgo', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('workerNode.hoursAgo', { n: hr });
  const days = Math.floor(hr / 24);
  return t('workerNode.daysAgo', { n: days });
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={styles.th}>{children}</th>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={styles.field}>
      <div style={styles.fieldLabel}>{label}</div>
      {hint && <div style={styles.fieldHint}>{hint}</div>}
      {children}
    </label>
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
  subTitle: {
    fontSize: 11.5,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    marginBottom: 8,
  },

  /* tabs */
  tabbar: {
    display: 'flex',
    gap: 4,
    borderBottom: '1px solid var(--border)',
    marginBottom: 12,
  },
  tabBtn: {
    padding: '7px 16px',
    background: 'transparent',
    color: 'var(--text-3)',
    border: 'none',
    borderBottom: '2px solid transparent',
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'pointer',
    marginBottom: -1,
  },
  tabBtnActive: {
    color: 'var(--navy)',
    fontWeight: 600,
    borderBottomColor: 'var(--navy)',
  },

  toolbar: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },

  addCard: {
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    borderRadius: 5,
    marginBottom: 12,
    overflow: 'hidden',
  },
  groupHeader: {
    fontSize: 11,
    fontFamily: 'var(--mono)',
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    padding: '8px 0 4px 0',
    background: 'transparent',
  },
  addCardHeader: {
    padding: '10px 16px',
    background: 'var(--panel-2)',
    color: 'var(--text)',
    fontSize: 12.5,
    fontWeight: 600,
    borderBottom: '1px solid var(--border)',
  },
  addCardBody: { padding: '14px 16px 12px' },
  formRow: {
    display: 'grid',
    gridTemplateColumns: '120px 1fr',
    alignItems: 'center',
    gap: 14,
    padding: '8px 0',
    borderBottom: '1px dashed var(--border)',
  },
  formRowLabel: {
    fontSize: 11.5,
    fontWeight: 500,
    color: 'var(--text)',
  },
  formRowControl: { display: 'flex', flexDirection: 'column', gap: 4 },
  formRowHint: { fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  addForm: {
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    padding: 12,
    marginBottom: 12,
  },
  addRow3: { display: 'grid', gridTemplateColumns: '1fr 140px 1fr', gap: 10, alignItems: 'end' },
  addRow2: { display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'end', marginTop: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldLabel: { fontSize: 11.5, fontWeight: 600, color: 'var(--text)' },
  fieldHint: { fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  input: {
    padding: '7px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12.5,
    outline: 'none',
    width: '100%',
  },
  errorMsg: { marginTop: 8, fontSize: 11.5, color: 'var(--red)', fontFamily: 'var(--mono)' },
  addActions: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 },

  tableWrap: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    overflow: 'hidden',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: {
    padding: '7px 12px',
    textAlign: 'left',
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontFamily: 'var(--mono)',
    background: 'var(--panel-2)',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  },
  td: { padding: '8px 12px' },
  userMono: { fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' },
  youTag: {
    marginLeft: 6,
    padding: '1px 6px',
    fontSize: 9.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  roleSelect: {
    padding: '4px 8px',
    border: '1px solid var(--border-strong)',
    borderRadius: 3,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12,
    outline: 'none',
  },
  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '2px 8px',
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    border: '1px solid',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  statusDot: { width: 6, height: 6, borderRadius: '50%' },
  emptyRow: {
    padding: '32px 12px',
    textAlign: 'center',
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    fontSize: 12,
  },

  btnPrimary: {
    padding: '6px 12px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnGhost: {
    padding: '6px 12px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-2)',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },

  /* Reset password 모달 */
  resetPwTarget: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 10px', background: 'var(--panel-2)',
    border: '1px solid var(--border)', borderRadius: 4,
    marginBottom: 10,
  },
  resetPwTargetLabel: { fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: 0.5 },
  resetPwTargetName: { fontSize: 13, fontWeight: 700, color: 'var(--text)' },
  resetPwTargetRole: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  resetPwWarn: {
    padding: '8px 10px',
    background: 'var(--amber-50)',
    border: '1px solid var(--amber)',
    color: 'var(--amber)',
    borderRadius: 4,
    fontSize: 11.5,
    marginBottom: 12,
    lineHeight: 1.5,
  },
  resetPwField: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 },
  resetPwToast: {
    position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
    padding: '10px 16px',
    background: 'var(--green)', color: '#fff',
    borderRadius: 5, fontSize: 12, fontWeight: 600,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  },
  miniBtn: {
    padding: '3px 9px',
    fontSize: 11,
    border: '1px solid var(--border-strong)',
    background: 'var(--panel)',
    color: 'var(--text-2)',
    borderRadius: 3,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  miniBtnDanger: {
    padding: '3px 9px',
    fontSize: 11,
    border: '1px solid var(--red)',
    background: 'var(--panel)',
    color: 'var(--red)',
    borderRadius: 3,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontWeight: 600,
  },

  /* inline confirm bar */
  confirmCell: { padding: '8px 12px' },
  confirmBar: { display: 'flex', alignItems: 'center', gap: 8, width: '100%' },
  confirmText: { fontSize: 12, color: 'var(--text)', fontFamily: 'var(--sans)', whiteSpace: 'nowrap' },

  /* token popup */
  tokenOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(10,20,18,0.4)',
    display: 'grid',
    placeItems: 'center',
    zIndex: 4000,
  },
  tokenCard: {
    width: 460,
    maxWidth: 'calc(100vw - 32px)',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    padding: 18,
    boxShadow: '0 20px 60px rgba(10,20,18,0.18)',
  },
  tokenTitle: { fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  tokenValue: {
    display: 'block',
    padding: 10,
    fontFamily: 'var(--mono)',
    fontSize: 12,
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text)',
    wordBreak: 'break-all',
    lineHeight: 1.6,
  },
  tokenActions: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 },
};
