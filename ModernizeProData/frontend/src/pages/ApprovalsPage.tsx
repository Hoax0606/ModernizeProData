import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useWorkspaceStore, type ProjectPhase } from '../store/workspace';
import { useSnapshotsStore, type SnapshotStatus, type SnapshotType } from '../store/snapshots';
import { projectApi } from '../api/workspace';
import { useAuthStore } from '../store/auth';
import { useAuditLogStore } from '../store/auditLog';
import { useT, type TranslationKey } from '../i18n';

type StatusFilter = 'all' | SnapshotStatus;
type TypeFilter = 'all' | SnapshotType;

/**
 * 사이트 단위 승인 화면 — 모든 프로젝트의 스냅샷 승인·거부 + 이력 (Coordinator only edit, all-read).
 */
export function ApprovalsPage() {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const isMaster = user?.role === 'master';
  const sites = useWorkspaceStore((s) => s.sites);
  const projects = useWorkspaceStore((s) => s.projects);
  const activeSiteId = useWorkspaceStore((s) => s.activeSiteId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const site = useMemo(() => sites.find((s) => s.id === activeSiteId) ?? null, [sites, activeSiteId]);

  const allSnapshots = useSnapshotsStore((s) => s.snapshots);
  const fetchBySite = useSnapshotsStore((s) => s.fetchBySite);
  const approveSnapshot = useSnapshotsStore((s) => s.approveSnapshot);
  const rejectSnapshot = useSnapshotsStore((s) => s.rejectSnapshot);
  const addAuditLog = useAuditLogStore((s) => s.add);

  // 마운트 시 사이트 전체 스냅샷 fetch
  useEffect(() => {
    if (activeSiteId) void fetchBySite(activeSiteId);
  }, [activeSiteId, fetchBySite]);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [authorFilter, setAuthorFilter] = useState<string>('all');
  const [approveId, setApproveId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const siteProjects = useMemo(
    () => projects.filter((p) => p.siteId === activeSiteId),
    [projects, activeSiteId],
  );
  const projectIds = useMemo(() => new Set(siteProjects.map((p) => p.id)), [siteProjects]);

  // 사이트 내 스냅샷 (draft 제외 — request 된 것만 표시)
  const siteSnapshots = useMemo(
    () => allSnapshots.filter((s) => projectIds.has(s.projectId) && s.status !== 'draft'),
    [allSnapshots, projectIds],
  );

  // 작성자 옵션 — 사이트 내 스냅샷에 등장한 username 만
  const authorOptions = useMemo(
    () => Array.from(new Set(siteSnapshots.map((s) => s.createdBy))).sort(),
    [siteSnapshots],
  );

  // 사이트 내 스냅샷 + 필터 적용 + 최신순
  const snapshots = useMemo(() => {
    let list = siteSnapshots;
    if (statusFilter !== 'all') list = list.filter((s) => s.status === statusFilter);
    if (typeFilter !== 'all') list = list.filter((s) => (s.type ?? 'mapping') === typeFilter);
    if (projectFilter !== 'all') list = list.filter((s) => s.projectId === projectFilter);
    if (authorFilter !== 'all')  list = list.filter((s) => s.createdBy === authorFilter);
    return list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [siteSnapshots, statusFilter, typeFilter, projectFilter, authorFilter]);

  if (activeProjectId) return <Navigate to="/" replace />;
  if (!site) return <Navigate to="/" replace />;

  const handleApprove = async (id: string) => {
    const snap = allSnapshots.find((s) => s.id === id);
    await approveSnapshot(id);
    // Approve 시 phase 전환: mapping → sign-off, cutover → ready
    if (snap) {
      const proj = siteProjects.find((p) => p.id === snap.projectId);
      if (proj) {
        const newPhase: ProjectPhase = (snap.type ?? 'mapping') === 'cutover' ? 'ready' : 'sign-off';
        try {
          await projectApi.update(proj.id, { phase: newPhase, runStatus: 'idle' });
        } catch { /* polling 에서 동기화 */ }
      }
      addAuditLog({
        projectId: snap.projectId,
        user: user?.username || 'Unknown',
        action: 'approved',
        description: `Approved snapshot: ${snap.name}`,
        snapshotName: snap.version,
      });
    }
    setApproveId(null);
  };

  const handleReject = async (id: string) => {
    const reason = rejectReason.trim();
    if (!reason) return;
    const snap = allSnapshots.find((s) => s.id === id);
    await rejectSnapshot(id, reason);
    if (snap) {
      addAuditLog({
        projectId: snap.projectId,
        user: user?.username || 'Unknown',
        action: 'rejected',
        description: `Rejected snapshot: ${snap.name} — ${reason}`,
        snapshotName: snap.version,
      });
    }
    setRejectId(null);
    setRejectReason('');
  };

  return (
    <div>
      <div style={styles.header}>
        <h1 style={styles.h1}>{t('approvals.title')}</h1>
        <p style={styles.subtitle}>{site.name} · {t('approvals.subtitle')}</p>
      </div>

      {/* Filter bar */}
      <div style={styles.filterBar}>
        <Filter label={t('approvals.filter.status')}>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} style={styles.select}>
            <option value="all">{t('approvals.filter.all')}</option>
            <option value="pending">{t('versions.status.pending')}</option>
            <option value="approved">{t('versions.status.approved')}</option>
            <option value="rejected">{t('versions.status.rejected')}</option>
          </select>
        </Filter>
        <Filter label={t('approvals.filter.type')}>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeFilter)} style={styles.select}>
            <option value="all">{t('approvals.filter.all')}</option>
            <option value="mapping">{t('versions.type.mapping')}</option>
            <option value="cutover">{t('versions.type.cutover')}</option>
          </select>
        </Filter>
        <Filter label={t('approvals.filter.project')}>
          <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} style={styles.select}>
            <option value="all">{t('approvals.filter.all')}</option>
            {siteProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Filter>
        <Filter label={t('approvals.filter.author')}>
          <select value={authorFilter} onChange={(e) => setAuthorFilter(e.target.value)} style={styles.select}>
            <option value="all">{t('approvals.filter.all')}</option>
            {authorOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </Filter>
      </div>

      {/* Table */}
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <Th>{t('approvals.col.snapshot')}</Th>
              <Th>{t('versions.col.type')}</Th>
              <Th>{t('approvals.col.project')}</Th>
              <Th>{t('approvals.col.status')}</Th>
              <Th>{t('approvals.col.creator')}</Th>
              <Th>{t('approvals.col.approval')}</Th>
              <Th>{t('approvals.col.actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {snapshots.length === 0 ? (
              <tr><td colSpan={7} style={styles.emptyRow}>{t('approvals.empty')}</td></tr>
            ) : (
              snapshots.map((s, i) => {
                const proj = siteProjects.find((p) => p.id === s.projectId);
                const rowBg = i % 2 ? 'var(--zebra)' : 'transparent';

                if (approveId === s.id) {
                  return (
                    <tr key={s.id} style={{ background: 'var(--green-50)', borderBottom: '1px solid var(--border)' }}>
                      <td colSpan={7} style={styles.confirmCell}>
                        <div style={styles.confirmBar}>
                          <span style={styles.confirmText}>
                            {t('versions.confirmApprovePre')}<b>{s.name}</b>{t('versions.confirmApprovePost')}
                          </span>
                          <div style={{ flex: 1 }} />
                          <button onClick={() => handleApprove(s.id)} style={styles.miniBtnApprove}>{t('versions.confirmApprove')}</button>
                          <button onClick={() => setApproveId(null)} style={styles.miniBtn}>{t('common.cancel')}</button>
                        </div>
                      </td>
                    </tr>
                  );
                }

                if (rejectId === s.id) {
                  return (
                    <tr key={s.id} style={{ background: 'var(--red-50)', borderBottom: '1px solid var(--border)' }}>
                      <td colSpan={7} style={styles.confirmCell}>
                        <div style={styles.rejectBar}>
                          <div style={styles.rejectLabel}>{t('versions.rejectReasonLabel')} · <b>{s.name}</b></div>
                          <textarea
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                            placeholder={t('versions.rejectReasonPh')}
                            style={styles.rejectInput}
                            rows={2}
                            autoFocus
                          />
                          <div style={styles.rejectActions}>
                            <button
                              onClick={() => handleReject(s.id)}
                              disabled={!rejectReason.trim()}
                              style={{ ...styles.miniBtnDanger, ...(rejectReason.trim() ? {} : styles.btnDisabled) }}
                            >
                              {t('versions.rejectSubmit')}
                            </button>
                            <button onClick={() => { setRejectId(null); setRejectReason(''); }} style={styles.miniBtn}>
                              {t('common.cancel')}
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={s.id} style={{ background: rowBg, borderBottom: '1px solid var(--border)' }}>
                    <td style={styles.td}>
                      <div style={styles.nameMain}>{s.name}</div>
                      {s.description && <div style={styles.nameDesc}>{s.description}</div>}
                    </td>
                    <td style={styles.td}>
                      <span style={{ ...styles.typeBadge, ...((s.type ?? 'mapping') === 'cutover' ? styles.typeCutover : styles.typeMapping) }}>
                        {(s.type ?? 'mapping') === 'cutover' ? 'Cutover' : 'Mapping'}
                      </span>
                    </td>
                    <td style={{ ...styles.td, fontSize: 11.5, color: 'var(--text-2)' }}>
                      {proj?.name ?? '—'}
                    </td>
                    <td style={styles.td}>
                      <span style={{ ...styles.statusBadge, ...statusTone(s.status) }}>{t(STATUS_KEY[s.status])}</span>
                    </td>
                    <td style={{ ...styles.td, fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-2)' }}>
                      <div>{s.createdBy}</div>
                      <div style={{ color: 'var(--text-3)', fontSize: 10.5 }}>{new Date(s.createdAt).toLocaleString()}</div>
                    </td>
                    <td style={{ ...styles.td, fontSize: 11, color: 'var(--text-2)' }}>
                      {s.status === 'approved' && s.approvedBy && s.approvedAt ? (
                        <span style={{ color: 'var(--green)', fontFamily: 'var(--mono)' }}>
                          {s.approvedBy} · {new Date(s.approvedAt).toLocaleString()}
                        </span>
                      ) : s.status === 'rejected' && s.rejectedBy && s.rejectedAt ? (
                        <div>
                          <div style={{ color: 'var(--red)', fontFamily: 'var(--mono)' }}>
                            {s.rejectedBy} · {new Date(s.rejectedAt).toLocaleString()}
                          </div>
                          {s.rejectionReason && (
                            <div style={styles.reasonNote}>{t('versions.reasonPrefix')}{s.rejectionReason}</div>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>—</span>
                      )}
                    </td>
                    <td style={styles.td}>
                      {s.status === 'pending' && (
                        isMaster ? (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button onClick={() => setApproveId(s.id)} style={styles.miniBtnApprove}>
                              {t('versions.approve')}
                            </button>
                            <button onClick={() => { setRejectId(s.id); setRejectReason(''); }} style={styles.miniBtnDanger}>
                              {t('versions.reject')}
                            </button>
                          </div>
                        ) : (
                          <span style={styles.coordOnlyTag} title={t('approvals.coordOnly')}>
                            {t('approvals.coordOnly')}
                          </span>
                        )
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const STATUS_KEY: Record<SnapshotStatus, TranslationKey> = {
  pending:  'versions.status.pending',
  approved: 'versions.status.approved',
  rejected: 'versions.status.rejected',
};

function statusTone(s: SnapshotStatus): React.CSSProperties {
  switch (s) {
    case 'pending':  return { background: 'var(--amber-50)', color: 'var(--amber)', borderColor: 'var(--amber)' };
    case 'approved': return { background: 'var(--green-50)', color: 'var(--green)', borderColor: 'var(--green)' };
    case 'rejected': return { background: 'var(--red-50)',   color: 'var(--red)',   borderColor: 'var(--red)' };
  }
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={styles.th}>{children}</th>;
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.filter}>
      <div style={styles.filterLabel}>{label}</div>
      {children}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  typeBadge: {
    display: 'inline-block', padding: '2px 7px', fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)',
    border: '1px solid', borderRadius: 3, textTransform: 'uppercase', letterSpacing: 0.3,
  },
  typeMapping: { background: 'var(--navy-50)', color: 'var(--navy)', borderColor: 'var(--navy)' },
  typeCutover: { background: 'var(--red-50)', color: 'var(--red)', borderColor: 'var(--red)' },
  header: { marginBottom: 14 },
  h1: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: -0.2 },
  subtitle: { margin: '4px 0 0', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },

  filterBar: {
    display: 'flex',
    gap: 10,
    alignItems: 'flex-end',
    padding: 12,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    marginBottom: 10,
  },
  filter: { display: 'flex', flexDirection: 'column', gap: 4 },
  filterLabel: {
    fontSize: 10,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontFamily: 'var(--mono)',
    fontWeight: 600,
  },
  select: {
    padding: '6px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12,
    outline: 'none',
    minWidth: 160,
  },

  tableWrap: { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 5, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: {
    padding: '7px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: 0.6, fontFamily: 'var(--mono)',
    background: 'var(--panel-2)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  },
  td: { padding: '8px 12px', verticalAlign: 'top' },
  nameMain: { fontWeight: 600, color: 'var(--text)', fontSize: 12.5 },
  nameDesc: { fontSize: 11, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.5 },
  statusBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    border: '1px solid',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  reasonNote: {
    fontSize: 10.5,
    color: 'var(--text-3)',
    marginTop: 3,
    fontFamily: 'var(--mono)',
    fontStyle: 'italic',
  },
  emptyRow: { padding: '32px 12px', textAlign: 'center', color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 12 },

  miniBtn: {
    padding: '3px 9px', fontSize: 11, border: '1px solid var(--border-strong)',
    background: 'var(--panel)', color: 'var(--text-2)', borderRadius: 3, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  miniBtnApprove: {
    padding: '3px 9px', fontSize: 11, border: '1px solid var(--green)',
    background: 'var(--panel)', color: 'var(--green)', borderRadius: 3, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600,
  },
  miniBtnDanger: {
    padding: '3px 9px', fontSize: 11, border: '1px solid var(--red)',
    background: 'var(--panel)', color: 'var(--red)', borderRadius: 3, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600,
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
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

  confirmCell: { padding: '10px 12px' },
  confirmBar: { display: 'flex', alignItems: 'center', gap: 8, width: '100%' },
  confirmText: { fontSize: 12, color: 'var(--text)', fontFamily: 'var(--sans)', whiteSpace: 'nowrap' },

  rejectBar: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%' },
  rejectLabel: { fontSize: 11.5, fontWeight: 600, color: 'var(--red)' },
  rejectInput: {
    width: '100%',
    padding: '7px 10px',
    border: '1px solid var(--red)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12.5,
    outline: 'none',
    resize: 'vertical',
    minHeight: 48,
    fontFamily: 'var(--mono)',
  },
  rejectActions: { display: 'flex', justifyContent: 'flex-end', gap: 6 },
};
